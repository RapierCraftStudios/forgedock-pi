import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReviewLaunchReservation,
  claimReviewContinuation,
  classifyReviewerFailure,
  computeReviewLaunchReservation,
  extendedReviewerTimeout,
  planReviewRecovery,
  recordReviewLaunch,
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
    findings: [],
    filesReviewed: ["src/a.ts"],
    limitations: [],
  };
}

test("review reservation covers all rounds and transient retries before launch", () => {
  const reservation = computeReviewLaunchReservation({
    reviewers: ["correctness", "security"],
    maxReviewRounds: 3,
  });
  assert.equal(reservation.planned, 18);
  assert.equal(reservation.observed, 0);
  assert.equal(reservation.remaining, 18);
  assert.doesNotThrow(() => assertReviewLaunchReservation(reservation, 18));
  assert.throws(() => assertReviewLaunchReservation(reservation, 17), /cannot be satisfied/);
  const afterPanel = recordReviewLaunch(reservation, 2);
  assert.equal(afterPanel.observed, 2);
  assert.equal(afterPanel.reserved, 16);
  assert.equal(afterPanel.remaining, 16);
  assert.throws(() => recordReviewLaunch(afterPanel, 17), /exhausted/);
});

test("review continuation is single-claim and waits for old children", () => {
  const handoff = {
    schema: "forgedock.review-continuation/v1" as const,
    continuationId: "review-continuation-1",
    previousRunIds: ["child-a", "child-b"],
    previousHeadSha: "old-head-1234567",
    headSha: "new-head-1234567",
    remediationCommitSha: "remediation-1234567",
    oldChildrenSettled: true,
    claimed: false,
  };
  assert.equal(claimReviewContinuation(handoff).claimed, true);
  assert.throws(
    () => claimReviewContinuation({ ...handoff, oldChildrenSettled: false }),
    /active/,
  );
  assert.throws(() => claimReviewContinuation({ ...handoff, claimed: true }), /already claimed/);
});

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
