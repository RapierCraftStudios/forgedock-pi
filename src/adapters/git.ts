import { constants } from "node:fs";
import {
  access,
  lstat,
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
  repository?: string;
  /** Stable local identity used to reject a replaced repository at the same path. */
  repositoryIdentity?: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
}

export interface PreparedReviewWorktree {
  repositoryRoot: string;
  repository?: string;
  /** Stable local identity used to reject a replaced review repository. */
  repositoryIdentity?: string;
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

  async assertRepositoryIdentity(
    prepared: PreparedWorktree,
    expectedRepository?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertPreparedRepository(
      prepared,
      signal,
      expectedRepository,
    );
  }

  async assertRepositoryRoot(
    repositoryRoot: string,
    expectedRepository: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const root = await realpath(repositoryRoot);
    await this.#assertRepositoryOrigin(root, expectedRepository, signal);
    await this.#repositoryIdentity(root, signal);
  }

  async repositoryIdentityFor(
    repositoryRoot: string,
    expectedRepository: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const root = await realpath(repositoryRoot);
    await this.#assertRepositoryOrigin(root, expectedRepository, signal);
    return this.#repositoryIdentity(root, signal);
  }

  async adoptPreparedWorktree(
    prepared: PreparedWorktree,
    expectedRepository: string,
    signal?: AbortSignal,
  ): Promise<PreparedWorktree> {
    const root = await realpath(prepared.repositoryRoot);
    await this.#assertRepositoryOrigin(root, expectedRepository, signal);
    const adopted = {
      ...prepared,
      repository: expectedRepository,
      repositoryIdentity: await this.#repositoryIdentity(root, signal),
    };
    return this.rebind(adopted, signal, expectedRepository);
  }

  async prepare(
    repositoryRoot: string,
    input: {
      runId: string;
      issueNumber: number;
      baseBranch: string;
      expectedRepository?: string;
      signal?: AbortSignal;
    },
  ): Promise<PreparedWorktree> {
    assertSafeIdentifier(input.runId, "runId");
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1)
      throw new TypeError("Issue number must be positive.");
    if (!input.baseBranch.trim() || input.baseBranch.startsWith("-"))
      throw new TypeError("Base branch is invalid.");
    const root = await realpath(repositoryRoot);
    if (input.expectedRepository)
      await this.#assertRepositoryOrigin(
        root,
        input.expectedRepository,
        input.signal,
      );
    const repositoryIdentity = await this.#repositoryIdentity(
      root,
      input.signal,
    );
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
    const prepared = {
      repositoryRoot: root,
      ...(input.expectedRepository
        ? { repository: input.expectedRepository }
        : {}),
      repositoryIdentity,
      worktreePath,
      branch,
      baseBranch: input.baseBranch,
      baseSha,
    };
    let worktreeCreated = false;
    try {
      await this.#git(
        root,
        ["worktree", "add", "-b", branch, worktreePath, baseSha],
        120_000,
        input.signal,
      );
      worktreeCreated = true;
      const canonicalWorktree = await realpath(worktreePath);
      if (!isPathWithin(join(root, ".forge", "worktrees"), canonicalWorktree)) {
        throw new Error(
          "Git created a worktree outside the owned Forge directory.",
        );
      }
      return { ...prepared, worktreePath: canonicalWorktree };
    } catch (error) {
      // The caller cannot clean up a preparation that never returned. Remove
      // both resources here, including when canonicalization rejects Git's
      // newly-created path.
      if (worktreeCreated) {
        // Preparation cleanup is compensating work; it must still run when
        // the caller's operation was cancelled.
        await this.#cleanupFailedPreparation(prepared).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  async prepareReview(
    repositoryRoot: string,
    input: {
      reviewId: string;
      headRef: string;
      headSha: string;
      baseRef: string;
      baseSha: string;
      expectedRepository?: string;
      signal?: AbortSignal;
    },
  ): Promise<PreparedReviewWorktree> {
    assertSafeIdentifier(input.reviewId, "reviewId");
    assertSafeBranchRef(input.headRef, "headRef");
    assertSafeBranchRef(input.baseRef, "baseRef");
    assertCommitSha(input.headSha, "headSha");
    assertCommitSha(input.baseSha, "baseSha");
    const root = await realpath(repositoryRoot);
    if (input.expectedRepository)
      await this.#assertRepositoryOrigin(
        root,
        input.expectedRepository,
        input.signal,
      );
    const repositoryIdentity = await this.#repositoryIdentity(
      root,
      input.signal,
    );
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
    const prepared = {
      repositoryRoot: root,
      ...(input.expectedRepository
        ? { repository: input.expectedRepository }
        : {}),
      repositoryIdentity,
      worktreePath,
      headRef: input.headRef,
      headSha: input.headSha,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
    };
    await mkdir(dirname(worktreePath), { recursive: true });
    if (await exists(worktreePath)) {
      await this.#assertReviewWorktree(prepared, input.signal);
      await this.assertClean(worktreePath, input.signal);
      return prepared;
    }
    let worktreeCreated = false;
    try {
      await this.#git(
        root,
        ["worktree", "add", "--detach", worktreePath, input.headSha],
        120_000,
        input.signal,
      );
      worktreeCreated = true;
      const canonicalWorktree = await realpath(worktreePath);
      if (!isPathWithin(join(root, ".forge", "reviews"), canonicalWorktree))
        throw new Error("Git created a review worktree outside the Forge review directory.");
      return { ...prepared, worktreePath: canonicalWorktree };
    } catch (error) {
      if (worktreeCreated)
        await this.#cleanupFailedReviewPreparation(
          root,
          worktreePath,
        ).catch(() => undefined);
      throw error;
    }
  }

  async cleanupReview(
    prepared: PreparedReviewWorktree,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertReviewWorktree(prepared, signal);
    await this.#cleanupWorktree(
      prepared.repositoryRoot,
      prepared.worktreePath,
      signal,
    );
  }

  async #assertReviewWorktree(
    prepared: PreparedReviewWorktree,
    signal?: AbortSignal,
  ): Promise<void> {
    const root = await realpath(prepared.repositoryRoot);
    const currentRepositoryIdentity = await this.#repositoryIdentity(
      root,
      signal,
    );
    if (
      !prepared.repositoryIdentity ||
      prepared.repositoryIdentity !== currentRepositoryIdentity
    )
      throw new Error(
        "Forge worktree binding failure: retained review repository identity is missing or has been replaced.",
      );
    if (prepared.repository)
      await this.#assertRepositoryOrigin(root, prepared.repository, signal);
    const reviewBase = join(root, ".forge", "reviews");
    const expectedPath = resolve(root, prepared.worktreePath);
    if (!isPathWithin(reviewBase, expectedPath) || expectedPath === reviewBase)
      throw new Error(
        `Forge worktree binding failure: retained review path ${prepared.worktreePath} is outside the owned review directory.`,
      );
    let existing: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      existing = await lstat(expectedPath);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    if (existing.isSymbolicLink() || !existing.isDirectory())
      throw new Error(
        `Forge worktree binding failure: retained review path ${prepared.worktreePath} is not a real directory.`,
      );
    const canonicalWorktree = await realpath(expectedPath);
    if (canonicalWorktree !== expectedPath)
      throw new Error(
        `Forge worktree binding failure: retained review path ${prepared.worktreePath} is not the exact owned worktree.`,
      );
    const registration = await this.#git(
      root,
      ["worktree", "list", "--porcelain"],
      30_000,
      signal,
    );
    if (
      !reviewWorktreeRegistrationMatches(
        registration.stdout,
        root,
        canonicalWorktree,
        prepared.headSha,
      )
    )
      throw new Error(
        `Forge worktree binding failure: ${canonicalWorktree} is not the registered review worktree.`,
      );
    const [rootCommon, worktreeCommon] = await Promise.all([
      this.#git(root, ["rev-parse", "--git-common-dir"], 30_000, signal),
      this.#git(
        canonicalWorktree,
        ["rev-parse", "--git-common-dir"],
        30_000,
        signal,
      ),
    ]);
    if (
      (await realpath(resolve(root, rootCommon.stdout.trim()))) !==
      (await realpath(resolve(canonicalWorktree, worktreeCommon.stdout.trim())))
    )
      throw new Error(
        `Forge worktree binding failure: ${canonicalWorktree} belongs to another Git repository.`,
      );
    const currentHead = await this.#git(
      canonicalWorktree,
      ["rev-parse", "HEAD"],
      30_000,
      signal,
    );
    if (currentHead.stdout.trim() !== prepared.headSha)
      throw new Error(
        `Forge worktree binding failure: expected review head ${prepared.headSha}, found ${currentHead.stdout.trim() || "unknown"}.`,
      );
  }

  /** Rebind a retained run to its exact Forge worktree without changing its branch. */
  async rebind(
    prepared: PreparedWorktree,
    signal?: AbortSignal,
    expectedRepository?: string,
  ): Promise<PreparedWorktree> {
    const root = await this.#assertPreparedRepository(
      prepared,
      signal,
      expectedRepository,
    );
    const worktreeBase = join(root, ".forge", "worktrees");
    const expectedPath = resolve(root, prepared.worktreePath);
    if (
      !isPathWithin(worktreeBase, expectedPath) ||
      expectedPath === resolve(worktreeBase)
    )
      throw new Error(
        `Forge worktree binding failure: retained path ${prepared.worktreePath} is outside the owned worktree directory.`,
      );
    assertSafeBranchRef(prepared.branch, "prepared branch");
    let parentStat: Awaited<ReturnType<typeof lstat>>;
    try {
      parentStat = await lstat(worktreeBase);
    } catch {
      throw new Error(
        `Forge worktree binding failure: owned parent ${worktreeBase} is unavailable.`,
      );
    }
    if (
      parentStat.isSymbolicLink() ||
      !parentStat.isDirectory() ||
      (await realpath(worktreeBase)) !== worktreeBase
    )
      throw new Error(
        `Forge worktree binding failure: owned parent ${worktreeBase} is not a real directory.`,
      );

    let created = false;
    try {
      let existing: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        existing = await lstat(expectedPath);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      if (existing?.isSymbolicLink())
        throw new Error(
          `Forge worktree binding failure: retained path ${prepared.worktreePath} is a symlink.`,
        );
      if (existing && !existing.isDirectory())
        throw new Error(
          `Forge worktree binding failure: retained path ${prepared.worktreePath} is not a directory.`,
        );

      if (!existing) {
        try {
          await this.#git(
            root,
            ["worktree", "remove", "--force", expectedPath],
            120_000,
            signal,
          );
        } catch (error) {
          if (!isAlreadyAbsent(error)) throw error;
        }
        const branch = await this.#executor.exec(
          "git",
          ["show-ref", "--verify", "--quiet", `refs/heads/${prepared.branch}`],
          {
            cwd: root,
            timeout: 30_000,
            ...(signal ? { signal } : {}),
          },
        );
        if (branch.code === 0) {
          created = true;
          await this.#git(
            root,
            ["worktree", "add", expectedPath, prepared.branch],
            120_000,
            signal,
          );
        } else if (branch.code === 1) {
          await this.#git(
            root,
            ["fetch", "--no-tags", "origin", prepared.branch],
            120_000,
            signal,
          );
          created = true;
          await this.#git(
            root,
            [
              "worktree",
              "add",
              "-b",
              prepared.branch,
              expectedPath,
              `origin/${prepared.branch}`,
            ],
            120_000,
            signal,
          );
        } else {
          throw new GitOperationError(
            `resolve retained branch ${prepared.branch}`,
            branch,
          );
        }
      }

      const canonicalWorktree = await realpath(expectedPath);
      if (canonicalWorktree !== expectedPath)
        throw new Error(
          `Forge worktree binding failure: retained path ${prepared.worktreePath} is not the exact owned worktree.`,
        );
      const registration = await this.#git(
        root,
        ["worktree", "list", "--porcelain"],
        30_000,
        signal,
      );
      if (
        !worktreeRegistrationMatches(
          registration.stdout,
          root,
          canonicalWorktree,
          prepared.branch,
        )
      )
        throw new Error(
          `Forge worktree binding failure: ${canonicalWorktree} is not registered to the repository and branch.`,
        );
      const [rootCommon, worktreeCommon] = await Promise.all([
        this.#git(root, ["rev-parse", "--git-common-dir"], 30_000, signal),
        this.#git(
          canonicalWorktree,
          ["rev-parse", "--git-common-dir"],
          30_000,
          signal,
        ),
      ]);
      if (
        (await realpath(resolve(root, rootCommon.stdout.trim()))) !==
        (await realpath(resolve(canonicalWorktree, worktreeCommon.stdout.trim())))
      )
        throw new Error(
          `Forge worktree binding failure: ${canonicalWorktree} belongs to another Git repository.`,
        );
      const currentBranch = await this.#git(
        canonicalWorktree,
        ["branch", "--show-current"],
        30_000,
        signal,
      );
      if (currentBranch.stdout.trim() !== prepared.branch)
        throw new Error(
          `Forge worktree binding failure: expected branch ${prepared.branch}, found ${currentBranch.stdout.trim() || "detached"}.`,
        );
      return {
        ...prepared,
        repositoryRoot: root,
        worktreePath: canonicalWorktree,
      };
    } catch (error) {
      if (created)
        await this.#git(
          root,
          ["worktree", "remove", "--force", expectedPath],
          120_000,
          signal,
        ).catch(() => undefined);
      throw error;
    }
  }

  /** Fetch refs used by a frozen reachability decision without changing HEAD. */
  async fetchRefs(
    repositoryRoot: string,
    refs: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (refs.length === 0) throw new TypeError("At least one Git ref is required.");
    for (const ref of refs) {
      if (!ref.trim() || ref.startsWith("-"))
        throw new TypeError("Git ref is invalid.");
    }
    await this.#git(
      repositoryRoot,
      ["fetch", "--no-tags", "origin", ...refs],
      120_000,
      signal,
    );
  }

  /** Return Git's exact ancestry answer; provider/command errors fail closed. */
  async isAncestor(
    repositoryRoot: string,
    ancestorSha: string,
    descendantSha: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!ancestorSha.trim() || !descendantSha.trim())
      throw new TypeError("Commit SHAs are required for reachability.");
    const result = await this.#executor.exec(
      "git",
      ["merge-base", "--is-ancestor", ancestorSha, descendantSha],
      {
        cwd: repositoryRoot,
        timeout: 30_000,
        ...(signal ? { signal } : {}),
      },
    );
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new GitOperationError("commit reachability", result);
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

  async branch(worktreePath: string, signal?: AbortSignal): Promise<string> {
    return (
      await this.#git(
        worktreePath,
        ["branch", "--show-current"],
        30_000,
        signal,
      )
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
    prepared: PreparedWorktree,
    signal?: AbortSignal,
    expectedRepository?: string,
  ): Promise<void> {
    const rebound = await this.rebind(
      prepared,
      signal,
      expectedRepository,
    );
    await this.assertClean(rebound.worktreePath, signal);
    await this.#git(
      rebound.worktreePath,
      ["push", "--set-upstream", "origin", rebound.branch],
      120_000,
      signal,
    );
  }

  async deleteRemoteBranch(
    prepared: PreparedWorktree,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#assertPreparedRepository(prepared, signal);
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
    // Validate ownership before cleanup can touch the retained path. A crash
    // or external replacement must never turn cleanup into foreign deletion.
    await this.#assertPreparedRepository(prepared, signal);
    if (await exists(prepared.worktreePath))
      prepared = await this.rebind(prepared, signal, prepared.repository);
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

  async #cleanupFailedReviewPreparation(
    repositoryRoot: string,
    worktreePath: string,
  ): Promise<void> {
    if (await exists(worktreePath)) {
      try {
        await this.#git(
          repositoryRoot,
          ["worktree", "remove", "--force", worktreePath],
          120_000,
        );
      } catch (error) {
        if (!isAlreadyAbsent(error)) throw error;
      }
    }
    if (await exists(worktreePath))
      await rm(worktreePath, { recursive: true, force: true });
  }

  async #cleanupFailedPreparation(
    prepared: PreparedWorktree,
  ): Promise<void> {
    // No user work can exist before prepare returns, so force removal is
    // appropriate if canonicalization or validation rejects the new worktree.
    if (await exists(prepared.worktreePath)) {
      try {
        await this.#git(
          prepared.repositoryRoot,
          ["worktree", "remove", "--force", prepared.worktreePath],
          120_000,
        );
      } catch (error) {
        if (!isAlreadyAbsent(error)) throw error;
      }
    }
    if (await exists(prepared.worktreePath))
      await rm(prepared.worktreePath, { recursive: true, force: true });
    try {
      await this.#git(
        prepared.repositoryRoot,
        ["branch", "-D", prepared.branch],
        30_000,
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

  async #assertPreparedRepository(
    prepared: PreparedWorktree,
    signal?: AbortSignal,
    expectedRepository = prepared.repository,
  ): Promise<string> {
    const root = await realpath(prepared.repositoryRoot);
    const currentRepositoryIdentity = await this.#repositoryIdentity(
      root,
      signal,
    );
    if (
      !prepared.repositoryIdentity ||
      prepared.repositoryIdentity !== currentRepositoryIdentity
    )
      throw new Error(
        "Forge worktree binding failure: retained repository identity is missing or has been replaced.",
      );
    if (expectedRepository)
      await this.#assertRepositoryOrigin(root, expectedRepository, signal);
    return root;
  }

  async #assertRepositoryOrigin(
    repositoryRoot: string,
    expectedRepository: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let remote: ExecResult;
    try {
      remote = await this.#git(
        repositoryRoot,
        ["config", "--get", "remote.origin.url"],
        30_000,
        signal,
      );
    } catch {
      throw new Error(
        `Forge worktree binding failure: repository origin does not match ${expectedRepository}.`,
      );
    }
    if (!repositoryRemoteMatches(remote.stdout, expectedRepository))
      throw new Error(
        `Forge worktree binding failure: repository origin does not match ${expectedRepository}.`,
      );
  }

  async #repositoryIdentity(
    repositoryRoot: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const commonDirResult = await this.#git(
      repositoryRoot,
      ["rev-parse", "--git-common-dir"],
      30_000,
      signal,
    );
    const commonDir = await realpath(
      resolve(repositoryRoot, commonDirResult.stdout.trim()),
    );
    const stat = await lstat(commonDir);
    return `${commonDir}:${String(stat.dev)}:${String(stat.ino)}`;
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

function repositoryRemoteMatches(
  remote: string,
  repository: string,
): boolean {
  const normalized = remote
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  return normalized === `https://github.com/${repository.toLowerCase()}`;
}

function reviewWorktreeRegistrationMatches(
  output: string,
  repositoryRoot: string,
  expectedPath: string,
  expectedHead: string,
): boolean {
  let path: string | undefined;
  let head: string | undefined;
  let detached = false;
  let prunable = false;
  const matches = (): boolean =>
    path !== undefined &&
    resolve(repositoryRoot, path) === expectedPath &&
    head === expectedHead &&
    detached &&
    !prunable;
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (matches()) return true;
      path = undefined;
      head = undefined;
      detached = false;
      prunable = false;
      continue;
    }
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
    else if (line === "detached") detached = true;
    else if (line.startsWith("prunable")) prunable = true;
  }
  return matches();
}

function worktreeRegistrationMatches(
  output: string,
  repositoryRoot: string,
  expectedPath: string,
  expectedBranch: string,
): boolean {
  let path: string | undefined;
  let branch: string | undefined;
  let prunable = false;
  const matches = (): boolean =>
    path !== undefined &&
    resolve(repositoryRoot, path) === expectedPath &&
    branch === `refs/heads/${expectedBranch}` &&
    !prunable;
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (matches()) return true;
      path = undefined;
      branch = undefined;
      prunable = false;
      continue;
    }
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
    else if (line.startsWith("prunable")) prunable = true;
  }
  return matches();
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
