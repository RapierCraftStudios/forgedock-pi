/// <reference types="node" />
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
    findings: [],
    filesReviewed: ["src/a.ts"],
    limitations: [],
  };
}

test("review panel validates parent deadline hierarchy", () => {
  assert.throws(
    () => validateReviewDeadlines({ reviewerTimeoutMs: 900_000, parentTimeoutMs: 900_001, joinGraceMs: 30_000 }),
    /Unsafe deadline/,
  );
  validateReviewDeadlines({ reviewerTimeoutMs: 900_000 });
});

test("review evidence key binds PR head, role, and attempt", () => {
  assert.equal(reviewerEvidenceKey({ headSha: "head", reviewer: "security", attempt: 2 }), "head:security:2");
  assert.notEqual(
    reviewerEvidenceKey({ headSha: "other", reviewer: "security", attempt: 2 }),
    reviewerEvidenceKey({ headSha: "head", reviewer: "security", attempt: 2 }),
  );
});

test("persists reviewer receipts by head role and attempt", () => {
  const first = reviewerEvidenceKey({ headSha: "head-1234567", reviewer: "security", attempt: 1 });
  const retry = reviewerEvidenceKey({ headSha: "head-1234567", reviewer: "security", attempt: 2 });
  assert.equal(first, "head-1234567:security:1");
  assert.notEqual(first, retry);
});

test("retries only missing reviewer after timeout", () => {
  const plan = planReviewRecovery({
    reviewers: ["correctness", "security"],
    headSha: "head-1234567",
    attempt: 1,
    completed: [result("correctness")],
    failures: { security: "timeout" },
    reviewerTimeoutMs: 100,
  });
  assert.deepEqual(plan.retained.map((entry) => entry.reviewer), ["correctness"]);
  assert.deepEqual(plan.retryReviewers, ["security"]);
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

test("review panel rejects partial synthesis", () => {
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

test("classifies reviewer terminal failures", () => {
  assert.equal(classifyReviewerFailure(new Error("provider inactivity")), "provider-inactivity");
  assert.equal(classifyReviewerFailure(new Error("terminated by parent")), "parent-termination");
  const controller = new AbortController();
  controller.abort(new Error("operator cancelled"));
  assert.equal(classifyReviewerFailure(controller.signal.reason, controller.signal), "cancelled");
});

test("caps reviewer recovery retries", () => {
  const plan = planReviewRecovery({
    reviewers: ["security"],
    headSha: "head-1234567",
    attempt: 1,
    completed: [],
    failures: { security: "timeout" },
    retryCountByReviewer: { security: 1 },
    maxRetries: 1,
    reviewerTimeoutMs: 100,
  });
  assert.deepEqual(plan.retryReviewers, []);
  assert.match(plan.reason ?? "", /security.*timeout.*100ms/);
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
