import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptanceGatePassed,
  assertWorkflowLabel,
  checkCurrentReviewAuditTrail,
  checkPostMergeAuditTrail,
  checkPreMergeAuditTrail,
  POST_MERGE_ISSUE_MARKERS,
  POST_MERGE_PR_MARKERS,
  PRE_MERGE_ISSUE_MARKERS,
  PRE_MERGE_PR_MARKERS,
  workflowLabelForPhaseBoundary,
} from "../../src/core/artifact-protocol.ts";

function comments(markers: readonly string[]): string[] {
  return markers.map((marker) => `${marker}\nbody`);
}

test("acceptance gate passes only for completed checks or explicit policy exemption", () => {
  assert.equal(
    acceptanceGatePassed({ checks: [], policyExempt: false }),
    false,
  );
  assert.equal(
    acceptanceGatePassed({ checks: [{ status: "unknown" }], policyExempt: false }),
    false,
  );
  assert.equal(
    acceptanceGatePassed({ checks: [{ status: "passed" }], policyExempt: false }),
    true,
  );
  assert.equal(
    acceptanceGatePassed({
      checks: [
        { status: "passed", required: true },
        { status: "failed", required: false },
      ],
      policyExempt: false,
    }),
    true,
  );
  assert.equal(
    acceptanceGatePassed({ checks: [], policyExempt: true }),
    true,
  );
});

test("pre-merge audit requires every canonical issue, PR, and reviewer marker", () => {
  const complete = checkPreMergeAuditTrail({
    issueComments: comments(PRE_MERGE_ISSUE_MARKERS),
    pullRequestComments: [
      ...comments(PRE_MERGE_PR_MARKERS),
      "<!-- FORGE:REVIEW-AGENT:correctness -->",
      "<!-- FORGE:REVIEW-AGENT:security -->",
    ],
    requiredReviewerDomains: ["correctness", "security"],
  });
  assert.equal(complete.valid, true);

  const missing = checkPreMergeAuditTrail({
    issueComments: [],
    pullRequestComments: [],
    requiredReviewerDomains: ["correctness", "security"],
  });
  assert.equal(missing.valid, false);
  assert.equal(
    missing.missingIssueMarkers.length,
    PRE_MERGE_ISSUE_MARKERS.length,
  );
  assert.equal(
    missing.missingPullRequestMarkers.length,
    PRE_MERGE_PR_MARKERS.length,
  );
  assert.deepEqual(missing.missingReviewerDomains, ["correctness", "security"]);
});

test("current review audit rejects stale heads, rounds, and missing domains", () => {
  const reviewer = (domain: string, round: number, head: string) =>
    `<!-- FORGE:REVIEW-INSTANCE run=run-1 domain=${domain} round=${round} head=${head} -->\n<!-- FORGE:REVIEW-AGENT:${domain} -->`;
  const summary = (round: number, head: string) =>
    `<!-- FORGE:REVIEW-SUMMARY-INSTANCE run=run-1 round=${round} head=${head} -->\n<!-- FORGE:REVIEW_SUMMARY -->`;
  const current = checkCurrentReviewAuditTrail({
    pullRequestComments: [
      reviewer("correctness", 1, "old-head"),
      reviewer("security", 1, "old-head"),
      summary(1, "old-head"),
      reviewer("correctness", 2, "new-head"),
      reviewer("security", 2, "new-head"),
      summary(2, "new-head"),
    ],
    expectedRunId: "run-1",
    expectedHeadSha: "new-head",
    expectedRound: 2,
    requiredReviewerDomains: ["correctness", "security"],
  });
  assert.equal(current.valid, true);

  const incomplete = checkCurrentReviewAuditTrail({
    pullRequestComments: [
      reviewer("correctness", 1, "old-head"),
      reviewer("security", 1, "old-head"),
      summary(1, "old-head"),
      reviewer("correctness", 2, "new-head"),
    ],
    expectedRunId: "run-1",
    expectedHeadSha: "new-head",
    expectedRound: 2,
    requiredReviewerDomains: ["correctness", "security"],
  });
  assert.equal(incomplete.valid, false);
  assert.deepEqual(incomplete.missingReviewerDomains, ["security"]);
  assert.equal(incomplete.missingSummary, true);
});

test("post-merge audit requires trajectory, card, and decision record", () => {
  assert.equal(
    checkPostMergeAuditTrail({
      issueComments: comments(POST_MERGE_ISSUE_MARKERS),
      pullRequestComments: comments(POST_MERGE_PR_MARKERS),
    }).valid,
    true,
  );
  assert.equal(
    checkPostMergeAuditTrail({ issueComments: [], pullRequestComments: [] })
      .valid,
    false,
  );
});

test("workflow labels are exact stage projections", () => {
  assert.doesNotThrow(() =>
    assertWorkflowLabel("workflow:in-review", "review"),
  );
  assert.throws(
    () => assertWorkflowLabel("workflow:investigating", "review"),
    /workflow:in-review/,
  );
});

test("canonical phase boundaries cover the complete workflow label lifecycle", () => {
  const lifecycle = [
    ["resolve", "started", "workflow:investigating"],
    ["resolve", "completed", "workflow:investigating"],
    ["investigate", "started", "workflow:investigating"],
    ["investigate", "completed", "workflow:ready-to-build"],
    ["plan", "started", "workflow:building"],
    ["prepare-worktree", "completed", "workflow:building"],
    ["implement", "completed", "workflow:building"],
    ["verify", "completed", "workflow:building"],
    ["prepare-pr", "started", "workflow:in-review"],
    ["review", "completed", "workflow:in-review"],
    ["decision", "completed", "workflow:awaiting-merge"],
    ["merge", "started", "workflow:awaiting-merge"],
    ["merge", "completed", "workflow:merged"],
  ] as const;
  for (const [phase, transition, expected] of lifecycle)
    assert.equal(
      workflowLabelForPhaseBoundary(
        phase,
        transition,
        phase === "decision"
          ? "awaiting-merge"
          : phase === "merge"
            ? transition === "completed"
              ? "merged"
              : undefined
            : undefined,
      ),
      expected,
    );
  assert.equal(
    workflowLabelForPhaseBoundary("investigate", "completed", "invalid"),
    "workflow:invalid",
  );
  assert.equal(
    workflowLabelForPhaseBoundary("investigate", "completed", "decomposed"),
    "workflow:decomposed",
  );
});
