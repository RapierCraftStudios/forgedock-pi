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
  type VerificationMode,
} from "../core/policy.ts";

export interface VerificationPreflightResult {
  mode: VerificationMode;
  commands: Readonly<Record<string, VerificationCommandPolicy>>;
  reason?: string;
}

type PackageScriptResult = "valid" | "ci-only";

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
): Promise<VerificationPreflightResult> {
  const canonicalRoot = await realpath(repositoryRoot);
  const configPath = options.configPath ?? ".forge/config.json";
  let mode: VerificationMode =
    Object.keys(commands).length === 0 ? "ci-only" : "local";
  let reason: string | undefined;
  for (const [name, command] of Object.entries(commands)) {
    if (!command.required) continue;
    const basePath = `${configPath} verification.commands.${name}`;
    const cwd = await resolveVerificationCommandDirectory(
      canonicalRoot,
      command.cwd,
      `${basePath}.cwd`,
    );
    const program = command.argv[0];
    if (!program)
      throw new VerificationPreflightError(
        `${basePath}.argv`,
        "must name an executable",
      );
    if (!(await executableAvailable(program, cwd, options.path ?? process.env.PATH))) {
      throw new VerificationPreflightError(
        `${basePath}.argv`,
        `executable '${program}' is unavailable; install it or update the tracked command`,
      );
    }
    const script = packageScriptName(command.argv);
    if (!script) continue;
    const packageResult = await assertPackageScript(
      canonicalRoot,
      cwd,
      script,
      basePath,
    );
    if (packageResult === "ci-only") {
      mode = "ci-only";
      reason ??= `Required root ${script} script metadata is malformed; local verification is disabled and GitHub CI is authoritative.`;
    }
  }
  return {
    mode,
    commands: mode === "ci-only" ? {} : commands,
    ...(reason ? { reason } : {}),
  };
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
  if (command === "test") return "test";
  if (command === "run" || command === "run-script") {
    const script = argv.slice(2).find((argument) => !argument.startsWith("-"));
    return script || undefined;
  }
  return undefined;
}

async function assertPackageScript(
  repositoryRoot: string,
  cwd: string,
  script: string,
  basePath: string,
): Promise<PackageScriptResult> {
  const manifestPath = join(cwd, "package.json");
  let canonicalManifest: string;
  try {
    canonicalManifest = await realpath(manifestPath);
  } catch {
    throw new VerificationPreflightError(
      `${basePath}.cwd`,
      `selected package directory has no package.json for script '${script}'`,
    );
  }
  if (!pathWithin(repositoryRoot, canonicalManifest))
    throw new VerificationPreflightError(
      `${basePath}.cwd`,
      "package.json resolves outside the repository",
    );
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(canonicalManifest, "utf8"));
  } catch {
    throw new VerificationPreflightError(
      `${basePath}.cwd`,
      "selected package.json is not valid JSON",
    );
  }
  const rootTestScript = script === "test" && relative(repositoryRoot, cwd) === "";
  const manifestObject =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)
      : undefined;
  const scripts = manifestObject?.scripts;
  if (!Object.prototype.hasOwnProperty.call(manifestObject ?? {}, "scripts")) {
    throw missingPackageScript(repositoryRoot, cwd, script, basePath);
  }
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    if (rootTestScript) return "ci-only";
    throw missingPackageScript(repositoryRoot, cwd, script, basePath);
  }
  const scriptRecord = scripts as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(scriptRecord, script)) {
    throw missingPackageScript(repositoryRoot, cwd, script, basePath);
  }
  const value = scriptRecord[script];
  if (typeof value !== "string" || !value.trim()) {
    if (rootTestScript) return "ci-only";
    throw missingPackageScript(repositoryRoot, cwd, script, basePath);
  }
  return "valid";
}

function missingPackageScript(
  repositoryRoot: string,
  cwd: string,
  script: string,
  basePath: string,
): VerificationPreflightError {
  return new VerificationPreflightError(
    `${basePath}.argv`,
    `package.json in '${relative(repositoryRoot, cwd) || "."}' has no '${script}' script; set cwd to the package that defines it or use CI-only verification`,
  );
}

function pathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
