import { constants, type Dirent } from "node:fs";
import {
  access,
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

import {
  isSafeWorkingDirectory,
  type ForgePolicy,
  type VerificationCommandPolicy,
} from "../core/policy.ts";

const DEFAULT_MAX_PACKAGE_DEPTH = 4;
const MAX_DISCOVERED_PACKAGES = 256;
const SKIPPED_DISCOVERY_DIRECTORIES = new Set([
  ".forge",
  ".git",
  ".pi",
  "build",
  "coverage",
  "dist",
  "docs",
  "examples",
  "node_modules",
  "out",
  "test",
  "tests",
  "vendor",
]);
const NPM_OPTIONS_WITH_VALUES = new Set([
  "--prefix",
  "--userconfig",
  "--workspace",
  "--workspaces",
]);

export interface VerificationPreflightOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface VerificationPreflightCheck {
  name: string;
  required: boolean;
  workingDirectory: string;
  status: "passed" | "skipped";
  details: string;
}

export interface VerificationPreflightReport {
  checks: readonly VerificationPreflightCheck[];
}

export interface VerificationPreflightFailure {
  name: string;
  field: string;
  message: string;
  remediation: string;
}

export interface PackageScriptCandidate {
  workingDirectory: string;
  packagePath: string;
}

export class VerificationPreflightError extends Error {
  readonly configPath: string;
  readonly failures: readonly VerificationPreflightFailure[];

  constructor(
    configPath: string,
    failures: readonly VerificationPreflightFailure[],
  ) {
    const details = failures
      .map(
        (failure) =>
          `- ${configPath}.verification.commands.${failure.name}.${failure.field}: ${failure.message} Remediation: ${failure.remediation}`,
      )
      .join("\n");
    super(
      `Required verification preflight failed for ${configPath}.\n${details}\nRun /forge:init to regenerate a runnable package-scoped policy, or correct the referenced verification command and retry.`,
    );
    this.name = "VerificationPreflightError";
    this.configPath = configPath;
    this.failures = failures;
  }
}

export async function preflightVerificationPolicy(
  repositoryRoot: string,
  policy: ForgePolicy,
  options: VerificationPreflightOptions = {},
): Promise<VerificationPreflightReport> {
  return preflightVerificationCommands(
    repositoryRoot,
    policy.verification.commands,
    options,
  );
}

export async function preflightVerificationCommands(
  repositoryRoot: string,
  commands: Readonly<Record<string, VerificationCommandPolicy>>,
  options: VerificationPreflightOptions = {},
): Promise<VerificationPreflightReport> {
  const configPath =
    options.configPath ?? join(repositoryRoot, ".forge", "config.json");
  const environment = options.env ?? process.env;
  let root: string;
  try {
    root = await realpath(repositoryRoot);
  } catch {
    throw new VerificationPreflightError(configPath, [
      {
        name: "__repository__",
        field: "root",
        message: `repository root ${repositoryRoot} does not exist or cannot be resolved`,
        remediation: `run /forge:init from a checked-out repository`,
      },
    ]);
  }

  const checks: VerificationPreflightCheck[] = [];
  const requiredFailures: VerificationPreflightFailure[] = [];
  for (const [name, command] of Object.entries(commands).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const workingDirectory =
      typeof command.workingDirectory === "string"
        ? command.workingDirectory
        : ".";
    const failure = await checkCommand(
      root,
      name,
      command,
      environment,
    );
    if (failure) {
      checks.push({
        name,
        required: command.required,
        workingDirectory,
        status: "skipped",
        details: failure.message,
      });
      if (command.required) requiredFailures.push(failure);
      continue;
    }
    checks.push({
      name,
      required: command.required,
      workingDirectory,
      status: "passed",
      details: "Executable, working directory, and required package metadata are available.",
    });
  }

  if (requiredFailures.length > 0)
    throw new VerificationPreflightError(configPath, requiredFailures);
  return { checks };
}

export async function discoverPackageScriptCandidates(
  repositoryRoot: string,
  scriptName = "test",
): Promise<readonly PackageScriptCandidate[]> {
  if (!scriptName.trim()) throw new TypeError("Package script name is required.");
  const root = await realpath(repositoryRoot);
  const rootManifest = await readPackageManifest(root);
  if (hasPackageScript(rootManifest, scriptName)) {
    return [{ workingDirectory: ".", packagePath: join(root, "package.json") }];
  }

  const candidates: PackageScriptCandidate[] = [];
  await discoverNestedPackageScripts(
    root,
    root,
    0,
    scriptName,
    candidates,
  );
  return candidates;
}

async function checkCommand(
  root: string,
  name: string,
  command: VerificationCommandPolicy,
  environment: NodeJS.ProcessEnv,
): Promise<VerificationPreflightFailure | undefined> {
  const configField = (field: string): string => field;
  const workingDirectory =
    typeof command.workingDirectory === "string"
      ? command.workingDirectory
      : ".";
  if (!isSafeWorkingDirectory(workingDirectory)) {
    return failure(
      name,
      configField("workingDirectory"),
      "must be a repository-relative directory without parent traversal",
      root,
      workingDirectory,
    );
  }

  const resolvedDirectory = resolve(root, workingDirectory);
  if (!isPathWithin(root, resolvedDirectory)) {
    return failure(
      name,
      configField("workingDirectory"),
      `resolves outside the repository: ${resolvedDirectory}`,
      root,
      workingDirectory,
    );
  }

  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(resolvedDirectory);
  } catch {
    return failure(
      name,
      configField("workingDirectory"),
      `directory does not exist: ${resolvedDirectory}`,
      root,
      workingDirectory,
    );
  }
  if (!isPathWithin(root, canonicalDirectory)) {
    return failure(
      name,
      configField("workingDirectory"),
      `directory resolves through a symlink outside the repository: ${canonicalDirectory}`,
      root,
      workingDirectory,
    );
  }
  try {
    if (!(await stat(canonicalDirectory)).isDirectory()) {
      return failure(
        name,
        configField("workingDirectory"),
        `path is not a directory: ${canonicalDirectory}`,
        root,
        workingDirectory,
      );
    }
  } catch {
    return failure(
      name,
      configField("workingDirectory"),
      `directory cannot be inspected: ${canonicalDirectory}`,
      root,
      workingDirectory,
    );
  }

  const program = command.argv[0];
  if (!program) {
    return failure(
      name,
      "argv",
      "must contain an executable",
      root,
      workingDirectory,
    );
  }
  if (!(await executableAvailable(program, canonicalDirectory, environment))) {
    return failure(
      name,
      "argv[0]",
      `executable '${program}' was not found or is not executable`,
      root,
      workingDirectory,
    );
  }

  const npmInvocation = parseNpmScriptInvocation(command.argv);
  if (npmInvocation?.error) {
    return failure(
      name,
      "argv",
      npmInvocation.error,
      root,
      workingDirectory,
    );
  }
  if (npmInvocation?.scriptName) {
    const manifest = await readPackageManifest(canonicalDirectory);
    if (!manifest) {
      return failure(
        name,
        "workingDirectory",
        `npm script '${npmInvocation.scriptName}' cannot be checked because ${join(canonicalDirectory, "package.json")} is missing or invalid`,
        root,
        workingDirectory,
      );
    }
    if (!hasPackageScript(manifest, npmInvocation.scriptName)) {
      return failure(
        name,
        "argv",
        `package ${join(canonicalDirectory, "package.json")} does not define scripts.${npmInvocation.scriptName}`,
        root,
        workingDirectory,
      );
    }
  }
  return undefined;
}

function failure(
  name: string,
  field: string,
  message: string,
  root: string,
  workingDirectory: string,
): VerificationPreflightFailure {
  const location = join(root, ".forge", "config.json");
  return {
    name,
    field,
    message,
    remediation: `run /forge:init or update ${location} at verification.commands.${name}.${field} (working directory '${workingDirectory}')`,
  };
}

async function executableAvailable(
  program: string,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const direct = isAbsolute(program) || program.includes("/") || program.includes("\\");
  if (direct) return canExecute(resolve(workingDirectory, program));

  const pathEntries = (environment.PATH ?? "").split(delimiter);
  const extensions =
    process.platform === "win32" && !program.includes(".")
      ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const entry of pathEntries) {
    const directory = entry || workingDirectory;
    for (const extension of extensions) {
      if (await canExecute(join(directory, `${program}${extension}`))) return true;
    }
  }
  return false;
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface NpmScriptInvocation {
  scriptName?: string;
  error?: string;
}

function parseNpmScriptInvocation(
  argv: readonly string[],
): NpmScriptInvocation | undefined {
  const executable = basename(argv[0] ?? "").toLowerCase();
  if (executable !== "npm" && executable !== "npm.cmd") return undefined;

  let index = 1;
  while (index < argv.length) {
    const argument = argv[index];
    if (!argument || argument === "--") return undefined;
    if (argument.startsWith("-")) {
      index += NPM_OPTIONS_WITH_VALUES.has(argument) ? 2 : 1;
      continue;
    }
    if (argument === "test" || argument === "t") return { scriptName: "test" };
    if (argument === "run" || argument === "run-script") {
      const scriptName = argv[index + 1];
      if (!scriptName || scriptName.startsWith("-")) {
        return { error: `${argument} requires an npm script name` };
      }
      return { scriptName };
    }
    return undefined;
  }
  return undefined;
}

interface PackageManifest {
  scripts?: Readonly<Record<string, unknown>>;
}

async function readPackageManifest(
  directory: string,
): Promise<PackageManifest | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const scripts = (value as Record<string, unknown>).scripts;
    return {
      ...(scripts && typeof scripts === "object" && !Array.isArray(scripts)
        ? { scripts: scripts as Record<string, unknown> }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function hasPackageScript(
  manifest: PackageManifest | undefined,
  scriptName: string,
): boolean {
  const value = manifest?.scripts?.[scriptName];
  return typeof value === "string" && value.trim().length > 0;
}

async function discoverNestedPackageScripts(
  root: string,
  directory: string,
  depth: number,
  scriptName: string,
  candidates: PackageScriptCandidate[],
): Promise<void> {
  if (
    depth >= DEFAULT_MAX_PACKAGE_DEPTH ||
    candidates.length >= MAX_DISCOVERED_PACKAGES
  )
    return;
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, {
      encoding: "utf8",
      withFileTypes: true,
    });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      SKIPPED_DISCOVERY_DIRECTORIES.has(entry.name)
    )
      continue;
    const child = join(directory, entry.name);
    const manifest = await readPackageManifest(child);
    if (hasPackageScript(manifest, scriptName)) {
      const directoryName = relative(root, child).split(sep).join("/");
      candidates.push({
        workingDirectory: directoryName || ".",
        packagePath: join(child, "package.json"),
      });
      if (candidates.length >= MAX_DISCOVERED_PACKAGES) return;
    }
    await discoverNestedPackageScripts(
      root,
      child,
      depth + 1,
      scriptName,
      candidates,
    );
    if (candidates.length >= MAX_DISCOVERED_PACKAGES) return;
  }
}

function isPathWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}
