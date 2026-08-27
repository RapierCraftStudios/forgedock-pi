import { constants } from "node:fs";
import {
  access,
  opendir,
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

export interface VerificationCommandCandidate {
  name: string;
  packagePath: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  script: string;
  argv: readonly string[];
}

interface DiscoveredPackageManifest {
  directory: string;
  packagePath: string;
  packageName?: string;
  scripts: Record<string, string>;
}

const MAX_DISCOVERED_MANIFESTS = 256;
const MAX_DISCOVERED_CANDIDATES = 512;
const MAX_DISCOVERY_DEPTH = 8;
const MAX_DISCOVERY_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_SCRIPTS_PER_MANIFEST = 256;
const EXCLUDED_DISCOVERY_DIRECTORIES = new Set([
  ".forge",
  ".git",
  ".pi",
  "node_modules",
]);
const PACKAGE_MANAGER_LOCKFILES: ReadonlyArray<{
  file: string;
  manager: VerificationCommandCandidate["packageManager"];
}> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "package-lock.json", manager: "npm" },
];

/**
 * Discover package scripts without invoking a package manager or repository
 * code. Symlinked directories are deliberately ignored; manifests reached
 * through a symlink are not stable enough to become tracked policy.
 */
export async function discoverVerificationCommandCandidates(
  repositoryRoot: string,
  options: { trackedManifestPaths?: ReadonlySet<string> } = {},
): Promise<VerificationCommandCandidate[]> {
  const canonicalRoot = await realpath(repositoryRoot);
  const manifests: DiscoveredPackageManifest[] = [];
  await collectPackageManifests(
    canonicalRoot,
    canonicalRoot,
    ".",
    0,
    { entries: 0 },
    manifests,
    options.trackedManifestPaths,
  );
  const candidates: VerificationCommandCandidate[] = [];
  const usedNames = new Set<string>();
  for (const manifest of manifests) {
    const packageManager = await packageManagerForDirectory(
      canonicalRoot,
      manifest.directory,
    );
    for (const script of Object.keys(manifest.scripts).sort(scriptOrder)) {
      const name = uniqueCandidateName(
        candidateName(manifest.packagePath, script),
        usedNames,
      );
      if (candidates.length >= MAX_DISCOVERED_CANDIDATES) return candidates;
      const argv =
        script === "test" && packageManager !== "bun"
          ? [packageManager, "test"]
          : [packageManager, "run", script];
      candidates.push({
        name,
        packagePath: manifest.packagePath,
        packageManager,
        script,
        argv,
      });
    }
  }
  return candidates;
}

async function collectPackageManifests(
  canonicalRoot: string,
  directory: string,
  packagePath: string,
  depth: number,
  budget: { entries: number },
  manifests: DiscoveredPackageManifest[],
  trackedManifestPaths?: ReadonlySet<string>,
): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH || manifests.length >= MAX_DISCOVERED_MANIFESTS)
    return;
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    return;
  }
  const entries = [];
  try {
    for await (const entry of handle) {
      budget.entries += 1;
      if (budget.entries > MAX_DISCOVERY_ENTRIES) return;
      entries.push(entry);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = join(directory, entry.name);
    if (entry.isFile() && entry.name === "package.json") {
      const relativeManifestPath = toRepositoryPath(
        relative(canonicalRoot, entryPath),
      );
      if (
        trackedManifestPaths &&
        !trackedManifestPaths.has(relativeManifestPath)
      )
        continue;
      const manifest = await readPackageManifest(canonicalRoot, entryPath);
      if (manifest) {
        manifests.push({ directory, packagePath, ...manifest });
        if (manifests.length >= MAX_DISCOVERED_MANIFESTS) return;
      }
      continue;
    }
    if (
      !entry.isDirectory() ||
      EXCLUDED_DISCOVERY_DIRECTORIES.has(entry.name.toLowerCase())
    )
      continue;
    const childPackagePath =
      packagePath === "." ? entry.name : `${packagePath}/${entry.name}`;
    await collectPackageManifests(
      canonicalRoot,
      entryPath,
      childPackagePath,
      depth + 1,
      budget,
      manifests,
      trackedManifestPaths,
    );
    if (manifests.length >= MAX_DISCOVERED_MANIFESTS) return;
  }
}

async function readPackageManifest(
  canonicalRoot: string,
  manifestPath: string,
): Promise<
  Omit<DiscoveredPackageManifest, "directory" | "packagePath"> | undefined
> {
  let canonicalManifest: string;
  try {
    canonicalManifest = await realpath(manifestPath);
  } catch {
    return undefined;
  }
  if (!pathWithin(canonicalRoot, canonicalManifest)) return undefined;
  try {
    if ((await stat(canonicalManifest)).size > MAX_MANIFEST_BYTES)
      return undefined;
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(canonicalManifest, "utf8"));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const manifest = value as { name?: unknown; scripts?: unknown };
  const scriptsValue = manifest.scripts;
  const scripts =
    !scriptsValue ||
    typeof scriptsValue !== "object" ||
    Array.isArray(scriptsValue)
      ? {}
      : scriptsValue;
  const scriptNames = Object.keys(scripts);
  if (scriptNames.length > MAX_SCRIPTS_PER_MANIFEST) return undefined;
  const safeScripts = Object.fromEntries(
    scriptNames
      .map((name) => [name, (scripts as Record<string, unknown>)[name]])
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" &&
          isSafeManifestText(entry[0]) &&
          typeof entry[1] === "string" &&
          entry[1].trim().length > 0 &&
          isSafeManifestText(entry[1]),
      ),
  );
  const packageName =
    typeof manifest.name === "string" &&
    manifest.name.trim().length > 0 &&
    isSafeManifestText(manifest.name)
      ? manifest.name
      : undefined;
  return {
    scripts: safeScripts,
    ...(packageName === undefined ? {} : { packageName }),
  };
}

async function packageManagerForDirectory(
  canonicalRoot: string,
  directory: string,
): Promise<VerificationCommandCandidate["packageManager"]> {
  let cursor = directory;
  while (pathWithin(canonicalRoot, cursor)) {
    for (const lockfile of PACKAGE_MANAGER_LOCKFILES) {
      try {
        const lockPath = await realpath(join(cursor, lockfile.file));
        if (pathWithin(canonicalRoot, lockPath)) return lockfile.manager;
      } catch {
        // Try the next lockfile or parent directory.
      }
    }
    if (cursor === canonicalRoot) break;
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    cursor = parent;
  }
  return "npm";
}

function scriptOrder(left: string, right: string): number {
  const priority = (script: string): number =>
    script === "test"
      ? 0
      : script === "check"
        ? 1
        : script === "typecheck"
          ? 2
          : script === "lint"
            ? 3
            : 4;
  return priority(left) - priority(right) || left.localeCompare(right);
}

function candidateName(packagePath: string, script: string): string {
  const prefix = packagePath === "." ? "" : `${packagePath}-`;
  const normalized = `${prefix}${script}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = normalized || "verification";
  return (/^[a-z]/.test(safe) ? safe : `verification-${safe}`).slice(0, 64);
}

function uniqueCandidateName(name: string, usedNames: Set<string>): string {
  let candidate = name;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${name.slice(0, 64 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
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
    if (command.argv.some((argument) => argument.includes("\0")))
      throw new VerificationPreflightError(
        `${basePath}.argv`,
        "must not contain NUL bytes",
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
    const invocation = packageScriptInvocation(
      command.argv,
      `${basePath}.argv`,
    );
    const commandCwd =
      invocation.cwdArgument === undefined
        ? cwd
        : await resolvePackageManagerDirectory(
            canonicalRoot,
            cwd,
            invocation.cwdArgument,
            `${basePath}.argv`,
          );
    const packageCwds = invocation.packageSelectors.length
      ? await resolvePackageSelectorDirectories(
          canonicalRoot,
          commandCwd,
          invocation.packageSelectors,
          `${basePath}.argv`,
        )
      : [commandCwd];
    if (invocation.script)
      for (const packageCwd of packageCwds)
        await assertPackageScript(
          canonicalRoot,
          packageCwd,
          invocation.script,
          basePath,
        );
  }
}

export async function resolveVerificationCommandDirectory(
  repositoryRoot: string,
  configuredCwd: unknown,
  path = "verification command cwd",
): Promise<string> {
  const normalized = normalizeVerificationCommandCwd(configuredCwd, path);
  const canonicalRoot = await realpath(repositoryRoot);
  return resolveExistingVerificationDirectory(
    canonicalRoot,
    resolve(canonicalRoot, normalized),
    normalized,
    path,
  );
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
    for (const executable of executableNames(candidate)) {
      try {
        await access(executable, constants.X_OK);
        if ((await stat(executable)).isFile()) return true;
      } catch {
        // Try the next tracked PATH entry or Windows shim suffix.
      }
    }
  }
  return false;
}

function executableNames(candidate: string): string[] {
  if (process.platform !== "win32") return [candidate];
  if (basename(candidate).includes(".")) return [candidate];
  const suffixes = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  return [candidate, ...suffixes.map((suffix) => `${candidate}${suffix}`)];
}

interface PackageScriptInvocation {
  script?: string;
  cwdArgument?: string;
  packageSelectors: string[];
}

function packageScriptInvocation(
  argv: readonly string[],
  path: string,
): PackageScriptInvocation {
  const manager = basename(argv[0] ?? "").replace(/\.(?:cmd|exe)$/i, "");
  if (!["npm", "pnpm", "yarn", "bun"].includes(manager))
    return { packageSelectors: [] };
  const { commandIndex, cwdArgument, packageSelectors } = packageManagerCommand(
    manager,
    argv,
    path,
  );
  const command = commandIndex === undefined ? undefined : argv[commandIndex];
  if (manager === "yarn" && command === "workspace") {
    const selector = argv[commandIndex! + 1];
    const script = argv[commandIndex! + 2];
    if (!selector || !script || selector.startsWith("-") || script.startsWith("-"))
      throw new VerificationPreflightError(
        path,
        "yarn workspace must name a package and script; use a direct executable otherwise",
      );
    return {
      script,
      cwdArgument,
      packageSelectors: [...packageSelectors, selector],
    };
  }
  // `bun test` is Bun's built-in test runner, unlike npm/pnpm/yarn test,
  // which dispatch a package.json script. `bun run test` remains script-bound.
  if (manager === "bun" && command === "test")
    return { cwdArgument, packageSelectors };
  if (command === "test")
    return { script: "test", cwdArgument, packageSelectors };
  if (command === "run" || command === "run-script") {
    const script = argv
      .slice(commandIndex! + 1)
      .find((argument) => !argument.startsWith("-"));
    if (!script)
      throw new VerificationPreflightError(
        path,
        `${manager} ${command} must name a package script; configure a script name or use a direct executable`,
      );
    return { script, cwdArgument, packageSelectors };
  }
  return { cwdArgument, packageSelectors };
}

function packageManagerCommand(
  manager: string,
  argv: readonly string[],
  path: string,
): {
  commandIndex?: number;
  cwdArgument?: string;
  packageSelectors: string[];
} {
  const optionsWithValues =
    manager === "npm"
      ? new Set(["--prefix", "--userconfig", "--workspace", "-w"])
      : manager === "pnpm"
        ? new Set(["--dir", "--filter", "-C"])
        : new Set(["--cwd"]);
  const selectorOptions =
    manager === "npm"
      ? new Set(["--workspace", "-w"])
      : manager === "pnpm"
        ? new Set(["--filter"])
        : new Set<string>();
  const directoryOptions =
    manager === "npm"
      ? new Set(["--prefix"])
      : manager === "pnpm"
        ? new Set(["--dir", "-C"])
        : new Set(["--cwd"]);
  let commandIndex: number | undefined;
  let cwdArgument: string | undefined;
  const packageSelectors: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") return { cwdArgument, packageSelectors };
    if (!argument?.startsWith("-")) {
      if (commandIndex === undefined) commandIndex = index;
      continue;
    }
    const option = argument.split("=", 1)[0] ?? argument;
    const inlineValue =
      argument.length > option.length && argument[option.length] === "="
        ? argument.slice(option.length + 1)
        : undefined;
    if (directoryOptions.has(option) || selectorOptions.has(option)) {
      const value = inlineValue ?? argv[index + 1];
      if (!value || value.startsWith("-"))
        throw new VerificationPreflightError(
          path,
          `${manager} ${option} must name a package selector or directory`,
        );
      if (directoryOptions.has(option)) cwdArgument = value;
      else packageSelectors.push(value);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (optionsWithValues.has(option) && inlineValue === undefined) index += 1;
  }
  return { commandIndex, cwdArgument, packageSelectors };
}

async function resolvePackageManagerDirectory(
  repositoryRoot: string,
  commandCwd: string,
  configuredPath: string,
  path: string,
): Promise<string> {
  if (!configuredPath || configuredPath.includes("\0"))
    throw new VerificationPreflightError(
      path,
      "package directory must be a non-empty path without NUL bytes",
    );
  const lexical = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(commandCwd, configuredPath);
  return resolveExistingVerificationDirectory(
    repositoryRoot,
    lexical,
    configuredPath,
    path,
  );
}

async function resolvePackageSelectorDirectories(
  repositoryRoot: string,
  commandCwd: string,
  selectors: readonly string[],
  path: string,
): Promise<string[]> {
  const manifests: DiscoveredPackageManifest[] = [];
  await collectPackageManifests(
    repositoryRoot,
    repositoryRoot,
    ".",
    0,
    { entries: 0 },
    manifests,
  );
  const directories: string[] = [];
  for (const selector of selectors) {
    if (!selector || selector.includes("\0") || selector.includes("*"))
      throw new VerificationPreflightError(
        path,
        `package selector '${selector}' must be an exact package path or name; use cwd for a workspace glob`,
      );
    if (selector.includes("..."))
      throw new VerificationPreflightError(
        path,
        `package selector '${selector}' is a dependency graph selector; use cwd for an exact package`,
      );
    const lexical = isAbsolute(selector)
      ? resolve(selector)
      : resolve(commandCwd, selector);
    if (pathWithin(repositoryRoot, lexical)) {
      try {
        const canonical = await resolveExistingVerificationDirectory(
          repositoryRoot,
          lexical,
          selector,
          path,
        );
        directories.push(canonical);
        continue;
      } catch (error) {
        if (
          error instanceof VerificationPreflightError &&
          !/does not exist/.test(error.message)
        )
          throw error;
      }
    } else if (isAbsolute(selector)) {
      throw new VerificationPreflightError(path, "escapes the repository");
    }
    const matches = manifests.filter(
      (manifest) =>
        manifest.packagePath === selector || manifest.packageName === selector,
    );
    if (matches.length !== 1) {
      throw new VerificationPreflightError(
        path,
        `package selector '${selector}' does not identify exactly one package; set cwd to the package directory`,
      );
    }
    directories.push(
      await resolveExistingVerificationDirectory(
        repositoryRoot,
        matches[0]!.directory,
        matches[0]!.packagePath,
        path,
      ),
    );
  }
  return directories;
}

async function resolveExistingVerificationDirectory(
  repositoryRoot: string,
  lexical: string,
  displayPath: string,
  path: string,
): Promise<string> {
  if (!pathWithin(repositoryRoot, lexical))
    throw new VerificationPreflightError(path, "escapes the repository");
  assertAllowedVerificationDirectory(repositoryRoot, lexical, path);
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch {
    throw new VerificationPreflightError(
      path,
      `directory '${displayPath}' does not exist`,
    );
  }
  if (!pathWithin(repositoryRoot, canonical))
    throw new VerificationPreflightError(path, "resolves outside the repository");
  assertAllowedVerificationDirectory(repositoryRoot, canonical, path);
  if (!(await stat(canonical)).isDirectory())
    throw new VerificationPreflightError(path, "must resolve to a directory");
  return canonical;
}

function assertAllowedVerificationDirectory(
  repositoryRoot: string,
  target: string,
  path: string,
): void {
  const firstSegment = relative(repositoryRoot, target)
    .split(/[\\/]/, 1)[0]
    ?.toLowerCase();
  if (firstSegment === ".git" || firstSegment === ".pi" || firstSegment === ".forge")
    throw new VerificationPreflightError(
      path,
      "must not target Git or Forge runtime control directories",
    );
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
      `selected package directory has no package.json for script '${script}'`,
    );
  }
  if (!pathWithin(repositoryRoot, canonicalManifest))
    throw new VerificationPreflightError(
      `${basePath}.cwd`,
      "package.json resolves outside the repository",
    );
  const manifest = await readPackageManifest(repositoryRoot, canonicalManifest);
  if (!manifest)
    throw new VerificationPreflightError(
      `${basePath}.cwd`,
      "selected package.json is missing, too large, or not valid JSON",
    );
  const value = manifest.scripts[script];
  if (typeof value !== "string" || !value.trim()) {
    throw new VerificationPreflightError(
      `${basePath}.argv`,
      `package.json in '${relative(repositoryRoot, cwd) || "."}' has no '${script}' script; set cwd to the package that defines it or use CI-only verification`,
    );
  }
}

function isSafeManifestText(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function toRepositoryPath(value: string): string {
  return value.split(sep).join("/") || ".";
}

function pathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
