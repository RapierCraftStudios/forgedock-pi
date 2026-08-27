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
    assertNoPackageLocationOptions(command.argv, `${basePath}.argv`);
    if (!(await executableAvailable(program, cwd, options.path ?? process.env.PATH))) {
      throw new VerificationPreflightError(
        `${basePath}.argv`,
        `executable '${program}' is unavailable; install it or update the tracked command`,
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

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

interface PackageManagerInvocation {
  manager: PackageManager;
  argvOffset: number;
}

interface PackageManagerCommand {
  name: string;
  index: number;
}

const PACKAGE_LOCATION_OPTIONS: Readonly<
  Record<PackageManager, ReadonlySet<string>>
> = {
  npm: new Set([
    "--prefix",
    "-C",
    "--workspace",
    "-w",
    "--workspaces",
    "--ws",
    "--include-workspace-root",
    "--location",
    "--global",
    "-g",
    "--userconfig",
    "--globalconfig",
  ]),
  pnpm: new Set([
    "--dir",
    "-C",
    "--filter",
    "--filter-prod",
    "-F",
    "--workspace-root",
    "-w",
    "--global",
    "-g",
    "-r",
    "--recursive",
  ]),
  yarn: new Set(["--cwd", "--top-level", "-T"]),
  bun: new Set(["--cwd", "--filter", "--global", "-g"]),
};

const PACKAGE_MANAGER_OPTIONS_WITH_VALUES: Readonly<
  Record<PackageManager, ReadonlySet<string>>
> = {
  npm: new Set([
    "--cache",
    "--registry",
    "--user-agent",
    "--otp",
    "--script-shell",
    "--loglevel",
    "--heading",
    "--fetch-retries",
    "--fetch-retry-factor",
    "--fetch-retry-mintimeout",
    "--fetch-retry-maxtimeout",
    "--tag",
    "--before",
  ]),
  pnpm: new Set(["--lockfile-dir", "--config-dir"]),
  yarn: new Set([
    "--cache-folder",
    "--modules-folder",
    "--mutex",
    "--network-timeout",
    "--registry",
  ]),
  bun: new Set([]),
};

function packageManagerName(value: string): PackageManager | undefined {
  const name = basename(value)
    .replace(/\.(?:cmd|exe)$/i, "")
    .toLowerCase();
  if (name === "yarnpkg") return "yarn";
  return Object.hasOwn(PACKAGE_LOCATION_OPTIONS, name)
    ? (name as PackageManager)
    : undefined;
}

function packageManagerInvocation(
  argv: readonly string[],
): PackageManagerInvocation | undefined {
  const direct = packageManagerName(argv[0] ?? "");
  if (direct) return { manager: direct, argvOffset: 1 };
  const launcher = basename(argv[0] ?? "")
    .replace(/\.(?:cmd|exe)$/i, "")
    .toLowerCase();
  if (launcher !== "corepack") return undefined;
  const wrapped = packageManagerName(argv[1] ?? "");
  return wrapped ? { manager: wrapped, argvOffset: 2 } : undefined;
}

function optionName(argument: string): string {
  const equals = argument.indexOf("=");
  return equals > 0 ? argument.slice(0, equals) : argument;
}

function optionTakesValue(
  manager: PackageManager,
  argument: string,
): boolean {
  const option = optionName(argument);
  return (
    PACKAGE_LOCATION_OPTIONS[manager].has(option) ||
    PACKAGE_MANAGER_OPTIONS_WITH_VALUES[manager].has(option)
  );
}

function packageManagerCommand(
  manager: PackageManager,
  args: readonly string[],
): PackageManagerCommand | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined || argument === "--") return undefined;
    if (!argument.startsWith("-")) return { name: argument, index };
    if (optionTakesValue(manager, argument) && !argument.includes("="))
      index += 1;
  }
  return undefined;
}

function packageLocationError(path: string, argument: string): never {
  throw new VerificationPreflightError(
    path,
    `must not use package-location option '${argument}'; package selection is bound to the configured cwd`,
  );
}

function isPackageLocationOption(
  manager: PackageManager,
  argument: string,
): boolean {
  const option = optionName(argument);
  if (PACKAGE_LOCATION_OPTIONS[manager].has(option)) return true;
  // npm and pnpm accept a compact -C<directory> spelling as well.
  if (
    (manager === "npm" || manager === "pnpm") &&
    argument.startsWith("-C") &&
    argument.length > 2
  )
    return true;
  // pnpm accepts compact recursive/filter short-option spellings.
  if (
    manager === "pnpm" &&
    ((argument.startsWith("-r") && argument.length > 2) ||
      (argument.startsWith("-F") && argument.length > 2))
  )
    return true;
  return false;
}

function nestedPackageManagerCommand(
  manager: PackageManager,
  command: string | undefined,
): boolean {
  if (!command) return false;
  if (manager === "npm") return command === "exec" || command === "x";
  if (manager === "pnpm") return command === "exec" || command === "dlx";
  if (manager === "yarn") return command === "exec";
  return command === "x" || command === "exec";
}

/**
 * Keep package-manager verification anchored to the command's bound cwd.
 *
 * Package managers accept location and workspace selectors in argv in addition
 * to the process cwd. Those selectors would make static package-script
 * preflight and the eventual child process observe different packages.
 */
export function assertNoPackageLocationOptions(
  argv: readonly string[],
  path = "verification command argv",
): void {
  const invocation = packageManagerInvocation(argv);
  if (!invocation) return;
  const args = argv.slice(invocation.argvOffset);
  const command = packageManagerCommand(invocation.manager, args);
  if (
    (invocation.manager === "yarn" &&
      (command?.name === "workspace" || command?.name === "workspaces")) ||
    (invocation.manager === "pnpm" && command?.name === "recursive")
  )
    packageLocationError(path, command?.name ?? "workspace");

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) break;
    if (argument === "--") {
      if (nestedPackageManagerCommand(invocation.manager, command?.name))
        assertNoPackageLocationOptions(args.slice(index + 1), path);
      break;
    }
    if (isPackageLocationOption(invocation.manager, argument))
      packageLocationError(path, argument);
  }
}

function packageScriptName(argv: readonly string[]): string | undefined {
  const invocation = packageManagerInvocation(argv);
  if (!invocation) return undefined;
  const args = argv.slice(invocation.argvOffset);
  const command = packageManagerCommand(invocation.manager, args);
  if (!command) return undefined;
  if (command.name === "test") return "test";
  if (command.name === "run" || command.name === "run-script") {
    for (
      let index = command.index + 1;
      index < args.length;
      index += 1
    ) {
      const argument = args[index];
      if (argument === undefined || argument === "--") break;
      if (argument.startsWith("-")) {
        if (
          optionTakesValue(invocation.manager, argument) &&
          !argument.includes("=")
        )
          index += 1;
        continue;
      }
      return argument;
    }
  }
  return undefined;
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
