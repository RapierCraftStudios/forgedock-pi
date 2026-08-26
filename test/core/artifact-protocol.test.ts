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
  workflowLabelForCheckpoint,
  WORKFLOW_LABEL_BY_STAGE,
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

test("workflow checkpoint mapping covers child and parent lifecycle boundaries", () => {
  const starts = [
    ["investigate", WORKFLOW_LABEL_BY_STAGE.investigation],
    ["plan", WORKFLOW_LABEL_BY_STAGE.build],
    ["prepare-worktree", WORKFLOW_LABEL_BY_STAGE.build],
    ["implement", WORKFLOW_LABEL_BY_STAGE.build],
    ["verify", WORKFLOW_LABEL_BY_STAGE.build],
    ["review", WORKFLOW_LABEL_BY_STAGE.review],
    ["merge", WORKFLOW_LABEL_BY_STAGE.awaitingMerge],
  ] as const;
  for (const [phase, expected] of starts) {
    assert.equal(
      workflowLabelForCheckpoint({ phase, action: "start" }),
      expected,
    );
  }

  assert.equal(
    workflowLabelForCheckpoint({
      phase: "investigate",
      action: "complete",
      report: "**Verdict**: INVALID",
    }),
    WORKFLOW_LABEL_BY_STAGE.invalid,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "investigate", action: "complete" }),
    WORKFLOW_LABEL_BY_STAGE.readyToBuild,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "merge", action: "complete" }),
    WORKFLOW_LABEL_BY_STAGE.merged,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "verify", action: "complete" }),
    undefined,
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "merge", action: "queue" }),
    undefined,
  );
});
