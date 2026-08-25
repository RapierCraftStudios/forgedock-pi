import assert from "node:assert/strict";
import test from "node:test";

import {
  FINALIZATION_STAGES,
  isFinalizationMergeApproved,
  renderPullRequestBody,
} from "../../src/workflows/finalization.ts";
import type { ActiveRunLink } from "../../src/workflows/types.ts";
import type { ForgeWorkOnResult } from "../../src/core/agent-contracts.ts";

test("finalization exposes an explicit auditable stage order", () => {
  assert.deepEqual([...FINALIZATION_STAGES], [
    "push",
    "pull-request",
    "audit",
    "merge",
    "close",
    "cleanup",
    "terminal",
  ]);
  assert.equal(isFinalizationMergeApproved({ decision: "approved" }), true);
  assert.equal(isFinalizationMergeApproved({ decision: "blocked" }), false);
});

test("pull request body preserves child evidence and review identity", () => {
  const result: ForgeWorkOnResult = {
    schema: "forgedock.work-on-result/v1",
    runId: "run-finalization",
    issueNumber: 4,
    status: "ready-for-merge",
    branch: "forge/issue-4-run-finalization",
    baseSha: "base-sha-123456",
    headSha: "head-sha-123456",
    changedFiles: ["src/example.ts"],
    verification: [{ name: "test", status: "passed", exitCode: 0 }],
    review: {
      headSha: "head-sha-123456",
      rounds: 1,
      completedReviewers: ["forge-review-correctness", "forge-review-security"],
      reviewerResults: [],
      findings: [],
    },
    residualRisks: [],
  };
  const link: ActiveRunLink = {
    forgeRunId: result.runId,
    subagentRunId: "subagent-finalization",
    issueNumber: result.issueNumber,
    repository: "owner/repository",
    stateBranch: "forgedock/state/v1",
    resultPath: ".pi/forge/result.json",
    prepared: {
      repositoryRoot: "/repo",
      worktreePath: "/repo/.forge/worktrees/run-finalization",
      branch: result.branch,
      baseBranch: "staging",
      baseSha: result.baseSha,
    },
    status: "running",
  };
  const body = renderPullRequestBody(link, result);
  assert.match(body, /Implements #4/);
  assert.match(body, /`src\/example\.ts`/);
  assert.match(body, /\[x\] test: passed/);
  assert.match(body, /Frozen head: `head-sha-123456`/);
});
