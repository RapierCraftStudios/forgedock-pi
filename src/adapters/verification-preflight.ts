import { constants } from "node:fs";
import {
  access,
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { VerificationCommandPolicy } from "../core/policy.ts";

const SKIPPED_PACKAGE_DIRECTORIES = new Set([
  ".forge",
  ".git",
  ".pi",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export interface VerificationPreflightOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export class VerificationPreflightError extends Error {
  readonly configPath: string;
  readonly failures: readonly string[];

  constructor(configPath: string, failures: readonly string[]) {
    const remediation = [
      "Run /forge:init to regenerate repository-aware verification settings,",
      `or update ${configPath} so each required command names an existing`,
      "working directory and package script; use an empty verification.commands map when GitHub CI is intentionally parent-owned.",
    ].join(" ");
    super(
      [
        `Required verification preflight failed for ${configPath}:`,
        ...failures.map((failure) => `- ${failure}`),
        remediation,
      ].join("\n"),
    );
    this.name = "VerificationPreflightError";
    this.configPath = configPath;
    this.failures = [...failures];
  }
}

export async function preflightRequiredVerificationCommands(
  repositoryRoot: string,
  commands: Readonly<Record<string, VerificationCommandPolicy>>,
  options: VerificationPreflightOptions = {},
): Promise<void> {
  const configPath =
    options.configPath ?? join(repositoryRoot, ".forge", "config.json");
  let root: string;
  try {
    root = await realpath(repositoryRoot);
  } catch (error) {
    throw new VerificationPreflightError(configPath, [
      `repository root ${repositoryRoot} is unavailable: ${errorMessage(error)}`,
    ]);
  }

  const env = options.env ?? process.env;
  const failures: string[] = [];
  const required = Object.entries(commands)
    .filter(([, command]) => command.required)
    .sort(([left], [right]) => left.localeCompare(right));

  for (const [name, command] of required) {
    const commandPath = `verification.commands.${name}`;
    const rawCwd = command.cwd || ".";
    let cwd = root;
    try {
      cwd = await resolveVerificationCommandDirectory(root, rawCwd);
    } catch (error) {
      failures.push(`${commandPath}.cwd: ${errorMessage(error)}`);
    }

    const [program] = command.argv;
    if (!program || !(await executableExists(program, cwd, env))) {
      failures.push(
        `${commandPath}.argv[0]: executable '${program ?? ""}' was not found or is not runnable`,
      );
    }

    const script = npmScriptName(command.argv);
    if (!script) continue;
    const manifestPath = join(cwd, "package.json");
    const manifest = await readPackageManifest(manifestPath);
    if (manifest.kind === "missing") {
      failures.push(
        `${commandPath}: ${manifestPath} is missing; npm script '${script}' cannot be verified`,
      );
      continue;
    }
    if (manifest.kind === "invalid") {
      failures.push(
        `${commandPath}: ${manifestPath} is not valid JSON; npm script '${script}' cannot be verified`,
      );
      continue;
    }
    if (!definesScript(manifest.value, script)) {
      failures.push(
        `${commandPath}: ${manifestPath} does not define npm script '${script}'`,
      );
    }
  }

  if (failures.length > 0) throw new VerificationPreflightError(configPath, failures);
}

export async function resolveVerificationCommandDirectory(
  repositoryRoot: string,
  cwd: string,
): Promise<string> {
  if (typeof cwd !== "string" || !cwd.trim())
    throw new Error("working directory must be a non-empty repository-relative path");
  if (
    cwd.includes("\0") ||
    cwd.includes("\\") ||
    isAbsolute(cwd) ||
    /^[A-Za-z]:[\\/]/.test(cwd)
  ) {
    throw new Error("working directory must be a repository-relative path");
  }

  const root = await realpath(repositoryRoot);
  const lexical = resolve(root, cwd);
  if (!isPathWithin(root, lexical))
    throw new Error("working directory resolves outside the repository");

  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch {
    throw new Error(`working directory '${cwd}' does not exist`);
  }
  if (!isPathWithin(root, canonical))
    throw new Error("working directory resolves outside the repository");
  const metadata = await lstat(canonical).catch(() => undefined);
  if (!metadata?.isDirectory())
    throw new Error(`working directory '${cwd}' is not a directory`);
  return canonical;
}

export async function findPackageWithScript(
  repositoryRoot: string,
  scriptName: string,
): Promise<string | undefined> {
  if (!scriptName.trim()) return undefined;
  const root = await realpath(repositoryRoot);
  if (await packageDefinesScript(root, scriptName)) return ".";

  const candidates: string[] = [];
  await collectPackageDirectories(root, scriptName, candidates);
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (!candidate) return undefined;
  const path = relative(root, candidate);
  return path ? path.split(sep).join("/") : ".";
}

export const discoverPackageWithScript = findPackageWithScript;

async function collectPackageDirectories(
  directory: string,
  scriptName: string,
  candidates: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory() || SKIPPED_PACKAGE_DIRECTORIES.has(entry.name))
      continue;
    if (entry.name.startsWith(".")) continue;
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (await packageDefinesScript(child, scriptName)) candidates.push(child);
    await collectPackageDirectories(child, scriptName, candidates);
  }
}

async function packageDefinesScript(
  directory: string,
  scriptName: string,
): Promise<boolean> {
  const manifest = await readPackageManifest(join(directory, "package.json"));
  return manifest.kind === "valid" && definesScript(manifest.value, scriptName);
}

async function readPackageManifest(
  path: string,
): Promise<
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; value: unknown }
> {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile())
    return { kind: "missing" };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { kind: "missing" };
  }
  try {
    return { kind: "valid", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

function definesScript(value: unknown, scriptName: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scripts = (value as Record<string, unknown>).scripts;
  return Boolean(
    scripts &&
      typeof scripts === "object" &&
      !Array.isArray(scripts) &&
      Object.prototype.hasOwnProperty.call(scripts, scriptName) &&
      typeof (scripts as Record<string, unknown>)[scriptName] === "string",
  );
}

function npmScriptName(argv: readonly string[]): string | undefined {
  const program = argv[0];
  if (!program || commandName(program) !== "npm") return undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument || argument === "--") return undefined;
    if (argument === "test") return "test";
    if (argument === "run" || argument === "run-script") {
      const script = argv[index + 1];
      return script && !script.startsWith("-") ? script : undefined;
    }
    if (argument.startsWith("-")) continue;
    return undefined;
  }
  return undefined;
}

async function executableExists(
  program: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const candidates = isExecutablePath(program)
    ? [isAbsolute(program) ? program : resolve(cwd, program)]
    : executablePathCandidates(program, env, cwd);
  for (const candidate of candidates) {
    if (await isRunnableFile(candidate)) return true;
  }
  return false;
}

function executablePathCandidates(
  program: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string[] {
  const pathEntries = (env.PATH ?? "").split(delimiter);
  const candidates: string[] = [];
  for (const entry of pathEntries) {
    const directory = entry || cwd;
    candidates.push(join(directory, program));
    if (process.platform === "win32") {
      for (const extension of (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)) {
        candidates.push(join(directory, `${program}${extension}`));
      }
    }
  }
  return candidates;
}

async function isRunnableFile(path: string): Promise<boolean> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile()) return false;
  return access(path, constants.X_OK)
    .then(() => true)
    .catch(() => process.platform === "win32");
}

function isExecutablePath(program: string): boolean {
  return program.includes("/") || program.includes("\\") || isAbsolute(program);
}

function commandName(program: string): string {
  return basename(program.replaceAll("\\", "/"))
    .replace(/\.(cmd|exe|bat)$/i, "")
    .toLowerCase();
}

function isPathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
