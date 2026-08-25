import assert from "node:assert/strict";
import test from "node:test";

import {
  findForgeWorkOnResult,
  isForgeWorkOnResult,
} from "../../src/core/work-on-contracts.ts";

const result = {
  schema: "forgedock.work-on-result/v1",
  runId: "run-1",
  issueNumber: 4,
  status: "ready-for-merge",
  branch: "forge/issue-4-run-1",
  baseSha: "base-sha",
  headSha: "head-sha",
  changedFiles: ["src/core/work-on-contracts.ts"],
  verification: [],
  review: {
    headSha: "head-sha",
    rounds: 1,
    completedReviewers: ["forge-review-correctness", "forge-review-security"],
    reviewerResults: [],
    findings: [],
  },
  residualRisks: [],
} as const;

test("canonical work-on contract decoder accepts nested structured output", () => {
  assert.equal(isForgeWorkOnResult(result), true);
  assert.deepEqual(findForgeWorkOnResult({ details: { result } }), result);
  assert.deepEqual(findForgeWorkOnResult(JSON.stringify(result)), result);
});
