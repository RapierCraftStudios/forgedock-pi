import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkflowLabel,
  checkPostMergeAuditTrail,
  checkPreMergeAuditTrail,
  POST_MERGE_ISSUE_MARKERS,
  WORKFLOW_LABEL_BY_STAGE,
  workflowLabelForCheckpoint,
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

test("checkpoint labels cover the complete workflow lifecycle", () => {
  assert.equal(
    workflowLabelForCheckpoint({ phase: "resolve", action: "start" }),
    WORKFLOW_LABEL_BY_STAGE.investigation,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "investigate", action: "start" }),
    WORKFLOW_LABEL_BY_STAGE.investigation,
  );
  assert.equal(
    workflowLabelForCheckpoint({
      phase: "investigate",
      action: "complete",
      report: "**Verdict**: CONFIRMED",
    }),
    WORKFLOW_LABEL_BY_STAGE.readyToBuild,
  );
  assert.equal(
    workflowLabelForCheckpoint({
      phase: "investigate",
      action: "complete",
      report: "**Verdict**: INVALID",
    }),
    WORKFLOW_LABEL_BY_STAGE.invalid,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "plan", action: "start" }),
    WORKFLOW_LABEL_BY_STAGE.build,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "verify", action: "complete" }),
    WORKFLOW_LABEL_BY_STAGE.build,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "review", action: "start" }),
    WORKFLOW_LABEL_BY_STAGE.review,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "review", action: "complete" }),
    WORKFLOW_LABEL_BY_STAGE.review,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "merge", action: "start" }),
    WORKFLOW_LABEL_BY_STAGE.awaitingMerge,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "merge", action: "complete" }),
    WORKFLOW_LABEL_BY_STAGE.merged,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "merge", action: "queue" }),
    undefined,
  );
});
