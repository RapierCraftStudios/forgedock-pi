import type { GitHubWorkflowAdapter } from "../adapters/github-workflow.ts";
import {
  builderPathAllowed,
  type BuilderPathContract,
} from "../core/builder-contract.ts";
import { findingBlocksMerge } from "../core/review.ts";
import { humanAuthorityReasonFromText } from "../core/policy.ts";
import { reviewFindingAuthorityReason } from "./review-findings.ts";
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

export type FindingDisposition =
  | "actionable-blocking"
  | "validated-nonblocking"
  | "authority-ambiguous"
  | "unvalidated";

export type FindingClassification =
  | "IMPLEMENTATION_DEFECT"
  | "VERIFICATION_GAP"
  | "CONTRACT_GAP";

export interface DispositionedFinding {
  finding: AuthoritativeReviewFinding;
  classification: FindingClassification;
  disposition: FindingDisposition;
  reason: string;
}

export interface RemediationClassification {
  fixable: AuthoritativeReviewFinding[];
  escalated: AuthoritativeReviewFinding[];
  followUp: AuthoritativeReviewFinding[];
  unvalidated: AuthoritativeReviewFinding[];
  /** Confirmed findings whose reachable behavior was omitted from the admitted contract. */
  contractGaps: AuthoritativeReviewFinding[];
  /** Findings that cannot yet close their required evidence row. */
  verificationGaps: AuthoritativeReviewFinding[];
  dispositions: DispositionedFinding[];
}

export interface ContractGapHandoff {
  status: "REPLAN_REQUIRED" | "GATED";
  issueNumber: number;
  pullNumber: number;
  target: string;
  reviewedHead: string;
  worktree: string;
  reviewEvidence: readonly string[];
  remediationUsage: { used: number; limit: number };
  priorContractDigest: string;
  replanId: string;
  contractDigest: string;
  replanCount: number;
}

/** Admit exactly one preserved-work contract-gap transition without changing cap usage. */
export function admitContractGapReplan(input: {
  issueNumber: number;
  pullNumber: number;
  target: string;
  reviewedHead: string;
  worktree: string;
  reviewEvidence: readonly string[];
  remediationUsage: { used: number; limit: number };
  priorContractDigest: string;
  replanId: string;
  contractDigest: string;
  replanCount: number;
}): ContractGapHandoff {
  if (
    !Number.isSafeInteger(input.issueNumber) ||
    input.issueNumber < 1 ||
    !Number.isSafeInteger(input.pullNumber) ||
    input.pullNumber < 1 ||
    typeof input.target !== "string" ||
    !/^[a-f0-9]{40}$/.test(input.reviewedHead) ||
    typeof input.worktree !== "string" ||
    !input.worktree.startsWith("/") ||
    !Array.isArray(input.reviewEvidence) ||
    input.reviewEvidence.length === 0 ||
    input.reviewEvidence.some((entry) => typeof entry !== "string" || !entry.trim()) ||
    typeof input.priorContractDigest !== "string" ||
    typeof input.replanId !== "string" ||
    !input.replanId.trim() ||
    typeof input.contractDigest !== "string"
  )
    throw new TypeError("Contract-gap handoff requires exact identity fields.");
  if (!Number.isSafeInteger(input.remediationUsage.used) || !Number.isSafeInteger(input.remediationUsage.limit) || input.remediationUsage.used < 0 || input.remediationUsage.limit < input.remediationUsage.used)
    throw new TypeError("Contract-gap remediation usage is invalid.");
  if (!Number.isSafeInteger(input.replanCount) || input.replanCount < 0)
    throw new TypeError("Contract-gap re-plan count is invalid.");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.priorContractDigest) || !/^sha256:[0-9a-f]{64}$/.test(input.contractDigest) || input.contractDigest === input.priorContractDigest)
    throw new TypeError("Contract-gap re-plan requires distinct SHA-256 contract digests.");
  const status = input.replanCount >= 1 ? "GATED" : "REPLAN_REQUIRED";
  return {
    ...input,
    reviewEvidence: [...input.reviewEvidence],
    remediationUsage: { ...input.remediationUsage },
    replanCount: input.replanCount + (status === "REPLAN_REQUIRED" ? 1 : 0),
    status,
  };
}

export function classifyRemediationFindings(
  findings: readonly AuthoritativeReviewFinding[],
  builderContract?: BuilderPathContract,
): RemediationClassification {
  const fixable: AuthoritativeReviewFinding[] = [];
  const escalated: AuthoritativeReviewFinding[] = [];
  const followUp: AuthoritativeReviewFinding[] = [];
  const unvalidated: AuthoritativeReviewFinding[] = [];
  const contractGaps: AuthoritativeReviewFinding[] = [];
  const verificationGaps: AuthoritativeReviewFinding[] = [];
  const dispositions: DispositionedFinding[] = [];
  for (const finding of findings) {
    const value = finding.finding;
    const inContract =
      builderContract === undefined || builderPathAllowed(builderContract, value.file);
    const hasEvidence = value.evidence.some((entry) => entry.trim().length > 0);
    // A builder-path mismatch is a planning/decomposition problem, not a
    // human-authority request. Only explicit high-level authority language
    // can enter the escalated bucket.
    const authorityReason = reviewFindingAuthorityReason(value);
    let classification: FindingClassification;
    let disposition: FindingDisposition;
    let reason: string;
    if (value.confidence === "possible" || !hasEvidence || value.line < 1) {
      classification = "VERIFICATION_GAP";
      disposition = "unvalidated";
      reason = "Finding lacks confirmed evidence or a valid source location.";
      unvalidated.push(finding);
      verificationGaps.push(finding);
    } else if (findingBlocksMerge(value)) {
      if (authorityReason) {
        // An authority request is still an evidence-bearing contract finding, but
        // it must not be made autonomous merely by classifying it.
        classification = inContract ? "IMPLEMENTATION_DEFECT" : "CONTRACT_GAP";
        disposition = "authority-ambiguous";
        reason = `Blocking fix requires ${authorityReason}; autonomous execution must stop.`;
        escalated.push(finding);
        if (!inContract) contractGaps.push(finding);
      } else if (!inContract) {
        classification = "CONTRACT_GAP";
        disposition = "validated-nonblocking";
        reason = "Finding is outside the accepted builder contract; replan or decompose it instead of escalating authority.";
        followUp.push(finding);
        contractGaps.push(finding);
      } else {
        classification = "IMPLEMENTATION_DEFECT";
        disposition = "actionable-blocking";
        reason = "Finding is validated, deterministic, and in contract.";
        fixable.push(finding);
      }
    } else {
      classification = "IMPLEMENTATION_DEFECT";
      disposition = "validated-nonblocking";
      reason = "Finding is validated but does not block the current merge.";
      followUp.push(finding);
    }
    dispositions.push({ finding, classification, disposition, reason });
  }
  return { fixable, escalated, followUp, unvalidated, contractGaps, verificationGaps, dispositions };
}

export function isRemediationCandidate(
  result: ForgeWorkOnResult,
  fixable: readonly AuthoritativeReviewFinding[],
): boolean {
  return (
    fixable.length > 0 &&
    result.status === "blocked" &&
    !humanAuthorityReasonFromText(result.blocker ?? "")
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
  let findingId: string;
  try {
    findingId = decodeURIComponent(marker[2] as string);
  } catch {
    return undefined;
  }
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
      id: findingId,
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
    const issue = await input.github.getIssue(issueNumber, input.signal);
    const authority = parseAuthoritativeReviewFindingIssue({
      number: issue.number,
      body: issue.body,
    });
    if (
      !authority ||
      authority.sourcePullNumber !== input.pullNumber ||
      authority.finding.id !== findingId ||
      authority.finding.runId !== input.runId
    )
      throw new Error(
        `Review-finding issue #${issueNumber} is not authorized for cleanup by ${input.runId}.`,
      );
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
