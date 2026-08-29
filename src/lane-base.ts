import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  assertBuilderContractPaths,
  createBuilderPathContract,
} from "./core/builder-contract.ts";

const execFileAsync = promisify(execFile);

export interface PrepareLaneBaseInput {
  repositoryRoot: string;
  targetRef: string;
  targetSha: string;
  signal?: AbortSignal;
}

export interface PreparedLaneBase {
  schema: "forgedock.lane-base/v1";
  branch: string;
  targetRef: string;
  targetSha: string;
  previousHeadSha: string;
  initialized: boolean;
}

export interface VerifyLaneScopeInput {
  repositoryRoot: string;
  targetRef: string;
  routeBaseRef: string;
  baseSha: string;
  headSha: string;
  claimedPaths: readonly string[];
  signal?: AbortSignal;
}

export interface VerifiedLaneScope {
  schema: "forgedock.lane-scope/v1";
  targetRef: string;
  baseSha: string;
  headSha: string;
  changedPaths: readonly string[];
}

export class LaneBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneBaseError";
  }
}

function validateBranch(value: string, label: string): string {
  const branch = value.trim();
  if (
    branch.length === 0 ||
    branch.length > 240 ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.split("/").some((segment) =>
      segment.length === 0 || segment.startsWith(".") || segment.endsWith(".lock")
    )
  ) {
    throw new LaneBaseError(`${label} is not a safe branch name.`);
  }
  return branch;
}

function validateSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new LaneBaseError("targetSha must be a full 40-character commit SHA.");
  return sha;
}

async function git(
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    ...(signal ? { signal } : {}),
  });
  return result.stdout.trim();
}

async function assertRemoteBranchAbsent(
  root: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await git(
      root,
      ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
      signal,
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 2
    ) {
      return;
    }
    throw error;
  }
  throw new LaneBaseError(
    `managed branch ${branch} already exists on origin; refusing to rewrite it.`,
  );
}

/** Initialize one fresh managed writer branch to an exact authoritative target. */
export async function prepareManagedLaneBase(
  input: PrepareLaneBaseInput,
): Promise<PreparedLaneBase> {
  const targetRef = validateBranch(input.targetRef, "targetRef");
  const targetSha = validateSha(input.targetSha);
  const status = await git(
    input.repositoryRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    input.signal,
  );
  if (status)
    throw new LaneBaseError("managed worktree is not clean; refusing base initialization.");

  const branch = validateBranch(
    await git(input.repositoryRoot, ["branch", "--show-current"], input.signal),
    "current branch",
  );
  try {
    const upstream = await git(
      input.repositoryRoot,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      input.signal,
    );
    throw new LaneBaseError(
      `managed branch ${branch} already tracks ${upstream}; refusing to rewrite it.`,
    );
  } catch (error) {
    if (error instanceof LaneBaseError) throw error;
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === 128
      )
    ) {
      throw error;
    }
  }
  await assertRemoteBranchAbsent(input.repositoryRoot, branch, input.signal);

  await git(
    input.repositoryRoot,
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${targetRef}:refs/remotes/origin/${targetRef}`,
    ],
    input.signal,
  );
  const remoteTarget = (
    await git(
      input.repositoryRoot,
      ["rev-parse", `refs/remotes/origin/${targetRef}^{commit}`],
      input.signal,
    )
  ).toLowerCase();
  if (remoteTarget !== targetSha)
    throw new LaneBaseError(
      `target ${targetRef} moved from frozen ${targetSha} to ${remoteTarget}; re-resolve before dispatch.`,
    );

  const previousHeadSha = (
    await git(input.repositoryRoot, ["rev-parse", "HEAD^{commit}"], input.signal)
  ).toLowerCase();
  const initialized = previousHeadSha !== targetSha;
  if (initialized)
    await git(input.repositoryRoot, ["reset", "--hard", targetSha], input.signal);

  const currentHeadSha = (
    await git(input.repositoryRoot, ["rev-parse", "HEAD^{commit}"], input.signal)
  ).toLowerCase();
  const finalStatus = await git(
    input.repositoryRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    input.signal,
  );
  if (currentHeadSha !== targetSha || finalStatus)
    throw new LaneBaseError("managed worktree base initialization did not finish cleanly.");

  return {
    schema: "forgedock.lane-base/v1",
    branch,
    targetRef,
    targetSha,
    previousHeadSha,
    initialized,
  };
}

/** Verify a frozen work-on PR contains only changes authorized by its lane claim. */
export async function verifyManagedLaneScope(
  input: VerifyLaneScopeInput,
): Promise<VerifiedLaneScope> {
  const targetRef = validateBranch(input.targetRef, "targetRef");
  const routeBaseRef = validateBranch(input.routeBaseRef, "routeBaseRef");
  if (routeBaseRef !== targetRef)
    throw new LaneBaseError(
      `PR base ${routeBaseRef} does not match authoritative target ${targetRef}.`,
    );
  const baseSha = validateSha(input.baseSha);
  const headSha = validateSha(input.headSha);
  const actualHeadSha = (
    await git(input.repositoryRoot, ["rev-parse", "HEAD^{commit}"], input.signal)
  ).toLowerCase();
  if (actualHeadSha !== headSha)
    throw new LaneBaseError(
      `frozen head ${headSha} does not match assigned worktree HEAD ${actualHeadSha}.`,
    );
  const status = await git(
    input.repositoryRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    input.signal,
  );
  if (status)
    throw new LaneBaseError("assigned worktree is not clean at lane-scope verification.");
  await git(input.repositoryRoot, ["cat-file", "-e", `${baseSha}^{commit}`], input.signal);
  await git(input.repositoryRoot, ["cat-file", "-e", `${headSha}^{commit}`], input.signal);
  try {
    await git(
      input.repositoryRoot,
      ["merge-base", "--is-ancestor", baseSha, headSha],
      input.signal,
    );
  } catch {
    throw new LaneBaseError(
      `frozen lane base ${baseSha} is not an ancestor of head ${headSha}.`,
    );
  }
  const changedOutput = await git(
    input.repositoryRoot,
    ["diff", "--name-only", "--diff-filter=ACMRD", `${baseSha}...${headSha}`],
    input.signal,
  );
  const changedPaths = changedOutput ? changedOutput.split("\n") : [];
  const manifestPath = "specs/original/SHA256SUMS";
  const manifest = await readFile(join(input.repositoryRoot, manifestPath), "utf8");
  const trackedOriginalPaths = new Set(
    manifest
      .trim()
      .split("\n")
      .map((line) => line.match(/^[a-f0-9]{64}  (.+)$/)?.[1])
      .filter((path): path is string => Boolean(path)),
  );
  if (
    changedPaths.some((path) => trackedOriginalPaths.has(path)) &&
    !changedPaths.includes(manifestPath)
  ) {
    throw new LaneBaseError(
      `${manifestPath} must change with manifest-tracked original specifications.`,
    );
  }
  try {
    assertBuilderContractPaths(
      createBuilderPathContract(input.claimedPaths),
      changedPaths,
    );
  } catch (error) {
    throw new LaneBaseError(
      error instanceof Error
        ? `lane diff violates the final claim: ${error.message}`
        : "lane diff violates the final claim.",
    );
  }
  return {
    schema: "forgedock.lane-scope/v1",
    targetRef,
    baseSha,
    headSha,
    changedPaths,
  };
}
