import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateReviewGate,
  findingBlocksMerge,
  HUMAN_AUTHORITY_REASONS,
  type ReviewFinding,
  type ReviewGateInput,
} from "../../src/core/review.ts";

const identity = {
  repository: "owner/repo",
  runId: "run-1",
  pullRequest: 42,
  headSha: "head",
  baseSha: "base",
  rosterVersion: "v1",
};

function input(overrides: Partial<ReviewGateInput> = {}): ReviewGateInput {
  return {
    identity,
    currentHeadSha: "head",
    currentBaseSha: "base",
    requiredReviewers: ["correctness", "security"],
    completedReviewers: ["correctness", "security"],
    findings: [],
    checks: [{ name: "test", required: true, status: "passed", exitCode: 0 }],
    mergeability: "mergeable",
    leaseValid: true,
    baseBranch: "staging",
    protectedBranches: ["main"],
    autoMergeAuthorized: true,
    ...overrides,
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "SEC-1",
    reviewer: "security",
    runId: "run-1",
    headSha: "head",
    confidence: "confirmed",
    severity: "high",
    category: "security",
    file: "src/auth.ts",
    line: 12,
    summary: "authorization bypass",
    evidence: ["request reaches handler without policy check"],
    ...overrides,
  };
}

test("clean integration review is approved", () => {
  assert.deepEqual(evaluateReviewGate(input()), {
    headSha: "head",
    baseSha: "base",
    decision: "approved",
    blockingFindingIds: [],
    followUpFindingIds: [],
    checkResults: [{ name: "test", required: true, status: "passed", exitCode: 0 }],
    reasons: [],
  });
});

test("stale SHA, incomplete panel, and unknown required checks block", () => {
  const result = evaluateReviewGate(
    input({
      currentHeadSha: "new-head",
      completedReviewers: ["security"],
      checks: [{ name: "test", required: true, status: "unknown" }],
    }),
  );
  assert.equal(result.decision, "blocked");
  assert.equal(result.reasons.length, 3);
});

test("blocking findings request changes while likely findings do not", () => {
  const confirmed = finding();
  const likely = finding({
    id: "SEC-2",
    confidence: "likely",
    severity: "critical",
  });
  assert.equal(findingBlocksMerge(confirmed), true);
  assert.equal(findingBlocksMerge(likely), false);
  assert.equal(
    evaluateReviewGate(input({ findings: [confirmed] })).decision,
    "changes-requested",
  );
  assert.equal(
    evaluateReviewGate(input({ findings: [likely] })).decision,
    "approved-with-follow-ups",
  );
});

test("verification distinguishes absent, unconfigured, and policy-exempt suites", () => {
  assert.equal(evaluateReviewGate(input({ checks: [] })).decision, "blocked");
  assert.equal(
    evaluateReviewGate(
      input({
        checks: [
          { name: "github:dogfood", required: true, status: "not-configured" },
        ],
      }),
    ).decision,
    "blocked",
  );
  const exempt = evaluateReviewGate(
    input({
      checks: [
        { name: "local verification", required: false, status: "not-configured" },
        { name: "github:staging", required: false, status: "policy-exempt" },
      ],
    }),
  );
  assert.equal(exempt.decision, "approved");
  assert.equal(exempt.checkResults[1]?.status, "policy-exempt");
});

test("protected branches always require a human", () => {
  const result = evaluateReviewGate(
    input({ baseBranch: "main", autoMergeAuthorized: true }),
  );
  assert.equal(result.decision, "needs-human");
});

test("disabled auto-merge is a blocked policy mismatch, not human authority", () => {
  const result = evaluateReviewGate(input({ autoMergeAuthorized: false }));
  assert.equal(result.decision, "blocked");
  assert.ok(result.reasons.some((reason) => reason.includes("staging")));
});

test("human decisions carry only typed high-level authority reasons", () => {
  const result = evaluateReviewGate(
    input({
      humanAuthorityRequests: [
        { reason: "product-decision", detail: "Product decision is required." },
      ],
    }),
  );
  assert.equal(result.decision, "needs-human");
  assert.deepEqual(result.authorityReasons, ["product-decision"]);
  assert.deepEqual(HUMAN_AUTHORITY_REASONS, [
    "product-decision",
    "legal-approval",
    "external-credential",
    "physical-authority",
  ]);
});
