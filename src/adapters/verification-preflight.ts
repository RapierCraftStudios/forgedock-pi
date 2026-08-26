import { constants } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
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

export interface PackageScriptManifest {
  readonly cwd: string;
  readonly scripts: Readonly<Record<string, string>>;
}

export type InitVerificationSelectionMode =
  | "configured"
  | "discovered"
  | "ci-only";

export interface InitVerificationSelection {
  readonly commands: Readonly<Record<string, VerificationCommandPolicy>>;
  readonly mode: InitVerificationSelectionMode;
  readonly reason?: string;
}

const MAX_PACKAGE_SCAN_DEPTH = 8;
const MAX_PACKAGE_DIRECTORIES = 4_096;
const MAX_PACKAGE_MANIFESTS = 256;
const MAX_PACKAGE_MANIFEST_BYTES = 1_048_576;
const SKIPPED_PACKAGE_DIRECTORIES = new Set([
  ".forge",
  ".git",
  ".pi",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

/**
 * Discover package scripts using only package.json reads. This is deliberately
 * bounded and refuses symlink directories so /forge:init never executes or
 * follows an untrusted package tree outside the repository.
 */
export async function discoverPackageScripts(
  repositoryRoot: string,
): Promise<PackageScriptManifest[]> {
  const canonicalRoot = await realpath(repositoryRoot);
  const manifests: PackageScriptManifest[] = [];
  const visited = new Set<string>();

  async function visit(directory: string, depth: number): Promise<void> {
    if (
      visited.size >= MAX_PACKAGE_DIRECTORIES ||
      manifests.length >= MAX_PACKAGE_MANIFESTS
    )
      return;
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(directory);
    } catch {
      return;
    }
    if (
      !pathWithin(canonicalRoot, canonicalDirectory) ||
      visited.has(canonicalDirectory)
    )
      return;
    visited.add(canonicalDirectory);

    const scripts = await readPackageScripts(canonicalRoot, canonicalDirectory);
    if (scripts)
      manifests.push({
        cwd: portableRelative(canonicalRoot, canonicalDirectory),
        scripts,
      });
    if (depth >= MAX_PACKAGE_SCAN_DEPTH) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(canonicalDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        SKIPPED_PACKAGE_DIRECTORIES.has(entry.name) ||
        entry.name.startsWith(".")
      )
        continue;
      await visit(join(canonicalDirectory, entry.name), depth + 1);
      if (manifests.length >= MAX_PACKAGE_MANIFESTS) return;
    }
  }

  await visit(canonicalRoot, 0);
  return manifests.sort((left, right) => left.cwd.localeCompare(right.cwd));
}

/**
 * Select local verification for /forge:init without running package scripts.
 * Existing required commands are retained when statically valid. An invalid
 * command is rebound only when exactly one package exposes its requested
 * script; otherwise the caller must explicitly choose CI-only verification.
 */
export async function selectInitVerificationCommands(
  repositoryRoot: string,
  configured: Readonly<Record<string, VerificationCommandPolicy>>,
  options: { path?: string; configPath?: string } = {},
): Promise<InitVerificationSelection> {
  const canonicalRoot = await realpath(repositoryRoot);
  const configPath = options.configPath ?? ".forge/config.json";
  const manifests = await discoverPackageScripts(canonicalRoot);
  const configuredEntries = Object.entries(configured);

  if (configuredEntries.length > 0) {
    const selected: Record<string, VerificationCommandPolicy> = {
      ...configured,
    };
    let discovered = false;
    for (const [name, command] of configuredEntries) {
      if (!command.required) continue;
      try {
        await preflightRequiredVerificationCommands(
          canonicalRoot,
          { [name]: command },
          { path: options.path, configPath },
        );
        continue;
      } catch (error) {
        const script = packageScriptName(command.argv) ?? name;
        const candidate = uniqueScriptCandidate(manifests, script);
        if (!candidate) {
          return {
            commands: {},
            mode: "ci-only",
            reason: preflightFailureReason(error, configPath),
          };
        }
        const replacement = { ...command, cwd: candidate.cwd };
        try {
          await preflightRequiredVerificationCommands(
            canonicalRoot,
            { [name]: replacement },
            { path: options.path, configPath },
          );
        } catch (replacementError) {
          return {
            commands: {},
            mode: "ci-only",
            reason: preflightFailureReason(replacementError, configPath),
          };
        }
        selected[name] = replacement;
        discovered = true;
      }
    }
    return {
      commands: selected,
      mode: discovered ? "discovered" : "configured",
    };
  }

  const candidate = defaultScriptCandidate(manifests);
  if (!candidate) {
    return {
      commands: {},
      mode: "ci-only",
      reason: `No unambiguous package 'check' or 'test' script was found; configure ${configPath} verification.commands or use commands: {} for CI-only verification.`,
    };
  }
  const script = candidate.scripts.check ? "check" : "test";
  const command: VerificationCommandPolicy = {
    argv: script === "test" ? ["npm", "test"] : ["npm", "run", script],
    cwd: candidate.cwd,
    required: true,
    timeoutMs: 600_000,
  };
  try {
    await preflightRequiredVerificationCommands(
      canonicalRoot,
      { [script]: command },
      { path: options.path, configPath },
    );
  } catch (error) {
    return {
      commands: {},
      mode: "ci-only",
      reason: preflightFailureReason(error, configPath),
    };
  }
  return { commands: { [script]: command }, mode: "discovered" };
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
    const cwd = await resolveVerificationCommandDirectory(
      canonicalRoot,
      command.cwd,
      `${basePath}.cwd`,
    );
    const program = command.argv[0];
    if (!program)
      throw new VerificationPreflightError(
        `${basePath}.argv`,
        `must name an executable; run /forge:init or update ${basePath}.argv (or use verification.commands: {} for CI-only verification)`,
      );
    if (!(await executableAvailable(program, cwd, options.path ?? process.env.PATH))) {
      throw new VerificationPreflightError(
        `${basePath}.argv`,
        `executable '${program}' is unavailable; install it or update ${basePath}.argv through /forge:init (or use verification.commands: {} for CI-only verification)`,
      );
    }
    const script = packageScriptName(command.argv);
    if (script)
      await assertPackageScript(canonicalRoot, cwd, script, basePath);
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
    throw new VerificationPreflightError(
      path,
      "escapes the repository; set this cwd to a safe package directory through /forge:init or update the tracked policy (or use verification.commands: {} for CI-only verification)",
    );
  const firstSegment = relative(canonicalRoot, lexical).split(/[\\/]/, 1)[0];
  if (firstSegment === ".git" || firstSegment === ".pi")
    throw new VerificationPreflightError(
      path,
      "must not target Git or Forge runtime control directories; set this cwd to a package directory through /forge:init or update the tracked policy (or use verification.commands: {} for CI-only verification)",
    );
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch {
    throw new VerificationPreflightError(
      path,
      `directory '${normalized}' does not exist; set this cwd to an existing package directory through /forge:init or update the tracked policy (or use verification.commands: {} for CI-only verification)`,
    );
  }
  if (!pathWithin(canonicalRoot, canonical))
    throw new VerificationPreflightError(
      path,
      "resolves outside the repository; set this cwd to a safe package directory through /forge:init or update the tracked policy (or use verification.commands: {} for CI-only verification)",
    );
  if (!(await stat(canonical)).isDirectory())
    throw new VerificationPreflightError(
      path,
      "must resolve to a directory; set this cwd to an existing package directory through /forge:init or update the tracked policy (or use verification.commands: {} for CI-only verification)",
    );
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

async function readPackageScripts(
  repositoryRoot: string,
  directory: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  const manifestPath = join(directory, "package.json");
  let canonicalManifest: string;
  try {
    canonicalManifest = await realpath(manifestPath);
  } catch {
    return undefined;
  }
  if (!pathWithin(repositoryRoot, canonicalManifest)) return undefined;
  let metadata;
  try {
    metadata = await stat(canonicalManifest);
  } catch {
    return undefined;
  }
  if (!metadata.isFile() || metadata.size > MAX_PACKAGE_MANIFEST_BYTES)
    return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(canonicalManifest, "utf8"));
  } catch {
    return undefined;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return undefined;
  const source = (manifest as { scripts?: unknown }).scripts;
  if (!source || typeof source !== "object" || Array.isArray(source))
    return undefined;
  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim()) scripts[name] = value;
  }
  return Object.keys(scripts).length > 0 ? scripts : undefined;
}

function uniqueScriptCandidate(
  manifests: readonly PackageScriptManifest[],
  script: string,
): PackageScriptManifest | undefined {
  const matches = manifests.filter((manifest) =>
    Object.prototype.hasOwnProperty.call(manifest.scripts, script),
  );
  const root = matches.find((manifest) => manifest.cwd === ".");
  if (root) return root;
  const paths = new Set(matches.map((manifest) => manifest.cwd));
  return paths.size === 1 ? matches[0] : undefined;
}

function defaultScriptCandidate(
  manifests: readonly PackageScriptManifest[],
): PackageScriptManifest | undefined {
  for (const script of ["check", "test"]) {
    const candidate = uniqueScriptCandidate(manifests, script);
    if (candidate) return candidate;
  }
  return undefined;
}

function portableRelative(root: string, target: string): string {
  return relative(root, target).split(/[\\/]/).filter(Boolean).join("/") || ".";
}

function preflightFailureReason(error: unknown, configPath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${message}; fix the tracked policy at ${configPath} or run /forge:init and choose GitHub-CI-only verification`;
}

async function assertPackageScript(
  repositoryRoot: string,
  cwd: string,
  script: string,
  basePath: string,
): Promise<void> {
  const manifestPath = join(cwd, "package.json");
  let canonicalManifest: string;
  try {
    canonicalManifest = await realpath(manifestPath);
  } catch {
    throw new VerificationPreflightError(
      `${basePath}.cwd`,
      `selected package directory has no package.json for script '${script}'; set cwd to the package that defines it through /forge:init or update ${basePath}.cwd (or use verification.commands: {} for CI-only verification)`,
    );
  }
  if (!pathWithin(repositoryRoot, canonicalManifest))
    throw new VerificationPreflightError(
      `${basePath}.cwd`,
      "package.json resolves outside the repository; set cwd to a safe package directory through /forge:init or update the tracked policy (or use verification.commands: {} for CI-only verification)",
    );
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(canonicalManifest, "utf8"));
  } catch {
    throw new VerificationPreflightError(
      `${basePath}.cwd`,
      "selected package.json is not valid JSON; fix the package manifest or run /forge:init and choose CI-only verification",
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
    throw new VerificationPreflightError(
      `${basePath}.argv`,
      `package.json in '${relative(repositoryRoot, cwd) || "."}' has no '${script}' script; set ${basePath}.cwd to the package that defines it through /forge:init or update the tracked command (or use verification.commands: {} for CI-only verification)`,
    );
  }
}

function pathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
