export const REVIEW_DECISIONS = [
  "approved",
  "approved-with-follow-ups",
  "changes-requested",
  "blocked",
  "needs-human",
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export type FindingConfidence = "confirmed" | "likely" | "possible";
export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingCategory =
  | "security"
  | "data-loss"
  | "auth"
  | "billing"
  | "production-safety"
  | "correctness"
  | "performance"
  | "maintainability";

export interface ReviewIdentity {
  repository: string;
  runId: string;
  pullRequest: number;
  headSha: string;
  baseSha: string;
  rosterVersion: string;
}

export interface ReviewFinding {
  id: string;
  reviewer: string;
  runId: string;
  headSha: string;
  confidence: FindingConfidence;
  severity: FindingSeverity;
  category: FindingCategory;
  file: string;
  line: number;
  summary: string;
  evidence: readonly string[];
}

export type VerificationStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "pending"
  | "unknown"
  | "not-configured"
  | "policy-exempt";

export interface VerificationResult {
  name: string;
  required: boolean;
  status: VerificationStatus;
  exitCode?: number;
}

export interface ReviewGateInput {
  identity: ReviewIdentity;
  currentHeadSha: string;
  currentBaseSha: string;
  requiredReviewers: readonly string[];
  completedReviewers: readonly string[];
  findings: readonly ReviewFinding[];
  checks: readonly VerificationResult[];
  mergeability: "mergeable" | "conflicting" | "unknown";
  leaseValid: boolean;
  baseBranch: string;
  protectedBranches: readonly string[];
  autoMergeAuthorized: boolean;
  malformedResults?: readonly string[];
}

export interface FinalReviewDecision {
  readonly headSha: string;
  readonly baseSha: string;
  readonly decision: ReviewDecision;
  readonly blockingFindingIds: readonly string[];
  readonly followUpFindingIds: readonly string[];
  readonly checkResults: readonly VerificationResult[];
  readonly reasons: readonly string[];
}

export type ReviewGateResult = FinalReviewDecision;

const CRITICAL_DOMAINS: ReadonlySet<FindingCategory> = new Set([
  "security",
  "data-loss",
  "auth",
  "billing",
  "production-safety",
]);

export function findingBlocksMerge(finding: ReviewFinding): boolean {
  if (finding.confidence !== "confirmed") return false;
  if (finding.severity === "critical" || finding.severity === "high")
    return true;
  return (
    finding.severity === "medium" && CRITICAL_DOMAINS.has(finding.category)
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function evaluateReviewGate(input: ReviewGateInput): ReviewGateResult {
  const blocked: string[] = [];
  const changes: string[] = [];
  const human: string[] = [];

  if (input.identity.headSha !== input.currentHeadSha) {
    blocked.push(
      `Reviewed head ${input.identity.headSha} is stale; current head is ${input.currentHeadSha}.`,
    );
  }
  if (input.identity.baseSha !== input.currentBaseSha) {
    blocked.push(
      `Reviewed base ${input.identity.baseSha} changed to ${input.currentBaseSha}.`,
    );
  }
  if (!input.leaseValid)
    blocked.push("The run no longer owns the active lease epoch.");
  if (input.mergeability === "conflicting")
    blocked.push("The pull request has merge conflicts.");
  if (input.mergeability === "unknown")
    blocked.push("Pull request mergeability is unknown.");

  for (const malformed of input.malformedResults ?? []) {
    blocked.push(`Malformed review or gate result: ${malformed}`);
  }

  const completed = new Set(input.completedReviewers);
  const missingReviewers = unique(input.requiredReviewers).filter(
    (reviewer) => !completed.has(reviewer),
  );
  if (missingReviewers.length > 0)
    blocked.push(
      `Required review panel incomplete: ${missingReviewers.join(", ")}.`,
    );

  if (input.checks.length === 0)
    blocked.push("No verification results were recorded for the reviewed head.");

  for (const check of input.checks) {
    if (!check.required || check.status === "passed") continue;
    if (check.status === "failed") {
      changes.push(`Required check ${check.name} failed.`);
      continue;
    }
    blocked.push(
      check.status === "skipped"
        ? `Required check ${check.name} was skipped.`
        : check.status === "pending"
          ? `Required check ${check.name} is pending.`
          : check.status === "not-configured"
            ? `Required check ${check.name} is not configured.`
            : check.status === "policy-exempt"
              ? `Required check ${check.name} cannot be policy-exempt.`
              : `Required check ${check.name} returned an unknown result.`,
    );
  }

  const blockingFindingIds = input.findings
    .filter(findingBlocksMerge)
    .map((finding) => finding.id);
  const blockingFindingSet = new Set(blockingFindingIds);
  const followUpFindingIds = input.findings
    .filter((finding) => !blockingFindingSet.has(finding.id))
    .map((finding) => finding.id);
  if (blockingFindingIds.length > 0) {
    changes.push(
      `Blocking confirmed findings remain: ${blockingFindingIds.join(", ")}.`,
    );
  }

  if (input.protectedBranches.includes(input.baseBranch)) {
    human.push(`Base branch ${input.baseBranch} is protected and human-only.`);
  } else if (!input.autoMergeAuthorized) {
    human.push(`Automatic merge is not authorized for ${input.baseBranch}.`);
  }

  if (blocked.length > 0) {
    return createFinalReviewDecision(
      input,
      "blocked",
      blockingFindingIds,
      followUpFindingIds,
      blocked,
    );
  }
  if (changes.length > 0) {
    return createFinalReviewDecision(
      input,
      "changes-requested",
      blockingFindingIds,
      followUpFindingIds,
      changes,
    );
  }
  if (human.length > 0) {
    return createFinalReviewDecision(
      input,
      "needs-human",
      blockingFindingIds,
      followUpFindingIds,
      human,
    );
  }
  return createFinalReviewDecision(
    input,
    followUpFindingIds.length > 0 ? "approved-with-follow-ups" : "approved",
    blockingFindingIds,
    followUpFindingIds,
    [],
  );
}

function createFinalReviewDecision(
  input: ReviewGateInput,
  decision: ReviewDecision,
  blockingFindingIds: readonly string[],
  followUpFindingIds: readonly string[],
  reasons: readonly string[],
): FinalReviewDecision {
  return Object.freeze({
    headSha: input.identity.headSha,
    baseSha: input.identity.baseSha,
    decision,
    blockingFindingIds: Object.freeze([...blockingFindingIds]),
    followUpFindingIds: Object.freeze([...followUpFindingIds]),
    checkResults: Object.freeze(
      input.checks.map((check) => Object.freeze({ ...check })),
    ),
    reasons: Object.freeze([...reasons]),
  });
}
