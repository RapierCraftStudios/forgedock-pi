import type { GitHubWorkflowAdapter } from "../adapters/github-workflow.ts";
import {
  builderPathAllowed,
  type BuilderPathContract,
} from "../core/builder-contract.ts";
import type {
  ForgeReviewFindingResult,
  ForgeWorkOnResult,
} from "../agents/contracts.ts";

export interface AuthoritativeReviewFinding {
  issueNumber: number;
  sourcePullNumber: number;
  sourceIssueNumber: number;
  finding: ForgeReviewFindingResult;
}

export interface RemediationClassification {
  fixable: AuthoritativeReviewFinding[];
  escalated: AuthoritativeReviewFinding[];
}

export function classifyRemediationFindings(
  findings: readonly AuthoritativeReviewFinding[],
  builderContract?: BuilderPathContract,
): RemediationClassification {
  const fixable: AuthoritativeReviewFinding[] = [];
  const escalated: AuthoritativeReviewFinding[] = [];
  for (const finding of findings) {
    const text = `${finding.finding.category} ${finding.finding.summary} ${finding.finding.evidence.join(" ")}`;
    const requiresAuthority =
      finding.finding.confidence === "possible" ||
      (builderContract !== undefined &&
        !builderPathAllowed(builderContract, finding.finding.file)) ||
      ["auth", "billing", "production-safety"].includes(
        finding.finding.category,
      ) ||
      /\b(product|policy|ux|scope|protected branch|release authority|out[- ]of[- ]contract)\b/i.test(
        text,
      );
    (requiresAuthority ? escalated : fixable).push(finding);
  }
  return { fixable, escalated };
}

export function isRemediationCandidate(
  result: ForgeWorkOnResult,
  fixable: readonly AuthoritativeReviewFinding[],
): boolean {
  return (
    fixable.length > 0 &&
    (result.status === "blocked" || result.status === "needs-human") &&
    !/\b(main|protected branch|product|policy|ux|scope|out[- ]of[- ]contract)\b/i.test(
      result.blocker ?? "",
    )
  );
}

export async function loadAuthoritativeReviewFindingIssues(input: {
  github: GitHubWorkflowAdapter;
  pullNumber: number;
  signal?: AbortSignal;
}): Promise<AuthoritativeReviewFinding[]> {
  const issues = await input.github.listIssuesByLabel(
    "review-finding",
    "open",
    input.signal,
  );
  const byFinding = new Map<string, AuthoritativeReviewFinding>();
  for (const issue of issues) {
    const parsed = parseAuthoritativeReviewFindingIssue({
      number: issue.number,
      body: issue.body,
    });
    if (
      parsed?.sourcePullNumber === input.pullNumber &&
      !byFinding.has(parsed.finding.id)
    )
      byFinding.set(parsed.finding.id, parsed);
  }
  return [...byFinding.values()].sort((left, right) =>
    left.finding.id.localeCompare(right.finding.id),
  );
}

export function parseAuthoritativeReviewFindingIssue(input: {
  number: number;
  body: string;
}): AuthoritativeReviewFinding | undefined {
  const marker = input.body.match(
    /<!-- FORGE:REVIEW_FINDING source-pr=(\d+) finding=([^\s]+) head=([^\s]+) -->/,
  );
  if (!marker) return undefined;
  const sourceIssue = field(input.body, "Source issue", /#(\d+)/);
  const runId = field(input.body, "Forge run", /`([^`]+)`/);
  const reviewer = field(input.body, "Reviewer", /`([^`]+)`/);
  const confidence = field(
    input.body,
    "Confidence",
    /(CONFIRMED|LIKELY|POSSIBLE)/i,
  )?.toLowerCase();
  const severity = field(
    input.body,
    "Severity",
    /(CRITICAL|HIGH|MEDIUM|LOW)/i,
  )?.toLowerCase();
  const category = field(input.body, "Category", /([^\s]+)/)?.toLowerCase();
  const file = field(input.body, "File", /`([^`]+)`/);
  const line = field(input.body, "Line", /(\d+)/);
  const summary = section(input.body, "Problem");
  const evidence = section(input.body, "Evidence")
    .split("\n")
    .map((entry) => entry.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  if (
    !sourceIssue ||
    !runId ||
    !reviewer ||
    !confidence ||
    !severity ||
    !category ||
    !file ||
    !line ||
    !summary
  )
    return undefined;
  return {
    issueNumber: input.number,
    sourcePullNumber: Number(marker[1]),
    sourceIssueNumber: Number(sourceIssue),
    finding: {
      id: marker[2] as string,
      reviewer,
      runId,
      headSha: marker[3] as string,
      confidence: confidence as ForgeReviewFindingResult["confidence"],
      severity: severity as ForgeReviewFindingResult["severity"],
      category: category as ForgeReviewFindingResult["category"],
      file,
      line: Number(line),
      summary,
      evidence,
    },
  };
}

export function remediationStartMarker(runId: string, attempt: number): string {
  return `<!-- FORGE:REMEDIATION run=${runId} attempt=${attempt} -->`;
}

export function remediationCompleteMarker(
  runId: string,
  attempt: number,
): string {
  return `<!-- FORGE:REMEDIATION:COMPLETE run=${runId} attempt=${attempt} -->`;
}

export function readRemediationMarkerState(
  comments: readonly string[],
  runId: string,
): { startedAttempts: number[]; completedAttempts: number[] } {
  const started = new Set<number>();
  const completed = new Set<number>();
  for (const body of comments) {
    for (const match of body.matchAll(
      new RegExp(`<!-- FORGE:REMEDIATION run=${escapeRegex(runId)} attempt=(\\d+) -->`, "g"),
    ))
      started.add(Number(match[1]));
    for (const match of body.matchAll(
      new RegExp(`<!-- FORGE:REMEDIATION:COMPLETE run=${escapeRegex(runId)} attempt=(\\d+) -->`, "g"),
    ))
      completed.add(Number(match[1]));
  }
  return {
    startedAttempts: [...started].sort((a, b) => a - b),
    completedAttempts: [...completed].sort((a, b) => a - b),
  };
}

export function remediationFindingClosedMarker(
  runId: string,
  findingId: string,
  commitSha: string,
): string {
  return `<!-- FORGE:REMEDIATION:FINDING-CLOSED run=${runId} finding=${findingId} commit=${commitSha} -->`;
}

export async function closeAddressedReviewFindingIssues(input: {
  github: GitHubWorkflowAdapter;
  pullNumber: number;
  priorFindingIssueMap: Readonly<Record<string, number>>;
  activeFindingIds: ReadonlySet<string>;
  remediationCommitSha: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<void> {
  for (const [findingId, issueNumber] of Object.entries(
    input.priorFindingIssueMap,
  )) {
    if (input.activeFindingIds.has(findingId)) continue;
    const marker = remediationFindingClosedMarker(
      input.runId,
      findingId,
      input.remediationCommitSha,
    );
    const comments = await input.github.getComments(issueNumber, input.signal);
    if (!comments.some((comment) => comment.includes(marker)))
      await input.github.commentOnIssue(
        issueNumber,
        `${marker}\nFixed by remediation of PR #${input.pullNumber} at commit \`${input.remediationCommitSha}\`.`,
        input.signal,
      );
    const issue = await input.github.getIssue(issueNumber, input.signal);
    if (issue.state === "open")
      await input.github.closeIssue(issueNumber, input.signal);
  }
}

function field(body: string, name: string, pattern: RegExp): string | undefined {
  return body.match(new RegExp(`\\*\\*${escapeRegex(name)}\\*\\*:\\s*([^\\n]+)`, "i"))?.[1]?.match(pattern)?.[1];
}

function section(body: string, heading: string): string {
  const match = body.match(
    new RegExp(`### ${escapeRegex(heading)}\\s*\\n+([\\s\\S]*?)(?=\\n### |$)`, "i"),
  );
  return match?.[1]?.trim() ?? "";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
