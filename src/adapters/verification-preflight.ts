import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import {
  normalizeVerificationCommandCwd,
  type VerificationCommandPolicy,
} from "../core/policy.ts";

export class VerificationPreflightError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "VerificationPreflightError";
    this.path = path;
  }
}

export async function preflightRequiredVerificationCommands(
  repositoryRoot: string,
  commands: Readonly<Record<string, VerificationCommandPolicy>>,
  options: {
    path?: string;
    configPath?: string;
  } = {},
): Promise<void> {
  const canonicalRoot = await realpath(repositoryRoot);
  const configPath = options.configPath ?? ".forge/config.json";
  for (const [name, command] of Object.entries(commands)) {
    if (!command.required) continue;
    const basePath = `${configPath} verification.commands.${name}`;
    let cwd: string;
    try {
      cwd = await resolveVerificationCommandDirectory(
        canonicalRoot,
        command.cwd,
        `${basePath}.cwd`,
      );
    } catch (error) {
      failPreflight(
        configPath,
        name,
        "cwd",
        errorDetail(error),
      );
    }
    const program = command.argv[0];
    if (!program)
      failPreflight(configPath, name, "argv", "must name an executable");
    if (!(await executableAvailable(program, cwd, options.path ?? process.env.PATH))) {
      failPreflight(
        configPath,
        name,
        "argv",
        `executable '${program}' is unavailable`,
      );
    }
    const script = packageScriptName(command.argv);
    if (script)
      await assertPackageScript(canonicalRoot, cwd, script, configPath, name);
  }
}

export async function resolveVerificationCommandDirectory(
  repositoryRoot: string,
  configuredCwd: unknown,
  path = "verification command cwd",
): Promise<string> {
  const normalized = normalizeVerificationCommandCwd(configuredCwd, path);
  const canonicalRoot = await realpath(repositoryRoot);
  const lexical = resolve(canonicalRoot, normalized);
  if (!pathWithin(canonicalRoot, lexical))
    throw new VerificationPreflightError(path, "escapes the repository");
  const firstSegment = relative(canonicalRoot, lexical).split(/[\\/]/, 1)[0];
  if (firstSegment === ".git" || firstSegment === ".pi")
    throw new VerificationPreflightError(
      path,
      "must not target Git or Forge runtime control directories",
    );
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch {
    throw new VerificationPreflightError(
      path,
      `directory '${normalized}' does not exist`,
    );
  }
  if (!pathWithin(canonicalRoot, canonical))
    throw new VerificationPreflightError(path, "resolves outside the repository");
  if (!(await stat(canonical)).isDirectory())
    throw new VerificationPreflightError(path, "must resolve to a directory");
  return canonical;
}

async function executableAvailable(
  program: string,
  cwd: string,
  pathValue: string | undefined,
): Promise<boolean> {
  const direct =
    isAbsolute(program) || program.includes("/") || program.includes("\\");
  const candidates = direct
    ? [isAbsolute(program) ? program : resolve(cwd, program)]
    : (pathValue ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((entry) => resolve(cwd, entry, program));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // Try the next tracked PATH entry.
    }
  }
  return false;
}

function packageScriptName(argv: readonly string[]): string | undefined {
  const manager = basename(argv[0] ?? "").replace(/\.(?:cmd|exe)$/i, "");
  if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) return undefined;
  const command = argv[1];
  if (command === "test" || command === "t") return "test";
  if (command === "run" || command === "run-script") {
    const script = argv.slice(2).find((argument) => !argument.startsWith("-"));
    return script || undefined;
  }
  return undefined;
}

function failPreflight(
  configPath: string,
  name: string,
  field: "argv" | "cwd",
  message: string,
): never {
  const basePath = `${configPath} verification.commands.${name}`;
  throw new VerificationPreflightError(
    `${basePath}.${field}`,
    `${message}. Update ${basePath}.${field} in the tracked policy, or run /forge:init and leave verification.commands empty for explicit GitHub-CI-only verification`,
  );
}

function errorDetail(error: unknown): string {
  if (error instanceof VerificationPreflightError) {
    const prefix = `${error.path}: `;
    return error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function assertPackageScript(
  repositoryRoot: string,
  cwd: string,
  script: string,
  configPath: string,
  name: string,
): Promise<void> {
  const manifestPath = join(cwd, "package.json");
  let canonicalManifest: string;
  try {
    canonicalManifest = await realpath(manifestPath);
  } catch {
    failPreflight(
      configPath,
      name,
      "cwd",
      `selected package directory has no package.json for script '${script}'`,
    );
  }
  if (!pathWithin(repositoryRoot, canonicalManifest))
    failPreflight(
      configPath,
      name,
      "cwd",
      "package.json resolves outside the repository",
    );
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(canonicalManifest, "utf8"));
  } catch {
    failPreflight(
      configPath,
      name,
      "cwd",
      "selected package.json is not valid JSON",
    );
  }
  const scripts =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as { scripts?: unknown }).scripts
      : undefined;
  const value =
    scripts && typeof scripts === "object" && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)[script]
      : undefined;
  if (typeof value !== "string" || !value.trim()) {
    failPreflight(
      configPath,
      name,
      "argv",
      `package.json in '${relative(repositoryRoot, cwd) || "."}' has no '${script}' script`,
    );
  }
}

function pathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
