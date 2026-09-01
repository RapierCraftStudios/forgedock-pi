import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FORGE_RUNTIME_HELPERS = [
  ["bin", "engine", "admission.mjs"],
  ["bin", "engine", "invariants.mjs"],
  ["bin", "engine", "orchestrate-canary.mjs"],
  ["bin", "engine", "resolve.mjs"],
  ["bin", "labels.json"],
  ["scripts", "classify-lane.sh"],
  ["scripts", "code-index.sh"],
  ["scripts", "derive-finding-milestone.sh"],
  ["scripts", "design-system-lint.mjs"],
  ["scripts", "doctor-pipeline-state.sh"],
  ["scripts", "eval-gate-scorecard.mjs"],
  ["scripts", "extract-affected-files.sh"],
  ["scripts", "flaky-quarantine.sh"],
  ["scripts", "graph-query.sh"],
  ["scripts", "issue-dedup.sh"],
  ["scripts", "select-fix-targets.sh"],
  ["scripts", "severity-to-priority.sh"],
  ["scripts", "transition-label.sh"],
  ["scripts", "validate-spec-graph.sh"],
  ["scripts", "verify-env-vars.sh"],
  ["scripts", "verify-host-headers.sh"],
  ["scripts", "verify-route-registration.sh"],
  ["scripts", "verify-sops-chain.sh"],
  ["scripts", "worktree-lifecycle.sh"],
] as const;

/**
 * Materialize self-contained original-spec helpers at the target-repository
 * paths used by their runtime commands. Existing files are never overwritten.
 */
export async function materializeForgeRuntimeHelpers(
  worktreeRoot: string,
): Promise<void> {
  const rootDir = await openAnchoredDirectory(worktreeRoot);
  try {
    const binDir = await ensureDirectory(rootDir, "bin");
    const scriptsDir = await ensureDirectory(rootDir, "scripts");
    try {
      const engineDir = await ensureDirectory(binDir, "engine");
      try {
        for (const parts of FORGE_RUNTIME_HELPERS) {
          const source = fileURLToPath(
            new URL(`../../specs/original/${parts.join("/")}`, import.meta.url),
          );
          const targetParent =
            parts[0] === "scripts"
              ? scriptsDir
              : parts[1] === "engine"
                ? engineDir
                : binDir;
          await ensureMaterializedFile(
            targetParent,
            parts.at(-1)!,
            source,
            parts.join("/"),
          );
        }
      } finally {
        await engineDir.close();
      }
    } finally {
      await scriptsDir.close();
      await binDir.close();
    }
  } finally {
    await rootDir.close();
  }
}

async function ensureMaterializedFile(
  parent: FileHandle,
  name: string,
  source: string,
  displayPath: string,
): Promise<void> {
  const content = await readFile(source, "utf8");
  let existing: string | undefined;
  try {
    const handle = await openFinalFile(parent, name, constants.O_RDONLY);
    try {
      existing = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (existing !== undefined) {
    if (existing !== content)
      throw new Error(
        `ForgeDock runtime helper conflicts with repository file: ${displayPath}`,
      );
    return;
  }
  const handle = await openFinalFile(
    parent,
    name,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    0o700,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function openAnchoredDirectory(path: string): Promise<FileHandle> {
  const absolute = resolve(path);
  let current = await open(sep, directoryFlags());
  for (const segment of absolute.split(sep).filter(Boolean)) {
    let next: FileHandle;
    try {
      next = await open(descriptorPath(current, segment), directoryFlags());
    } catch (error) {
      await current.close().catch(() => undefined);
      throw error;
    }
    await current.close();
    current = next;
  }
  return current;
}

async function ensureDirectory(
  parent: FileHandle,
  name: string,
): Promise<FileHandle> {
  try {
    await mkdir(descriptorPath(parent, name), { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  return open(descriptorPath(parent, name), directoryFlags());
}

function openFinalFile(
  parent: FileHandle,
  name: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  return open(descriptorPath(parent, name), flags | constants.O_NOFOLLOW, mode);
}

function directoryFlags(): number {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  )
    throw new Error(
      "ForgeDock cannot safely materialize runtime files: no-follow directory opens are unavailable.",
    );
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

function descriptorPath(parent: FileHandle, name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  )
    throw new TypeError("Secure Forge paths require a single file name.");
  const descriptorRoot =
    process.platform === "linux" || process.platform === "android"
      ? "/proc/self/fd"
      : process.platform === "darwin" ||
          process.platform === "freebsd" ||
          process.platform === "openbsd" ||
          process.platform === "netbsd"
        ? "/dev/fd"
        : undefined;
  if (!descriptorRoot)
    throw new Error(
      "ForgeDock cannot safely materialize runtime files on this platform: directory-handle no-follow support is unavailable.",
    );
  return join(descriptorRoot, String(parent.fd), name);
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === code,
  );
}

function isMissingFile(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}
