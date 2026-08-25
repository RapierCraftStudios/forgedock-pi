import type { GitHubWorkflowAdapter } from "../adapters/github-workflow.ts";
import type {
  ForgeReviewFindingResult,
  ForgeWorkOnResult,
} from "../agents/contracts.ts";

export interface ReviewFindingRunIdentity {
  forgeRunId: string;
  issueNumber: number;
}

export async function publishReviewFindingIssues(input: {
  github: GitHubWorkflowAdapter;
  pullNumber: number;
  link: ReviewFindingRunIdentity;
  result: ForgeWorkOnResult;
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
    const exact = existing.find((issue) => issue.body.includes(marker));
    if (exact?.state === "open") {
      issueMap[finding.id] = exact.number;
      continue;
    }
    const similar = existing.find(
      (issue) =>
        issue.state === "open" &&
        issue.body.includes(`**File**: \`${finding.file}\``) &&
        lineWithinTolerance(issue.body, finding.line) &&
        similarFindingTitle(issue.title, finding.summary),
    );
    if (similar) {
      issueMap[finding.id] = similar.number;
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
    const body = renderFindingIssueBody({
      finding,
      pullNumber: input.pullNumber,
      link: input.link,
      headSha: input.result.review.headSha,
      marker,
      regressionIssue: regression ? exact?.number : undefined,
    });
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

export function lineWithinTolerance(body: string, line: number): boolean {
  const match = /\*\*Line\*\*:\s*(\d+)/.exec(body);
  if (!match?.[1]) return false;
  return Math.abs(Number(match[1]) - line) <= 5;
}

export function similarFindingTitle(title: string, summary: string): boolean {
  const words = (value: string): Set<string> =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3),
    );
  const left = words(title);
  const right = words(summary);
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared >= 3;
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
  return `${input.marker}\n## Review Finding\n\n**Source PR**: #${input.pullNumber}\n**Source issue**: #${input.link.issueNumber}\n**Forge run**: \`${input.link.forgeRunId}\`\n**Reviewed head**: \`${input.headSha}\`\n**Reviewer**: \`${input.finding.reviewer}\`\n**Finding ID**: \`${input.finding.id}\`\n**Confidence**: ${input.finding.confidence.toUpperCase()}\n**Severity**: ${input.finding.severity.toUpperCase()}\n**Category**: ${input.finding.category}\n**File**: \`${input.finding.file}\`\n**Line**: ${input.finding.line}\n${input.regressionIssue ? `**Regression of**: #${input.regressionIssue}\n` : ""}\n### Problem\n\n${input.finding.summary}\n\n### Evidence\n\n${evidence || "- Reviewer supplied no additional evidence."}\n\n### Acceptance Criteria\n\n- [ ] Reproduce or validate the finding against the current integration branch.\n- [ ] Fix the root cause without expanding unrelated scope.\n- [ ] Add focused regression coverage.\n- [ ] Re-review the exact remediation head.\n\n<!-- FORGE:PATTERN: ${findingPattern(input.finding)} -->\n<!-- FORGE:CLASS: ${findingPattern(input.finding)} -->`;
}

function findingPattern(finding: ForgeReviewFindingResult): string {
  return `${finding.category}-${finding.id}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}
