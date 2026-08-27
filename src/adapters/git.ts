import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed?: boolean;
}

export interface CommandExecutor {
  exec(
    command: string,
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
}

export interface PreparedWorktree {
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
}

export interface PreparedReviewWorktree {
  repositoryRoot: string;
  worktreePath: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
}

export class GitOperationError extends Error {
  readonly operation: string;
  readonly result: ExecResult;

  constructor(operation: string, result: ExecResult) {
    super(
      `${operation} failed (${String(result.code)}): ${result.stderr || result.stdout}`,
    );
    this.name = "GitOperationError";
    this.operation = operation;
    this.result = result;
  }
}

export class GitWorktreeManager {
  readonly #executor: CommandExecutor;

  constructor(executor: CommandExecutor) {
    this.#executor = executor;
  }

  async ensureRuntimeIgnored(
    repositoryRoot: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.#git(
      repositoryRoot,
      ["rev-parse", "--git-path", "info/exclude"],
      30_000,
      signal,
    );
    const rawExcludePath = result.stdout.trim();
    if (!rawExcludePath)
      throw new Error("Unable to resolve Git's local exclude file.");
    const excludePath = isAbsolute(rawExcludePath)
      ? rawExcludePath
      : resolve(repositoryRoot, rawExcludePath);
    const metadataDir = await openAnchoredDirectory(dirname(excludePath));
    try {
      let existing = "";
      try {
        existing = await readTextFile(
          metadataDir,
          basename(excludePath),
        );
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      if (
        existing
          .split("\n")
          .map((line) => line.trim())
          .includes(".pi/")
      )
        return;
      await appendTextFile(
        metadataDir,
        basename(excludePath),
        `${existing && !existing.endsWith("\n") ? "\n" : ""}.pi/\n`,
      );
    } finally {
      await metadataDir.close();
    }
  }

  async resolveRepositoryRoot(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.#git(
      cwd,
      ["rev-parse", "--show-toplevel"],
      30_000,
      signal,
    );
    return realpath(result.stdout.trim());
  }

  async prepare(
    repositoryRoot: string,
    input: {
      runId: string;
      issueNumber: number;
      baseBranch: string;
      signal?: AbortSignal;
    },
  ): Promise<PreparedWorktree> {
    assertSafeIdentifier(input.runId, "runId");
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1)
      throw new TypeError("Issue number must be positive.");
    if (!input.baseBranch.trim() || input.baseBranch.startsWith("-"))
      throw new TypeError("Base branch is invalid.");
    const root = await realpath(repositoryRoot);
    await this.#git(
      root,
      ["fetch", "--no-tags", "origin", input.baseBranch],
      120_000,
      input.signal,
    );
    const base = await this.#git(
      root,
      ["rev-parse", `origin/${input.baseBranch}^{commit}`],
      30_000,
      input.signal,
    );
    const baseSha = base.stdout.trim();
    const branch = `forge/issue-${input.issueNumber}-${input.runId.slice(0, 8)}`;
    const worktreePath = join(root, ".forge", "worktrees", input.runId);
    await mkdir(dirname(worktreePath), { recursive: true });
    if (await exists(worktreePath))
      throw new Error(`Owned worktree path already exists: ${worktreePath}`);
    await this.#git(
      root,
      ["worktree", "add", "-b", branch, worktreePath, baseSha],
      120_000,
      input.signal,
    );
    const canonicalWorktree = await realpath(worktreePath);
    if (!isPathWithin(join(root, ".forge", "worktrees"), canonicalWorktree)) {
      throw new Error(
        "Git created a worktree outside the owned Forge directory.",
      );
    }
    return {
      repositoryRoot: root,
      worktreePath: canonicalWorktree,
      branch,
      baseBranch: input.baseBranch,
      baseSha,
    };
  }

  async prepareReview(
    repositoryRoot: string,
    input: {
      reviewId: string;
      headRef: string;
      headSha: string;
      baseRef: string;
      baseSha: string;
      signal?: AbortSignal;
    },
  ): Promise<PreparedReviewWorktree> {
    assertSafeIdentifier(input.reviewId, "reviewId");
    assertSafeBranchRef(input.headRef, "headRef");
    assertSafeBranchRef(input.baseRef, "baseRef");
    assertCommitSha(input.headSha, "headSha");
    assertCommitSha(input.baseSha, "baseSha");
    const root = await realpath(repositoryRoot);
    await this.#git(
      root,
      ["fetch", "--no-tags", "origin", input.headRef, input.baseRef],
      120_000,
      input.signal,
    );
    const [headResult, baseResult] = await Promise.all([
      this.#git(
        root,
        ["rev-parse", `origin/${input.headRef}^{commit}`],
        30_000,
        input.signal,
      ),
      this.#git(
        root,
        ["rev-parse", `origin/${input.baseRef}^{commit}`],
        30_000,
        input.signal,
      ),
    ]);
    const currentHead = headResult.stdout.trim();
    const currentBase = baseResult.stdout.trim();
    if (currentHead !== input.headSha || currentBase !== input.baseSha)
      throw new Error(
        "Pull request head/base changed before review worktree preparation.",
      );
    const worktreePath = join(root, ".forge", "reviews", input.reviewId);
    await mkdir(dirname(worktreePath), { recursive: true });
    if (await exists(worktreePath)) {
      const canonicalWorktree = await realpath(worktreePath);
      if (!isPathWithin(join(root, ".forge", "reviews"), canonicalWorktree))
        throw new Error("Existing review worktree is outside the Forge review directory.");
      const existingHead = await this.head(canonicalWorktree, input.signal);
      if (existingHead !== input.headSha)
        throw new Error(
          `Existing review worktree head ${existingHead} does not match ${input.headSha}.`,
        );
      await this.assertClean(canonicalWorktree, input.signal);
      return {
        repositoryRoot: root,
        worktreePath: canonicalWorktree,
        headRef: input.headRef,
        headSha: input.headSha,
        baseRef: input.baseRef,
        baseSha: input.baseSha,
      };
    }
    await this.#git(
      root,
      ["worktree", "add", "--detach", worktreePath, input.headSha],
      120_000,
      input.signal,
    );
    const canonicalWorktree = await realpath(worktreePath);
    if (!isPathWithin(join(root, ".forge", "reviews"), canonicalWorktree))
      throw new Error("Git created a review worktree outside the Forge review directory.");
    return {
      repositoryRoot: root,
      worktreePath: canonicalWorktree,
      headRef: input.headRef,
      headSha: input.headSha,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
    };
  }

  async cleanupReview(
    prepared: PreparedReviewWorktree,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#cleanupWorktree(
      prepared.repositoryRoot,
      prepared.worktreePath,
      signal,
    );
  }

  async remoteBaseSha(
    repositoryRoot: string,
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.#git(
      repositoryRoot,
      ["fetch", "--no-tags", "origin", baseBranch],
      120_000,
      signal,
    );
    return (
      await this.#git(
        repositoryRoot,
        ["rev-parse", `origin/${baseBranch}^{commit}`],
        30_000,
        signal,
      )
    ).stdout.trim();
  }

  async head(worktreePath: string, signal?: AbortSignal): Promise<string> {
    return (
      await this.#git(worktreePath, ["rev-parse", "HEAD"], 30_000, signal)
    ).stdout.trim();
  }

  async changedFiles(
    worktreePath: string,
    baseSha: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const result = await this.#git(
      worktreePath,
      [
        "diff",
        "--name-status",
        "--find-renames",
        "-z",
        `${baseSha}...HEAD`,
        "--",
      ],
      30_000,
      signal,
    );
    return parseChangedGitPaths(result.stdout);
  }

  async assertClean(worktreePath: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#git(
      worktreePath,
      ["status", "--porcelain"],
      30_000,
      signal,
    );
    const meaningful = result.stdout
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        const path = line.length > 3 ? line.slice(3).trim() : line.trim();
        return !(
          line.startsWith("??") &&
          (path === ".pi" || path.startsWith(".pi/"))
        );
      })
      .join("\n")
      .trim();
    if (meaningful) throw new Error(`Worktree is not clean:\n${meaningful}`);
  }

  async push(
    worktreePath: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.assertClean(worktreePath, signal);
    await this.#git(
      worktreePath,
      ["push", "--set-upstream", "origin", branch],
      120_000,
      signal,
    );
  }

  async deleteRemoteBranch(
    prepared: PreparedWorktree,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.#executor.exec(
      "git",
      ["push", "origin", "--delete", prepared.branch],
      {
        cwd: prepared.repositoryRoot,
        timeout: 120_000,
        ...(signal ? { signal } : {}),
      },
    );
    if (
      result.code !== 0 &&
      !/remote ref does not exist|unable to delete/i.test(
        `${result.stderr}\n${result.stdout}`,
      )
    ) {
      throw new GitOperationError(
        `delete remote branch ${prepared.branch}`,
        result,
      );
    }
  }

  async cleanup(
    prepared: PreparedWorktree,
    signal?: AbortSignal,
  ): Promise<void> {
    // Cleanup is a retryable owned effect. A crash may happen after Git has
    // removed either the worktree or the branch, so absence is success.
    await this.#cleanupWorktree(
      prepared.repositoryRoot,
      prepared.worktreePath,
      signal,
    );
    try {
      await this.#git(
        prepared.repositoryRoot,
        ["branch", "-D", prepared.branch],
        30_000,
        signal,
      );
    } catch (error) {
      if (!isAlreadyAbsent(error)) throw error;
    }
  }

  async #cleanupWorktree(
    repositoryRoot: string,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (await exists(worktreePath)) {
      await cleanupForgeRuntime(worktreePath);
      await this.assertClean(worktreePath, signal);
      try {
        await this.#git(
          repositoryRoot,
          ["worktree", "remove", worktreePath],
          120_000,
          signal,
        );
      } catch (error) {
        if (!isAlreadyAbsent(error)) throw error;
      }
    }
    if (await exists(worktreePath))
      await rm(worktreePath, { recursive: true, force: true });
  }

  async #git(
    cwd: string,
    args: readonly string[],
    timeout: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const result = await this.#executor.exec("git", args, {
      cwd,
      timeout,
      ...(signal ? { signal } : {}),
    });
    if (result.code !== 0)
      throw new GitOperationError(`git ${args.join(" ")}`, result);
    return result;
  }
}

async function openAnchoredDirectory(path: string): Promise<FileHandle> {
  const flags = directoryFlags();
  const absolute = resolve(path);
  const segments = absolute.split(sep).filter(Boolean);
  let current = await open(sep, flags);
  for (const segment of segments) {
    const childPath = descriptorPath(current, segment);
    let next: FileHandle;
    try {
      next = await open(childPath, flags);
    } catch (error) {
      await current.close().catch(() => undefined);
      throw error;
    }
    await current.close();
    current = next;
  }
  return current;
}

async function readTextFile(parent: FileHandle, name: string): Promise<string> {
  const handle = await openFinalFile(parent, name, constants.O_RDONLY);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function appendTextFile(
  parent: FileHandle,
  name: string,
  content: string,
): Promise<void> {
  const handle = await openFinalFile(
    parent,
    name,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
    0o666,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function openFinalFile(
  parent: FileHandle,
  name: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  requireSecureFilesystem();
  return open(
    descriptorPath(parent, name),
    flags | constants.O_NOFOLLOW,
    mode,
  );
}

function directoryFlags(): number {
  requireSecureFilesystem();
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
    throw new TypeError("Secure Git paths require a single file name.");
  return join(descriptorRoot(), String(parent.fd), name);
}

function descriptorRoot(): string {
  if (process.platform === "linux" || process.platform === "android")
    return "/proc/self/fd";
  if (
    process.platform === "darwin" ||
    process.platform === "freebsd" ||
    process.platform === "openbsd" ||
    process.platform === "netbsd"
  )
    return "/dev/fd";
  throw new Error(
    "ForgeDock cannot safely update Git's local exclude file on this platform: directory-handle no-follow support is unavailable.",
  );
}

function requireSecureFilesystem(): void {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  )
    throw new Error(
      "ForgeDock cannot safely update Git's local exclude file: no-follow directory opens are unavailable.",
    );
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === code,
  );
}

function isMissingFile(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

async function cleanupForgeRuntime(worktreePath: string): Promise<void> {
  let rootDir: FileHandle;
  try {
    rootDir = await openAnchoredDirectory(worktreePath);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  try {
    const piDir = await openExistingDirectory(rootDir, ".pi");
    if (!piDir) return;
    try {
      const forgeDir = await openExistingDirectory(piDir, "forge");
      let generatedSettings = false;
      if (forgeDir) {
        try {
          generatedSettings = await finalFileExists(
            forgeDir,
            "generated-settings",
          );
        } finally {
          await forgeDir.close();
        }
      }
      if (generatedSettings) await removeChild(piDir, "settings.json");

      const agentsDir = await openExistingDirectory(piDir, "agents");
      if (agentsDir) {
        try {
          for (const name of [
            "forge-work-on.md",
            "forge-refresh-review.md",
            "forge-review-correctness.md",
            "forge-review-security.md",
          ])
            await removeChild(agentsDir, name);
        } finally {
          await agentsDir.close();
        }
        await removeDirectory(piDir, "agents");
      }
      await removeChild(piDir, "forge", true);
      await removeDirectory(rootDir, ".pi");
    } finally {
      await piDir.close();
    }
  } finally {
    await rootDir.close();
  }
}

async function openExistingDirectory(
  parent: FileHandle,
  name: string,
): Promise<FileHandle | undefined> {
  try {
    return await open(descriptorPath(parent, name), directoryFlags());
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function finalFileExists(
  parent: FileHandle,
  name: string,
): Promise<boolean> {
  try {
    const handle = await openFinalFile(parent, name, constants.O_RDONLY);
    await handle.close();
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function removeChild(
  parent: FileHandle,
  name: string,
  recursive = false,
): Promise<void> {
  const path = descriptorPath(parent, name);
  if (recursive) await rm(path, { recursive: true, force: true });
  else await rm(path, { force: true });
}

async function removeDirectory(parent: FileHandle, name: string): Promise<void> {
  try {
    await rmdir(descriptorPath(parent, name));
  } catch {
    // The directory may contain user files or may already be absent. Both
    // cases are safe to leave for the owned-worktree cleanup/retry path.
  }
}

function isAlreadyAbsent(error: unknown): boolean {
  if (!(error instanceof GitOperationError)) return false;
  return /does not exist|not found|is not a working tree|is not a branch|not a valid branch name/i.test(
    `${error.result.stderr}\n${error.result.stdout}`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertSafeBranchRef(value: string, field: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.split("/").some((part) => !part || part.startsWith("."))
  )
    throw new TypeError(`${field} contains an unsafe Git branch ref.`);
}

function assertCommitSha(value: string, field: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value))
    throw new TypeError(`${field} must be a full Git commit SHA.`);
}

function assertSafeIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new TypeError(`${field} contains unsafe characters.`);
}

/** Parse every path affected by a NUL-delimited Git name-status listing. */
export function parseChangedGitPaths(output: string): string[] {
  const tokens = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (!status) continue;
    const first = tokens[index++];
    if (!first)
      throw new Error(`Malformed NUL-delimited Git status record: ${status}.`);
    paths.push(first);
    const kind = status.charAt(0);
    if (kind === "R" || kind === "C") {
      const second = tokens[index++];
      if (!second)
        throw new Error(
          `Malformed Git rename/copy record without a destination: ${status}.`,
        );
      paths.push(second);
    }
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function isPathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !child.startsWith("/"));
}
