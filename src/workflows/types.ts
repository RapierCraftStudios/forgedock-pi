import type { PreparedWorktree } from "../adapters/git.ts";

export interface ActiveRunLink {
  forgeRunId: string;
  subagentRunId: string;
  issueNumber: number;
  repository: string;
  stateBranch: string;
  resultPath: string;
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
