import { constants } from "node:fs";
import {
  access,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import {
  basename,
  delimiter,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import type { VerificationCommandPolicy } from "../core/policy.ts";

export interface VerificationPreflightOptions {
  repositoryRoot: string;
  configPath: string;
  commands: Readonly<Record<string, VerificationCommandPolicy>>;
  path?: string;
}

/**
 * Validate required local verification commands without executing repository code.
 *
 * The command policy is trusted configuration, but package manifests and directory
 * layout are repository data. Preflight only reads those inputs and checks the
 * configured executable; the command itself remains deferred to forge_verify.
 */
export async function preflightVerificationCommands(
  options: VerificationPreflightOptions,
): Promise<void> {
  const repositoryRoot = await canonicalRepositoryRoot(
    options.repositoryRoot,
    options.configPath,
  );

  for (const [name, command] of Object.entries(options.commands)) {
    if (!command.required) continue;

    const basePath = `verification.commands.${name}`;
    const cwd = await resolveVerificationCommandDirectory(
      repositoryRoot,
      command.cwd,
      `${options.configPath}:${basePath}.cwd`,
    );
    const [program] = command.argv;
    if (!program) {
      throw preflightError(
        options.configPath,
        `${basePath}.argv`,
        "must contain an executable",
      );
    }
    if (
      !(await executableAvailable(
        program,
        cwd,
        options.path ?? process.env.PATH,
      ))
    ) {
      throw preflightError(
        options.configPath,
        `${basePath}.argv`,
        `executable '${program}' was not found; run /forge:init after installing it or update the approved argv/configuration`,
      );
    }

    const script = npmScriptName(command.argv);
    if (script)
      await assertPackageScript(
        repositoryRoot,
        cwd,
        script,
        basePath,
        options.configPath,
      );
  }
}

export async function resolveVerificationCommandDirectory(
  repositoryRoot: string,
  cwd: string,
  path = "verification command cwd",
): Promise<string> {
  if (!cwd || isAbsolute(cwd) || cwd.includes("\\") || cwd.includes("\0")) {
    throw preflightError(
      repositoryRoot,
      path,
      "must be a repository-relative POSIX path; run /forge:init or update the command cwd",
    );
  }
  if (cwd.split("/").includes("..")) {
    throw preflightError(
      repositoryRoot,
      path,
      "must not contain parent traversal; run /forge:init or update the command cwd",
    );
  }

  const canonicalRoot = await canonicalRepositoryRoot(repositoryRoot, path);
  const candidate = resolve(canonicalRoot, cwd);
  if (!isPathWithin(canonicalRoot, candidate)) {
    throw preflightError(
      repositoryRoot,
      path,
      "must remain inside the repository; run /forge:init or update the command cwd",
    );
  }

  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(candidate);
  } catch {
    throw preflightError(
      repositoryRoot,
      path,
      `directory '${cwd}' does not exist; set cwd to an existing package directory or use CI-only verification`,
    );
  }
  if (!isPathWithin(canonicalRoot, canonicalCwd)) {
    throw preflightError(
      repositoryRoot,
      path,
      `directory '${cwd}' resolves outside the repository; set cwd to an in-repository package directory or use CI-only verification`,
    );
  }

  try {
    if (!(await stat(canonicalCwd)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw preflightError(
      repositoryRoot,
      path,
      `path '${cwd}' is not a directory; set cwd to an existing package directory or use CI-only verification`,
    );
  }
  return canonicalCwd;
}

export async function executableAvailable(
  program: string,
  cwd: string,
  pathValue = process.env.PATH,
): Promise<boolean> {
  const candidates: string[] = [];
  if (isAbsolute(program) || program.includes("/") || program.includes("\\")) {
    candidates.push(isAbsolute(program) ? program : resolve(cwd, program));
  } else {
    for (const entry of (pathValue ?? "").split(delimiter)) {
      candidates.push(resolve(entry || cwd, program));
    }
  }

  for (const candidate of candidates) {
    const names =
      process.platform === "win32" && !/\.[A-Za-z0-9]+$/.test(candidate)
        ? [candidate, `${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`]
        : [candidate];
    for (const name of names) {
      try {
        await access(name, constants.X_OK);
        return true;
      } catch {
        // Continue searching PATH candidates.
      }
    }
  }
  return false;
}

export async function assertPackageScript(
  repositoryRoot: string,
  cwd: string,
  script: string,
  basePath: string,
  configPath = ".forge/config.json",
): Promise<void> {
  const manifestPath = resolve(cwd, "package.json");
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch {
    throw preflightError(
      configPath,
      `${basePath}.cwd`,
      `package.json is missing in '${relative(repositoryRoot, cwd) || "."}'; set cwd to the package that defines it or use CI-only verification`,
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw preflightError(
      configPath,
      `${basePath}.cwd`,
      `package.json in '${relative(repositoryRoot, cwd) || "."}' is not valid JSON; fix the package manifest or use CI-only verification`,
    );
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw preflightError(
      configPath,
      `${basePath}.cwd`,
      `package.json in '${relative(repositoryRoot, cwd) || "."}' must be an object; fix the package manifest or use CI-only verification`,
    );
  }
  const scripts = (manifest as Record<string, unknown>).scripts;
  const scriptValue =
    scripts && typeof scripts === "object" && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)[script]
      : undefined;
  if (typeof scriptValue !== "string" || !scriptValue.trim()) {
    throw preflightError(
      configPath,
      `${basePath}.cwd`,
      `package.json in '${relative(repositoryRoot, cwd) || "."}' has no '${script}' script; set cwd to the package that defines it or use CI-only verification`,
    );
  }
}

function npmScriptName(argv: readonly string[]): string | undefined {
  const program = basename(argv[0] ?? "").replace(/\.(cmd|exe)$/i, "").toLowerCase();
  if (program !== "npm") return undefined;
  if (argv[1] === "test") return "test";
  if (argv[1] === "run" || argv[1] === "run-script") return argv[2];
  return undefined;
}

async function canonicalRepositoryRoot(
  repositoryRoot: string,
  path: string,
): Promise<string> {
  try {
    return await realpath(repositoryRoot);
  } catch {
    throw preflightError(
      repositoryRoot,
      path,
      "repository root does not exist; run /forge:init from the repository root",
    );
  }
}

function isPathWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function preflightError(
  configPath: string,
  field: string,
  message: string,
): Error {
  return new Error(
    `Verification preflight failed at ${configPath} (${field}): ${message}.`,
  );
}
