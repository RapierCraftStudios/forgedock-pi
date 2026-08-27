import { createHash } from "node:crypto";

import type { GitHubWorkflowAdapter } from "../adapters/github-workflow.ts";
import type { ForgeReviewFindingResult } from "../agents/contracts.ts";
import {
  humanAuthorityReasonFromText,
  type HumanAuthorityReason,
} from "../core/policy.ts";

export interface ReviewFindingRunIdentity {
  forgeRunId: string;
  issueNumber?: number;
  repository?: string;
}

export interface ReviewFindingProjectionResult {
  review: {
    headSha: string;
    findings: readonly ForgeReviewFindingResult[];
  };
}

/** Classify only explicit high-level authority language as human-owned. */
export function reviewFindingAuthorityReason(
  finding: ForgeReviewFindingResult,
): HumanAuthorityReason | undefined {
  return humanAuthorityReasonFromText(
    `${finding.category} ${finding.summary} ${finding.evidence.join(" ")}`,
  );
}

export async function publishReviewFindingIssues(input: {
  github: GitHubWorkflowAdapter;
  pullNumber: number;
  link: ReviewFindingRunIdentity;
  result: ReviewFindingProjectionResult;
  signal?: AbortSignal;
}): Promise<Record<string, number>> {
  const existing = await input.github.listIssuesByLabel(
    "review-finding",
    "all",
    input.signal,
  );
  const issueMap: Record<string, number> = {};
  for (const finding of input.result.review.findings) {
    const marker = reviewFindingMarker(
      input.pullNumber,
      finding.id,
      input.result.review.headSha,
    );
    const fingerprint = reviewFindingFingerprint({
      repository: input.link.repository ?? "unknown/unknown",
      sourceIssueNumber: input.link.issueNumber,
      sourcePullNumber: input.pullNumber,
      finding,
    });
    const fingerprintMarker = `<!-- FORGE:REVIEW_FINDING_FINGERPRINT ${fingerprint} -->`;
    const exact = existing.find(
      (issue) =>
        issue.body.includes(marker) || issue.body.includes(fingerprintMarker),
    );
    if (exact?.state === "open") {
      issueMap[finding.id] = exact.number;
      continue;
    }
    const regression = exact?.state === "closed";
    const priority = regression
      ? "priority:P1"
      : findingPriority(finding.severity);
    const title = `fix: ${finding.summary} (review finding — PR #${input.pullNumber})`.slice(
      0,
      240,
    );
    const body = `${fingerprintMarker}\n${renderFindingIssueBody({
      finding,
      pullNumber: input.pullNumber,
      link: input.link,
      headSha: input.result.review.headSha,
      marker,
      regressionIssue: regression ? exact?.number : undefined,
    })}`;
    const created = await input.github.createIssue({
      title,
      body,
      labels: ["review-finding", "needs-validation", priority],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    issueMap[finding.id] = created.number;
    if (!existing.some((issue) => issue.number === created.number))
      existing.push(created);
  }
  if (input.result.review.findings.length > 0) {
    const lines = input.result.review.findings.map(
      (finding) =>
        `- #${issueMap[finding.id]} — ${finding.id}: ${finding.summary}`,
    );
    await input.github.postPullArtifact({
      pullNumber: input.pullNumber,
      marker: `<!-- FORGE:REVIEW_FINDING_ISSUES head=${input.result.review.headSha} -->`,
      body: `## Review Finding Issues\n\n${lines.join("\n")}`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
  return issueMap;
}

export function reviewFindingMarker(
  pullNumber: number,
  findingId: string,
  headSha: string,
): string {
  return `<!-- FORGE:REVIEW_FINDING source-pr=${pullNumber} finding=${encodeURIComponent(findingId)} head=${headSha} -->`;
}

export function reviewFindingFingerprint(input: {
  repository: string;
  sourceIssueNumber?: number;
  sourcePullNumber: number;
  finding: ForgeReviewFindingResult;
}): string {
  const normalized = JSON.stringify({
    repository: input.repository.toLowerCase(),
    sourceIssueNumber: input.sourceIssueNumber,
    sourcePullNumber: input.sourcePullNumber,
    category: input.finding.category.toLowerCase(),
    file: input.finding.file.toLowerCase(),
    lineBucket: Math.floor(Math.max(1, input.finding.line) / 5),
    summary: input.finding.summary.toLowerCase().replace(/\s+/g, " ").trim(),
  });
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

export function findingPriority(
  severity: ForgeReviewFindingResult["severity"],
): string {
  return {
    critical: "priority:P0",
    high: "priority:P1",
    medium: "priority:P2",
    low: "priority:P3",
  }[severity];
}

function renderFindingIssueBody(input: {
  finding: ForgeReviewFindingResult;
  pullNumber: number;
  link: ReviewFindingRunIdentity;
  headSha: string;
  marker: string;
  regressionIssue?: number;
}): string {
  const evidence = input.finding.evidence
    .map((entry) => `- ${entry}`)
    .join("\n");
  return `${input.marker}\n## Review Finding\n\n**Source PR**: #${input.pullNumber}\n**Source issue**: ${input.link.issueNumber === undefined ? "unlinked" : `#${input.link.issueNumber}`}\n**Forge run**: \`${input.link.forgeRunId}\`\n**Reviewed head**: \`${input.headSha}\`\n**Reviewer**: \`${input.finding.reviewer}\`\n**Finding ID**: \`${input.finding.id}\`\n**Confidence**: ${input.finding.confidence.toUpperCase()}\n**Severity**: ${input.finding.severity.toUpperCase()}\n**Category**: ${input.finding.category}\n**File**: \`${input.finding.file}\`\n**Line**: ${input.finding.line}\n${input.regressionIssue ? `**Regression of**: #${input.regressionIssue}\n` : ""}\n### Problem\n\n${input.finding.summary}\n\n### Evidence\n\n${evidence || "- Reviewer supplied no additional evidence."}\n\n### Acceptance Criteria\n\n- [ ] Reproduce or validate the finding against the current integration branch.\n- [ ] Fix the root cause without expanding unrelated scope.\n- [ ] Add focused regression coverage.\n- [ ] Re-review the exact remediation head.\n\n<!-- FORGE:PATTERN: ${findingPattern(input.finding)} -->\n<!-- FORGE:CLASS: ${findingPattern(input.finding)} -->`;
}

function findingPattern(finding: ForgeReviewFindingResult): string {
  return `${finding.category}-${finding.id}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}
