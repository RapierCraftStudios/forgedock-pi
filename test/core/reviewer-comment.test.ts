import assert from "node:assert/strict";
import test from "node:test";

import type { ForgeReviewerResult } from "../../src/agents/contracts.ts";
import {
  renderReviewerComment,
  reviewerCommentMarker,
  reviewerCommentMatchesResult,
} from "../../src/core/reviewer-comment.ts";

const result: ForgeReviewerResult = {
  schema: "forgedock.reviewer-result/v1",
  runId: "run-1",
  reviewer: "forge-review-security",
  headSha: "head-1234567",
  verdict: "findings",
  summary: "The frozen security patch was traced through its changed boundary.",
  evidence: ["src/auth.ts:10 — request reaches the changed boundary — traced"],
  findings: [
    {
      id: "SEC-1",
      reviewer: "forge-review-security",
      runId: "run-1",
      headSha: "head-1234567",
      confidence: "confirmed",
      severity: "high",
      category: "security",
      file: "src/auth.ts",
      line: 10,
      summary: "Changed boundary accepts an unsafe value",
      evidence: ["The value reaches the sink without validation."],
      reviewerBlockView: "blocking",
      reviewerBlockRationale: "The sink is reachable from production input.",
      reviewerScope: "patch-caused",
      reviewerScopeRationale: "The validation branch is new in this patch.",
    },
  ],
  filesReviewed: ["src/auth.ts"],
  limitations: [],
};

test("reviewer comment is exact-head and round bound", () => {
  const body = renderReviewerComment(result, 2);
  assert.match(body, /FORGE:REVIEW-AGENT:security/);
  assert.match(body, /run=run-1 domain=security round=2 head=head-1234567/);
  assert.match(body, /Reviewer block view: blocking/);
  assert.match(body, /Reviewer scope: patch-caused/);
  assert.equal(reviewerCommentMatchesResult(body, result, 2), true);
  assert.equal(reviewerCommentMatchesResult(body, result, 1), false);
  assert.match(
    reviewerCommentMarker("run-1", result.reviewer, 2, result.headSha),
    /FORGE:REVIEW-AGENT:security/,
  );
});
