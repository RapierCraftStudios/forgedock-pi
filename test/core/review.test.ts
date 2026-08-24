import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateReviewGate,
  findingBlocksMerge,
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
    decision: "approved",
    blockingFindingIds: [],
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
    "approved",
  );
});

test("protected branches always require a human", () => {
  const result = evaluateReviewGate(
    input({ baseBranch: "main", autoMergeAuthorized: true }),
  );
  assert.equal(result.decision, "needs-human");
});
