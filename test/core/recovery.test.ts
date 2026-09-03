import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReviewerFailure,
  extendedReviewerTimeout,
  planReviewRecovery,
  reviewerEvidenceKey,
  validateReviewDeadlines,
  validateReviewerPanel,
} from "../../src/core/recovery.ts";
import type { ForgeReviewerResult } from "../../src/agents/contracts.ts";

function result(reviewer: string, headSha = "head-1234567"): ForgeReviewerResult {
  return {
    schema: "forgedock.reviewer-result/v1",
    runId: "review-1",
    reviewer,
    headSha,
    verdict: "pass",
    summary: `Reviewed ${reviewer} behavior on the frozen head.`,
    evidence: ["src/a.ts:1 — traced the assigned behavior — no regression found"],
    findings: [],
    filesReviewed: ["src/a.ts"],
    limitations: [],
  };
}

test("review evidence key binds PR head, role, and attempt", () => {
  assert.equal(reviewerEvidenceKey({ headSha: "head", reviewer: "security", attempt: 2 }), "head:security:2");
  assert.notEqual(
    reviewerEvidenceKey({ headSha: "other", reviewer: "security", attempt: 2 }),
    reviewerEvidenceKey({ headSha: "head", reviewer: "security", attempt: 2 }),
  );
});

test("a 3+1 panel recovery retains complete siblings and retries only the missing role", () => {
  const plan = planReviewRecovery({
    reviewers: ["correctness", "security", "api", "web"],
    headSha: "head-1234567",
    attempt: 1,
    completed: [result("correctness"), result("security"), result("api")],
    failures: { web: "timeout" },
    reviewerTimeoutMs: 900_000,
  });
  assert.deepEqual(plan.retained.map((entry) => entry.reviewer), ["correctness", "security", "api"]);
  assert.deepEqual(plan.retryReviewers, ["web"]);
  assert.equal(plan.synthesisAllowed, false);
  assert.equal(plan.extendedTimeoutMs, 1_800_000);
});

test("mixed head or partial reviewer panels cannot synthesize", () => {
  assert.throws(
    () => validateReviewerPanel({
      results: [result("correctness"), result("security", "other-1234567")],
      reviewers: ["correctness", "security"],
      headSha: "head-1234567",
      attempt: 1,
    }),
    /frozen panel key/,
  );
  assert.throws(
    () => validateReviewerPanel({
      results: [result("correctness")],
      reviewers: ["correctness", "security"],
      headSha: "head-1234567",
      attempt: 1,
    }),
    /incomplete/,
  );
});

test("review failure classes and deadline guard remain distinct", () => {
  assert.equal(classifyReviewerFailure(new Error("reviewer timed out")), "timeout");
  assert.equal(classifyReviewerFailure(new Error("provider inactivity")), "provider-inactivity");
  const controller = new AbortController();
  controller.abort(new Error("operator cancelled"));
  assert.equal(classifyReviewerFailure(controller.signal.reason, controller.signal), "cancelled");
  assert.equal(classifyReviewerFailure(new Error("terminated by parent")), "parent-termination");
  assert.equal(extendedReviewerTimeout(2_000_000), 1_800_000);
  assert.throws(
    () => validateReviewDeadlines({ reviewerTimeoutMs: 1000, parentTimeoutMs: 1100, joinGraceMs: 200 }),
    /Unsafe deadline/,
  );
  validateReviewDeadlines({ reviewerTimeoutMs: 1000 });
});
