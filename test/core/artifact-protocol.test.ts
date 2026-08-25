import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkflowLabel,
  checkPostMergeAuditTrail,
  checkPreMergeAuditTrail,
  POST_MERGE_ISSUE_MARKERS,
  POST_MERGE_PR_MARKERS,
  PRE_MERGE_ISSUE_MARKERS,
  PRE_MERGE_PR_MARKERS,
} from "../../src/core/artifact-protocol.ts";

function comments(markers: readonly string[]): string[] {
  return markers.map((marker) => `${marker}\nbody`);
}

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

test("pre-merge audit can scope markers to the current run", () => {
  const runId = "run-current";
  const currentMarker = `<!-- FORGEDOCK-RUN:${runId} -->`;
  const complete = checkPreMergeAuditTrail({
    issueComments: comments(PRE_MERGE_ISSUE_MARKERS).map(
      (body) => `${currentMarker}\n${body}`,
    ),
    pullRequestComments: [
      ...comments(PRE_MERGE_PR_MARKERS).map(
        (body) => `${currentMarker}\n${body}`,
      ),
      `${currentMarker}\n<!-- FORGE:REVIEW-AGENT:correctness -->`,
      `${currentMarker}\n<!-- FORGE:REVIEW-AGENT:security -->`,
    ],
    requiredReviewerDomains: ["correctness", "security"],
    runId,
  });
  assert.equal(complete.valid, true);
  const stale = checkPreMergeAuditTrail({
    issueComments: comments(PRE_MERGE_ISSUE_MARKERS),
    pullRequestComments: comments(PRE_MERGE_PR_MARKERS),
    requiredReviewerDomains: ["correctness", "security"],
    runId,
  });
  assert.equal(stale.valid, false);
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
