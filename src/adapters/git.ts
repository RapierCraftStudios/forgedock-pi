import { access, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  parseGitNameStatus,
  type ChangedPath,
} from "../core/builder-contract.ts";

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
      ["diff", "--name-only", `${baseSha}...HEAD`],
      30_000,
      signal,
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async changedPaths(
    worktreePath: string,
    baseSha: string,
    signal?: AbortSignal,
  ): Promise<ChangedPath[]> {
    const result = await this.#git(
      worktreePath,
      ["diff", "--no-ext-diff", "--name-status", "-z", `${baseSha}...HEAD", "--"],
      30_000,
      signal,
    );
    return parseGitNameStatus(result.stdout);
  }

  async stagedPaths(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<ChangedPath[]> {
    const result = await this.#git(
      worktreePath,
      ["diff", "--cached", "--no-ext-diff", "--name-status", "-z", "--"],
      30_000,
      signal,
    );
    return parseGitNameStatus(result.stdout);
  }

  async assertClean(worktreePath: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#git(
      worktreePath,
      ["status", "--porcelain"],
      30_000,
      signal,
    );
    if (result.stdout.trim())
      throw new Error(`Worktree is not clean:\n${result.stdout}`);
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
    await this.assertClean(prepared.worktreePath, signal);
    await this.#git(
      prepared.repositoryRoot,
      ["worktree", "remove", prepared.worktreePath],
      120_000,
      signal,
    );
    if (await exists(prepared.worktreePath))
      await rm(prepared.worktreePath, { recursive: true });
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertSafeIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new TypeError(`${field} contains unsafe characters.`);
}

function isPathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !child.startsWith("/"));
}
