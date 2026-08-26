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

export interface PackageManifestInfo {
  cwd: string;
  name?: string;
  scripts: Readonly<Record<string, string>>;
}

export interface InitVerificationSelection {
  commands: Readonly<Record<string, VerificationCommandPolicy>>;
  mode: "local" | "ci-only";
  reason: string;
  candidates: readonly PackageManifestInfo[];
}

const PACKAGE_SCAN_MAX_DEPTH = 4;
const PACKAGE_SCAN_MAX_DEPTH_OVERRIDE = 16;
const PACKAGE_SCAN_MAX_MANIFESTS = 256;
const PACKAGE_SCAN_MAX_MANIFESTS_OVERRIDE = 1_024;
const PACKAGE_MANIFEST_MAX_BYTES = 256 * 1024;
const CONTROL_DIRECTORIES = new Set([".forge", ".git", ".pi"]);
const PACKAGE_SCAN_IGNORES = new Set([
  ...CONTROL_DIRECTORIES,
  "node_modules",
  ".cache",
  ".next",
  ".nuxt",
  "build",
  "coverage",
  "dist",
  "out",
  "target",
]);

/**
 * Read package manifests without invoking a package manager or repository
 * script. The result is intentionally bounded because init runs before a
 * writer and must remain a metadata-only operation.
 */
export async function discoverPackageManifests(
  repositoryRoot: string,
  options: {
    maxDepth?: number;
    maxManifests?: number;
  } = {},
): Promise<PackageManifestInfo[]> {
  const root = await realpath(repositoryRoot);
  const maxDepth = options.maxDepth ?? PACKAGE_SCAN_MAX_DEPTH;
  const maxManifests = options.maxManifests ?? PACKAGE_SCAN_MAX_MANIFESTS;
  if (
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > PACKAGE_SCAN_MAX_DEPTH_OVERRIDE
  )
    throw new TypeError(
      `Package scan maxDepth must be from 0 through ${PACKAGE_SCAN_MAX_DEPTH_OVERRIDE}.`,
    );
  if (
    !Number.isSafeInteger(maxManifests) ||
    maxManifests < 1 ||
    maxManifests > PACKAGE_SCAN_MAX_MANIFESTS_OVERRIDE
  )
    throw new TypeError(
      `Package scan maxManifests must be from 1 through ${PACKAGE_SCAN_MAX_MANIFESTS_OVERRIDE}.`,
    );

  const manifests: PackageManifestInfo[] = [];
  const seen = new Set<string>();
  const visitManifest = async (manifestPath: string): Promise<void> => {
    if (manifests.length >= maxManifests) return;
    const manifest = await readPackageManifest(root, manifestPath);
    if (!manifest || seen.has(manifest.cwd)) return;
    seen.add(manifest.cwd);
    manifests.push(manifest);
  };

  await visitManifest(join(root, "package.json"));

  const visitDirectory = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth || manifests.length >= maxManifests) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (manifests.length >= maxManifests) return;
      if (entry.name === "package.json" && entry.isFile()) {
        await visitManifest(join(directory, entry.name));
        continue;
      }
      if (
        !entry.isDirectory() ||
        isIgnoredPackageScanDirectory(entry.name) ||
        entry.name.startsWith(".")
      )
        continue;
      await visitDirectory(join(directory, entry.name), depth + 1);
    }
  };

  await visitDirectory(root, 0);
  return manifests.sort((left, right) => left.cwd.localeCompare(right.cwd));
}

/**
 * Choose init's local verification policy without executing any discovered
 * script. A single package that declares test is unambiguous; all other
 * cases deliberately use the explicit CI-only representation.
 */
export function selectInitVerificationCommands(
  existing: Readonly<Record<string, VerificationCommandPolicy>>,
  manifests: readonly PackageManifestInfo[],
): InitVerificationSelection {
  const candidates = manifests.filter((manifest) => hasPackageScript(manifest, "test"));
  const existingEntries = Object.entries(existing);
  const invalid = existingEntries.find(([name, command]) => {
    if (!command.required) return false;
    const script = verificationScriptName(command.argv);
    return script !== undefined && !hasMatchingPackageScript(manifests, command.cwd, script);
  });

  if (invalid) {
    const [name, command] = invalid;
    const script = verificationScriptName(command.argv) ?? "the requested script";
    return {
      commands: {},
      mode: "ci-only",
      reason: `.forge/config.json verification.commands.${name}.argv selects '${script}' from package cwd '${command.cwd}', but that package does not define it; set cwd to the package that defines '${script}' or use CI-only verification`,
      candidates,
    };
  }

  if (existingEntries.length > 0) {
    return {
      commands: { ...existing },
      mode: "local",
      reason: "Preserved the existing tracked verification commands after static package-script inspection.",
      candidates,
    };
  }

  if (candidates.length === 1) {
    const candidate = candidates[0] as PackageManifestInfo;
    return {
      commands: {
        test: {
          argv: ["npm", "test"],
          cwd: candidate.cwd,
          required: true,
          timeoutMs: 600_000,
        },
      },
      mode: "local",
      reason: `Configured npm test from the only package declaring scripts.test (cwd '${candidate.cwd}').`,
      candidates,
    };
  }

  const candidateText = candidates.length
    ? candidates.map((candidate) => `'${candidate.cwd}'`).join(", ")
    : "none";
  return {
    commands: {},
    mode: "ci-only",
    reason:
      candidates.length > 1
        ? `Multiple packages declare scripts.test (${candidateText}); local verification is CI-only until a package cwd is selected explicitly.`
        : "No package declares a non-empty scripts.test; local verification is CI-only until an approved command is configured.",
    candidates,
  };
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
        "must name an executable",
      );
    if (!(await executableAvailable(program, cwd, options.path ?? process.env.PATH))) {
      throw new VerificationPreflightError(
        `${basePath}.argv`,
        `executable '${program}' is unavailable; install it or update the tracked command`,
      );
    }
    const script = verificationScriptName(command.argv);
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
    throw new VerificationPreflightError(path, "escapes the repository");
  const segments = relative(canonicalRoot, lexical)
    .split(/[\\/]/)
    .filter(Boolean);
  if (segments.some(isControlDirectorySegment))
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

export function verificationScriptName(argv: readonly string[]): string | undefined {
  const manager = basename(argv[0] ?? "").replace(/\.(?:cmd|exe)$/i, "");
  if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) return undefined;
  let index = 1;
  while (index < argv.length && argv[index]?.startsWith("-")) {
    const argument = argv[index] as string;
    if (
      argument === "--prefix" ||
      argument === "-C" ||
      argument === "--workspace" ||
      argument === "-w"
    ) {
      index += 2;
    } else {
      index += 1;
    }
  }
  const command = argv[index];
  if (command === "test") return "test";
  if (command === "run" || command === "run-script") {
    const script = argv
      .slice(index + 1)
      .find((argument) => !argument.startsWith("-"));
    return script || undefined;
  }
  return undefined;
}

function isControlDirectorySegment(segment: string): boolean {
  return CONTROL_DIRECTORIES.has(segment.toLocaleLowerCase("en-US"));
}

function isIgnoredPackageScanDirectory(name: string): boolean {
  return (
    PACKAGE_SCAN_IGNORES.has(name) ||
    PACKAGE_SCAN_IGNORES.has(name.toLocaleLowerCase("en-US"))
  );
}

function hasPackageScript(
  manifest: PackageManifestInfo,
  script: string,
): boolean {
  const value = manifest.scripts[script];
  return typeof value === "string" && value.trim().length > 0;
}

function hasMatchingPackageScript(
  manifests: readonly PackageManifestInfo[],
  cwd: string,
  script: string,
): boolean {
  return manifests.some(
    (manifest) => manifest.cwd === cwd && hasPackageScript(manifest, script),
  );
}

async function readPackageManifest(
  repositoryRoot: string,
  manifestPath: string,
): Promise<PackageManifestInfo | undefined> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(manifestPath);
    const metadata = await stat(canonicalPath);
    if (
      !metadata.isFile() ||
      metadata.size > PACKAGE_MANIFEST_MAX_BYTES
    )
      return undefined;
  } catch {
    return undefined;
  }
  if (!pathWithin(repositoryRoot, canonicalPath)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(canonicalPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const scriptsValue = root.scripts;
  const scripts: Record<string, string> = {};
  if (
    scriptsValue &&
    typeof scriptsValue === "object" &&
    !Array.isArray(scriptsValue)
  ) {
    for (const [name, script] of Object.entries(
      scriptsValue as Record<string, unknown>,
    )) {
      if (typeof script === "string" && script.trim()) scripts[name] = script;
    }
  }
  const directory = relative(repositoryRoot, resolve(canonicalPath, ".."));
  const cwd = directory.replaceAll("\\", "/") || ".";
  if (cwd.split("/").some(isControlDirectorySegment))
    return undefined;
  const packageName = root.name;
  return {
    cwd,
    ...(typeof packageName === "string" && packageName.trim()
      ? { name: packageName.trim() }
      : {}),
    scripts,
  };
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
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(canonicalManifest, "utf8"));
  } catch {
    throw new VerificationPreflightError(
      `${basePath}.cwd`,
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
    throw new VerificationPreflightError(
      `${basePath}.argv`,
      `package.json in '${relative(repositoryRoot, cwd) || "."}' has no '${script}' script; set cwd to the package that defines it or use CI-only verification`,
    );
  }
}

function pathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
