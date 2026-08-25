export const FORGE_WORK_ON_AGENT = "forge-work-on";
export const FORGE_REVIEW_CORRECTNESS_AGENT = "forge-review-correctness";
export const FORGE_REVIEW_SECURITY_AGENT = "forge-review-security";

export const FORGE_REVIEW_TOOLS = ["read", "grep", "find", "ls"] as const;
export const FORGE_WORK_ON_TOOLS = [
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "subagent",
  "forge_checkpoint",
  "forge_verify",
  "forge_diff",
  "forge_commit",
  "forge_prepare_review",
  "forge_finalize_work_on",
] as const;
export const FORGE_WORK_ON_MAX_DEPTH = 2;
