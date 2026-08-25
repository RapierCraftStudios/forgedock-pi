export const WORKFLOW_LABEL_BY_STAGE = {
  investigation: "workflow:investigating",
  readyToBuild: "workflow:ready-to-build",
  build: "workflow:building",
  review: "workflow:in-review",
  awaitingMerge: "workflow:awaiting-merge",
  merged: "workflow:merged",
  invalid: "workflow:invalid",
  decomposed: "workflow:decomposed",
} as const;

export const PRE_MERGE_ISSUE_MARKERS = [
  "<!-- FORGE:INVESTIGATOR -->",
  "<!-- INVESTIGATION:COMPLETE -->",
  "<!-- FORGE:FAST_PATH -->",
  "<!-- FORGE:CONTRACT -->",
  "<!-- FORGE:CONTEXT -->",
  "<!-- FORGE:CONTEXT:COMPLETE -->",
  "<!-- FORGE:ARCHITECT -->",
  "<!-- FORGE:ARCHITECT:COMPLETE -->",
  "<!-- FORGE:BUILDER -->",
  "<!-- FORGE:BUILDER:COMPLETE -->",
  "<!-- FORGE:ACCEPTANCE_GATE -->",
  "<!-- FORGE:ACCEPTANCE_GATE:PASSED -->",
  "<!-- FORGE:REVIEW_STARTED -->",
] as const;

export const BUILDER_CONTRACT_MARKERS = [
  "<!-- FORGE:CONTRACT:JSON -->",
  "<!-- FORGE:CONTRACT:JSON:END -->",
] as const;

export const BUILDER_CONTRACT_REVISION_MARKER =
  "<!-- FORGE:CONTRACT_REVISION -->" as const;

export const PRE_MERGE_PR_MARKERS = [
  "<!-- FORGE:REVIEW_ROUTE",
  "<!-- FORGE:REVIEW -->",
  "<!-- FORGE:REVIEW_SUMMARY -->",
  "<!-- REVIEW-FINDINGS-START -->",
  "<!-- REVIEW-FINDINGS-END -->",
] as const;

export const POST_MERGE_ISSUE_MARKERS = [
  "<!-- FORGE:TRAJECTORY -->",
  "<!-- FORGE:CARD:",
] as const;

export const POST_MERGE_PR_MARKERS = [
  "<!-- FORGE:DECISION_RECORD -->",
] as const;

export interface AuditTrailCheck {
  valid: boolean;
  missingIssueMarkers: readonly string[];
  missingPullRequestMarkers: readonly string[];
  missingReviewerDomains: readonly string[];
}

export function checkPreMergeAuditTrail(input: {
  issueComments: readonly string[];
  pullRequestComments: readonly string[];
  requiredReviewerDomains: readonly string[];
}): AuditTrailCheck {
  const issueBody = input.issueComments.join("\n");
  const pullBody = input.pullRequestComments.join("\n");
  const missingIssueMarkers = PRE_MERGE_ISSUE_MARKERS.filter(
    (marker) => !issueBody.includes(marker),
  );
  const missingPullRequestMarkers = PRE_MERGE_PR_MARKERS.filter(
    (marker) => !pullBody.includes(marker),
  );
  const missingReviewerDomains = input.requiredReviewerDomains.filter(
    (domain) => !pullBody.includes(`<!-- FORGE:REVIEW-AGENT:${domain} -->`),
  );
  return {
    valid:
      missingIssueMarkers.length === 0 &&
      missingPullRequestMarkers.length === 0 &&
      missingReviewerDomains.length === 0,
    missingIssueMarkers,
    missingPullRequestMarkers,
    missingReviewerDomains,
  };
}

export function checkPostMergeAuditTrail(input: {
  issueComments: readonly string[];
  pullRequestComments: readonly string[];
}): AuditTrailCheck {
  const issueBody = input.issueComments.join("\n");
  const pullBody = input.pullRequestComments.join("\n");
  const missingIssueMarkers = POST_MERGE_ISSUE_MARKERS.filter(
    (marker) => !issueBody.includes(marker),
  );
  const missingPullRequestMarkers = POST_MERGE_PR_MARKERS.filter(
    (marker) => !pullBody.includes(marker),
  );
  return {
    valid:
      missingIssueMarkers.length === 0 &&
      missingPullRequestMarkers.length === 0,
    missingIssueMarkers,
    missingPullRequestMarkers,
    missingReviewerDomains: [],
  };
}

export function assertWorkflowLabel(
  label: string,
  expectedStage: keyof typeof WORKFLOW_LABEL_BY_STAGE,
): void {
  const expected = WORKFLOW_LABEL_BY_STAGE[expectedStage];
  if (label !== expected)
    throw new Error(`Expected workflow label ${expected}, received ${label}.`);
}
