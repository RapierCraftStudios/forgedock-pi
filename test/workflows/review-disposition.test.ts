import assert from "node:assert/strict";
import test from "node:test";

import type { ForgeReviewerResult } from "../../src/agents/contracts.ts";
import {
  collateWorkOnReview,
  findingBehaviorKey,
} from "../../src/workflows/review-disposition.ts";

function reviewer(
  name: string,
  findings: ForgeReviewerResult["findings"],
): ForgeReviewerResult {
  return {
    schema: "forgedock.reviewer-result/v1",
    runId: "run-1",
    reviewer: name,
    headSha: "head-1234567",
    verdict: findings.length ? "findings" : "pass",
    summary: `Reviewed ${name}.`,
    evidence: [`src/example.ts:10 — traced ${name} behavior — complete`],
    findings,
    filesReviewed: ["src/example.ts"],
    limitations: [],
  };
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: "F-1",
    reviewer: "forge-review-correctness",
    runId: "run-1",
    headSha: "head-1234567",
    confidence: "confirmed" as const,
    severity: "high" as const,
    category: "correctness" as const,
    file: "src/example.ts",
    line: 10,
    summary: "Changed path can return an invalid result",
    evidence: ["The changed branch reaches the invalid result."],
    reviewerBlockView: "blocking" as const,
    reviewerBlockRationale: "The invalid result reaches production callers.",
    reviewerScope: "patch-caused" as const,
    reviewerScopeRationale: "The branch was introduced by this patch.",
    ...overrides,
  };
}

test("parent collation deduplicates equivalent findings and keeps reviewer disagreement", () => {
  const result = collateWorkOnReview([
    reviewer("forge-review-correctness", [finding()]),
    reviewer("forge-review-security", [
      finding({
        id: "F-2",
        reviewer: "forge-review-security",
        reviewerBlockView: "advisory",
        reviewerBlockRationale: "The caller currently masks the result.",
      }),
    ]),
  ]);

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0]?.sourceFindings.length, 2);
  assert.deepEqual(result.decisions[0]?.reviewers, [
    "forge-review-correctness",
    "forge-review-security",
  ]);
  assert.equal(result.decisions[0]?.disposition, "blocking");
  assert.equal(result.blocking.length, 1);
  assert.equal(result.followUps.length, 0);
  assert.equal(
    findingBehaviorKey(finding({ line: 9 })),
    findingBehaviorKey(finding({ id: "F-2", line: 10 })),
  );
});

test("parent classification keeps pre-existing and out-of-scope findings out of remediation", () => {
  const result = collateWorkOnReview([
    reviewer("forge-review-correctness", [
      finding({
        id: "PRE-1",
        reviewerScope: "pre-existing",
        reviewerScopeRationale: "The same behavior exists on the base head.",
      }),
      finding({
        id: "OUT-1",
        file: "docs/other.md",
        summary: "Unrelated documentation debt",
        reviewerScope: "out-of-scope",
        reviewerScopeRationale: "This is unrelated documentation debt.",
      }),
      finding({
        id: "ADV-1",
        line: 20,
        confidence: "possible",
        reviewerBlockView: "advisory",
        reviewerBlockRationale: "The trigger was not reproducible.",
      }),
      finding({
        id: "FOLLOW-1",
        line: 30,
        confidence: "likely",
        reviewerBlockView: "advisory",
        reviewerBlockRationale: "The behavior is degraded but merge-safe.",
      }),
    ]),
  ]);

  assert.deepEqual(result.preExisting.map((entry) => entry.id), ["PRE-1"]);
  assert.deepEqual(result.outOfScope.map((entry) => entry.id), ["OUT-1"]);
  assert.deepEqual(result.advisories.map((entry) => entry.id), ["ADV-1"]);
  assert.deepEqual(result.followUps.map((entry) => entry.id), ["FOLLOW-1"]);
  assert.deepEqual(result.blocking, []);
});
