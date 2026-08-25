import type { PreparedWorktree } from "../adapters/git.ts";
import type { ForgePolicy } from "../core/policy.ts";

export interface ActiveRunLink {
  forgeRunId: string;
  subagentRunId: string;
  issueNumber: number;
  repository: string;
  stateBranch: string;
  resultPath: string;
  /** Epoch bound when the run acquired its durable repository lease. */
  leaseEpoch?: number;
  /** Trusted policy snapshot captured before the child is launched. */
  policy?: ForgePolicy;
  prepared: PreparedWorktree;
  status: "running" | "completed" | "failed";
}

export interface StartIssueResult {
  runId: string;
  subagentRunId: string;
  issueNumber: number;
  worktreePath: string;
  branch: string;
}
