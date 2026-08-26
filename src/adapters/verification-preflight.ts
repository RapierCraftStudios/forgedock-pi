import { constants } from "node:fs";
import {
  access,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import {
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from "node:path";

import type { VerificationCommandPolicy } from "../core/policy.ts";

const DEFAULT_CONFIG_PATH = ".forge/config.json";
const DEFAULT_MAX_DISCOVERY_DIRECTORIES = 2_048;
const NPM_TEST_TIMEOUT_MS = 600_000;
const IGNORED_DISCOVERY_DIRECTORIES = new Set([
  ".forge",
  ".git",
  ".next",
  ".pi",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

export interface VerificationPreflightOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export class VerificationPreflightError extends Error {
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    super(`Verification preflight failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
    this.name = "VerificationPreflightError";
    this.failures = [...failures];
  }
}

class CommandPreflightFailure extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "CommandPreflightFailure";
    this.path = path;
  }
}

/**
 * Validate required local checks using filesystem metadata only.
 * No executable, npm lifecycle, or package script is invoked here.
 */
export async function preflightVerificationCommands(
  repositoryRoot: string,
  commands: Readonly<Record<string, VerificationCommandPolicy>>,
  options: VerificationPreflightOptions = {},
): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const requiredCommands = Object.entries(commands).filter(
    ([, command]) => command.required,
  );
  if (requiredCommands.length === 0) return;
  const env = options.env ?? process.env;
  let root: string;
  try {
    root = await realpath(repositoryRoot);
  } catch {
    throw new VerificationPreflightError([
      `${configPath}: repository root does not exist or cannot be resolved. ${remediation(configPath)}`,
    ]);
  }

  const failures: string[] = [];
  for (const [name, command] of requiredCommands) {
    const commandPath = `${configPath}.verification.commands.${name}`;
    try {
      await preflightCommand(root, commandPath, command, env);
    } catch (error) {
      if (error instanceof CommandPreflightFailure) {
        failures.push(
          `${error.path}: ${error.message}. ${remediation(configPath, name)}`,
        );
      } else {
        failures.push(
          `${commandPath}: ${error instanceof Error ? error.message : String(error)}. ${remediation(configPath, name)}`,
        );
      }
    }
  }

  if (failures.length > 0) throw new VerificationPreflightError(failures);
}

/**
 * Find a safe default package for `npm test` without running package code.
 * The repository root wins when it has a test script; otherwise exactly one
 * nested package must expose `scripts.test`.
 */
export async function discoverNpmTestPackage(
  repositoryRoot: string,
): Promise<string | undefined> {
  const root = await realpath(repositoryRoot);
  if (await hasNpmTestScript(root, root)) return ".";

  const candidates: string[] = [];
  let inspectedDirectories = 0;
  let incomplete = false;

  const scan = async (directory: string): Promise<void> => {
    if (candidates.length > 1 || incomplete) return;
    inspectedDirectories += 1;
    if (inspectedDirectories > DEFAULT_MAX_DISCOVERY_DIRECTORIES) {
      incomplete = true;
      return;
    }

    let entries;
    try {
      entries = (await readdir(directory, { withFileTypes: true })).sort(
        (left, right) => left.name.localeCompare(right.name),
      );
    } catch {
      incomplete = true;
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DISCOVERY_DIRECTORIES.has(entry.name))
        continue;
      const child = join(directory, entry.name);
      if (await hasNpmTestScript(root, child)) {
        candidates.push(toRepositoryPath(root, child));
        if (candidates.length > 1) return;
      }
      await scan(child);
      if (candidates.length > 1 || incomplete) return;
    }
  };

  await scan(root);
  return !incomplete && candidates.length === 1 ? candidates[0] : undefined;
}

async function preflightCommand(
  root: string,
  commandPath: string,
  command: VerificationCommandPolicy,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const [program, ...args] = command.argv;
  if (!program)
    throw new CommandPreflightFailure(
      `${commandPath}.argv`,
      "argv must contain an executable",
    );

  const workingDirectory = await resolveWorkingDirectory(
    root,
    commandPath,
    command.workingDirectory ?? ".",
  );
  if (!(await findExecutable(program, workingDirectory, env))) {
    throw new CommandPreflightFailure(
      `${commandPath}.argv[0]`,
      `executable '${program}' is not available on PATH or at its configured path`,
    );
  }

  const scriptName = npmScriptName(program, args, `${commandPath}.argv`);
  if (scriptName !== undefined)
    await assertNpmScript(root, workingDirectory, commandPath, scriptName);
}

async function resolveWorkingDirectory(
  root: string,
  commandPath: string,
  value: unknown,
): Promise<string> {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    throw new CommandPreflightFailure(
      `${commandPath}.workingDirectory`,
      "must be a repository-relative path without absolute or '..' segments",
    );
  }

  const target = resolve(root, value);
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch {
    throw new CommandPreflightFailure(
      `${commandPath}.workingDirectory`,
      `directory '${value}' does not exist`,
    );
  }
  if (!isPathWithin(root, canonical)) {
    throw new CommandPreflightFailure(
      `${commandPath}.workingDirectory`,
      `directory '${value}' resolves outside the repository`,
    );
  }
  try {
    if (!(await stat(canonical)).isDirectory()) {
      throw new CommandPreflightFailure(
        `${commandPath}.workingDirectory`,
        `path '${value}' is not a directory`,
      );
    }
  } catch (error) {
    if (error instanceof CommandPreflightFailure) throw error;
    throw new CommandPreflightFailure(
      `${commandPath}.workingDirectory`,
      `directory '${value}' cannot be inspected`,
    );
  }
  return canonical;
}

async function findExecutable(
  program: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const pathLike =
    program.includes("/") ||
    program.includes("\\") ||
    isAbsolute(program) ||
    win32.isAbsolute(program);
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  const paths = pathLike
    ? [isAbsolute(program) || win32.isAbsolute(program) ? program : resolve(cwd, program)]
    : (env.PATH ?? "")
        .split(delimiter)
        .map((entry) => resolve(cwd, entry || "."))
        .flatMap((directory) => extensions.map((extension) => join(directory, `${program}${extension}`)));

  for (const candidate of paths) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function npmScriptName(
  program: string,
  args: readonly string[],
  argvPath: string,
): string | undefined {
  const executable = program.replaceAll("\\", "/").split("/").at(-1) ?? "";
  if (!/^npm(?:\.cmd)?$/i.test(executable)) return undefined;
  if (args[0] === "test") return "test";
  if (args[0] === "run" || args[0] === "run-script") {
    const script = args[1];
    if (!script || script.startsWith("-")) {
      throw new CommandPreflightFailure(
        argvPath,
        "npm run must name a script",
      );
    }
    return script;
  }
  return undefined;
}

async function assertNpmScript(
  root: string,
  workingDirectory: string,
  commandPath: string,
  scriptName: string,
): Promise<void> {
  const manifestPath = join(workingDirectory, "package.json");
  let canonicalManifest: string;
  try {
    canonicalManifest = await realpath(manifestPath);
  } catch {
    throw new CommandPreflightFailure(
      `${commandPath}.workingDirectory`,
      "package.json is missing",
    );
  }
  if (!isPathWithin(root, canonicalManifest)) {
    throw new CommandPreflightFailure(
      `${commandPath}.workingDirectory`,
      "package.json resolves outside the repository",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(canonicalManifest, "utf8"));
  } catch {
    throw new CommandPreflightFailure(
      `${commandPath}.workingDirectory`,
      "package.json is missing or invalid JSON",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CommandPreflightFailure(
      `${commandPath}.workingDirectory`,
      "package.json must contain an object",
    );
  }
  const scripts = (parsed as Record<string, unknown>).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new CommandPreflightFailure(
      `${commandPath}.argv`,
      `npm script '${scriptName}' is not defined`,
    );
  }
  const script = (scripts as Record<string, unknown>)[scriptName];
  if (typeof script !== "string" || !script.trim()) {
    throw new CommandPreflightFailure(
      `${commandPath}.argv`,
      `npm script '${scriptName}' is not defined`,
    );
  }
}

async function hasNpmTestScript(root: string, directory: string): Promise<boolean> {
  const manifestPath = join(directory, "package.json");
  let canonicalManifest: string;
  try {
    canonicalManifest = await realpath(manifestPath);
    if (!isPathWithin(root, canonicalManifest)) return false;
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(canonicalManifest, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return false;
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
      return false;
    const testScript = (scripts as Record<string, unknown>).test;
    return typeof testScript === "string" && testScript.trim().length > 0;
  } catch {
    return false;
  }
}

function toRepositoryPath(root: string, directory: string): string {
  const value = relative(root, directory).replaceAll("\\", "/");
  return value || ".";
}

function isPathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function remediation(configPath: string, commandName?: string): string {
  const path = commandName
    ? `${configPath}.verification.commands.${commandName}`
    : `${configPath}.verification.commands`;
  return `run /forge:init or update ${path} to an existing package and approved executable; remove the local entry only to opt into explicit GitHub-CI-only verification`;
}

export const DEFAULT_NPM_TEST_COMMAND = {
  argv: ["npm", "test"] as const,
  required: true,
  timeoutMs: NPM_TEST_TIMEOUT_MS,
  workingDirectory: ".",
} as const;
