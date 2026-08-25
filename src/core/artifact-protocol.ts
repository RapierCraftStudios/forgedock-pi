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

export const ACCEPTANCE_GATE_SUCCESS_MARKER =
  "<!-- FORGE:ACCEPTANCE_GATE:COMPLETE -->" as const;

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
  ACCEPTANCE_GATE_SUCCESS_MARKER,
  "<!-- FORGE:REVIEW_STARTED -->",
] as const;

export const PRE_MERGE_PR_MARKERS = [
  "<!-- FORGE:REVIEW_ROUTE",
  "<!-- REVIEW-FINDINGS-START -->",
  "<!-- REVIEW-FINDINGS-END -->",
] as const;

export const REVIEW_DECISION_PR_MARKERS = [
  "<!-- FORGE:REVIEW -->",
  "<!-- FORGE:REVIEW_SUMMARY -->",
] as const;

export const POST_MERGE_ISSUE_MARKERS = [
  "<!-- FORGE:TRAJECTORY -->",
  "<!-- FORGE:CARD:",
] as const;

export const POST_MERGE_PR_MARKERS = [
  "<!-- FORGE:DECISION_RECORD -->",
] as const;

export interface CurrentReviewAuditInput {
  pullRequestComments: readonly string[];
  expectedRunId: string;
  expectedHeadSha: string;
  expectedRound: number;
  requiredReviewerDomains: readonly string[];
}

export interface CurrentReviewAuditCheck {
  valid: boolean;
  missingReviewerDomains: readonly string[];
  duplicateReviewerDomains: readonly string[];
  missingSummary: boolean;
}

export function checkCurrentReviewAuditTrail(
  input: CurrentReviewAuditInput,
): CurrentReviewAuditCheck {
  const matchingDomains = new Map<string, number>();
  let summaryCount = 0;
  for (const comment of input.pullRequestComments) {
    for (const match of comment.matchAll(
      /<!-- FORGE:REVIEW-INSTANCE run=([^\s]+) domain=([^\s]+) round=(\d+) head=([^\s]+) -->/g,
    )) {
      const [, runId, domain, round, headSha] = match;
      if (
        runId !== input.expectedRunId ||
        Number(round) !== input.expectedRound ||
        headSha !== input.expectedHeadSha ||
        !domain ||
        !comment.includes(`<!-- FORGE:REVIEW-AGENT:${domain} -->`)
      )
        continue;
      matchingDomains.set(domain, (matchingDomains.get(domain) ?? 0) + 1);
    }
    const summaryMarker = `<!-- FORGE:REVIEW-SUMMARY-INSTANCE run=${input.expectedRunId} round=${input.expectedRound} head=${input.expectedHeadSha} -->`;
    if (
      comment.includes(summaryMarker) &&
      comment.includes("<!-- FORGE:REVIEW_SUMMARY -->")
    )
      summaryCount += 1;
  }
  const missingReviewerDomains = input.requiredReviewerDomains.filter(
    (domain) => (matchingDomains.get(domain) ?? 0) === 0,
  );
  const duplicateReviewerDomains = input.requiredReviewerDomains.filter(
    (domain) => (matchingDomains.get(domain) ?? 0) > 1,
  );
  return {
    valid:
      missingReviewerDomains.length === 0 &&
      duplicateReviewerDomains.length === 0 &&
      summaryCount === 1,
    missingReviewerDomains,
    duplicateReviewerDomains,
    missingSummary: summaryCount !== 1,
  };
}

export function acceptanceGatePassed(input: {
  checks: readonly {
    status: "passed" | "failed" | "unknown";
    required?: boolean;
  }[];
  policyExempt: boolean;
}): boolean {
  if (input.policyExempt) return true;
  const required = input.checks.filter((check) => check.required !== false);
  // A configured CI policy cannot pass on an empty, pending, or failed read.
  return (
    required.length > 0 && required.every((check) => check.status === "passed")
  );
}

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
  // COMPLETE is the sole successful wire marker. A legacy PASSED marker, or a
  // gate body that records a failed/unknown required check, must not satisfy audit.
  if (
    issueBody.includes("<!-- FORGE:ACCEPTANCE_GATE:PASSED -->") ||
    (issueBody.includes("<!-- FORGE:ACCEPTANCE_GATE -->") &&
      issueBody.includes(ACCEPTANCE_GATE_SUCCESS_MARKER) &&
      /:\s*(failed|unknown|pending|skipped|not-configured)\s*\(required\)/i.test(
        issueBody,
      ))
  )
    missingIssueMarkers.push(ACCEPTANCE_GATE_SUCCESS_MARKER);
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

export function checkReviewDecisionAuditTrail(input: {
  pullRequestComments: readonly string[];
}): readonly string[] {
  const pullBody = input.pullRequestComments.join("\n");
  return REVIEW_DECISION_PR_MARKERS.filter(
    (marker) => !pullBody.includes(marker),
  );
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
