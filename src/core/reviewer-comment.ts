import type { ForgeReviewerResult } from "../agents/contracts.ts";

export function reviewerDomain(reviewer: string): string {
  return reviewer.replace(/^forge-review-/, "");
}

export function reviewerCommentMarker(
  runId: string,
  reviewer: string,
  round: number,
  headSha: string,
): string {
  return [
    `<!-- FORGE:REVIEW-AGENT:${reviewerDomain(reviewer)} -->`,
    reviewerCommentInstanceMarker(runId, reviewer, round, headSha),
  ].join("\n");
}

export function reviewerCommentInstanceMarker(
  runId: string,
  reviewer: string,
  round: number,
  headSha: string,
): string {
  return `<!-- FORGE:REVIEW-INSTANCE run=${runId} domain=${reviewerDomain(reviewer)} round=${round} head=${headSha} -->`;
}

export function renderReviewerComment(
  result: ForgeReviewerResult,
  round: number,
  commentRunId = result.runId,
): string {
  const findings = result.findings.length
    ? result.findings
        .map((finding) => {
          const blockView = finding.reviewerBlockView ?? "advisory";
          const scope = finding.reviewerScope ?? "patch-caused";
          return [
            `- **${finding.id}** ${finding.file}:${finding.line} — ${finding.summary}`,
            `  - Confidence: ${finding.confidence}; severity: ${finding.severity}`,
            `  - Reviewer block view: ${blockView} — ${finding.reviewerBlockRationale ?? "No rationale supplied."}`,
            `  - Reviewer scope: ${scope} — ${finding.reviewerScopeRationale ?? "No rationale supplied."}`,
            `  - Evidence: ${finding.evidence.join("; ") || "No additional evidence supplied."}`,
          ].join("\n")
        })
        .join("\n")
    : "No findings reported.";
  const structuredFindings = result.findings
    .map(
      (finding) =>
        `<!-- FINDING:${finding.id}|${finding.confidence.toUpperCase()}|${finding.severity.toUpperCase()}|${finding.file}:${finding.line}|${finding.summary.replaceAll("|", "/")} -->`,
    )
    .join("\n");
  const evidence = result.evidence.map((entry) => `- ${entry}`).join("\n");
  const limitations = result.limitations.length
    ? result.limitations.map((entry) => `- ${entry}`).join("\n")
    : "- None identified within reviewed scope.";
  return [
    reviewerCommentMarker(commentRunId, result.reviewer, round, result.headSha),
    `# ${reviewerDomain(result.reviewer)} Review`,
    "",
    `**Reviewer**: \`${result.reviewer}\`  `,
    `**Reviewed head**: \`${result.headSha}\`  `,
    `**Round**: ${round}  `,
    `**Verdict**: ${result.verdict.toUpperCase()}`,
    "",
    "## Qualitative Summary",
    "",
    result.summary,
    "",
    "## Verified Behaviors",
    "",
    evidence || "- No verified behaviors supplied.",
    "",
    "## Findings",
    "",
    findings,
    "",
    "<!-- REVIEW-FINDINGS-START -->",
    structuredFindings,
    "<!-- REVIEW-FINDINGS-END -->",
    "",
    "## Residual Risks",
    "",
    limitations,
  ].join("\n");
}

export function reviewerCommentMatchesResult(
  body: string,
  result: ForgeReviewerResult,
  round: number,
  commentRunId = result.runId,
): boolean {
  return body.trim() === renderReviewerComment(result, round, commentRunId).trim();
}
