import type { ForgeReviewerResult } from "../agents/contracts.ts";

/** Versioned, pure recovery contracts for Pi provider boundaries. */
export const REVIEW_RECOVERY_SCHEMA = "forgedock.review-recovery/v1" as const;
export const REVIEWER_FAILURE_KINDS = [
  "timeout",
  "provider-inactivity",
  "cancelled",
  "parent-termination",
  "invalid-result",
] as const;
export type ReviewerFailureKind = (typeof REVIEWER_FAILURE_KINDS)[number];

export interface ReviewerEvidenceKey {
  headSha: string;
  reviewer: string;
  attempt: number;
}

export interface ReviewerEvidenceRecord {
  schema: typeof REVIEW_RECOVERY_SCHEMA;
  key: string;
  headSha: string;
  reviewer: string;
  attempt: number;
  result: ForgeReviewerResult;
}

export interface ReviewRecoveryPlan {
  retained: readonly ForgeReviewerResult[];
  missingReviewers: readonly string[];
  retryReviewers: readonly string[];
  failureKinds: Readonly<Record<string, ReviewerFailureKind>>;
  extendedTimeoutMs: number;
  synthesisAllowed: boolean;
  reason?: string;
}

/**
 * Durable accounting for every launch that may be needed before a review can
 * legally stop.  `maxReviewRounds` includes the initial panel; transient
 * retries are complete-panel retries, not partial role retries.
 */
export interface ReviewLaunchReservation {
  schema: "forgedock.review-launch-reservation/v1";
  rosterSize: number;
  maxReviewRounds: number;
  maxTransientRetriesPerRound: number;
  planned: number;
  observed: number;
  reserved: number;
  remaining: number;
}

export interface ReviewLaunchReservationInput {
  reviewers: readonly string[];
  maxReviewRounds: number;
  /** Defaults to two retries (three complete attempts per round). */
  maxTransientRetriesPerRound?: number;
  /** Existing launches when resuming a durable panel. */
  observed?: number;
}

/** Compute the worst-case launch reservation without mutating workflow state. */
export function computeReviewLaunchReservation(
  input: ReviewLaunchReservationInput,
): ReviewLaunchReservation {
  const rosterSize = input.reviewers.length;
  if (rosterSize < 1 || new Set(input.reviewers).size !== rosterSize)
    throw new TypeError("Review reservation requires a unique, non-empty roster.");
  if (!Number.isSafeInteger(input.maxReviewRounds) || input.maxReviewRounds < 1 || input.maxReviewRounds > 5)
    throw new TypeError("Review reservation rounds must be an integer from 1 through 5.");
  const retries = input.maxTransientRetriesPerRound ?? 2;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 3)
    throw new TypeError("Review reservation retries must be an integer from 0 through 3.");
  const observed = input.observed ?? 0;
  if (!Number.isSafeInteger(observed) || observed < 0)
    throw new TypeError("Observed review launches must be a non-negative integer.");
  const planned = rosterSize * input.maxReviewRounds * (retries + 1);
  if (observed > planned)
    throw new Error("Observed review launches exceed the worst-case reservation.");
  return {
    schema: "forgedock.review-launch-reservation/v1",
    rosterSize,
    maxReviewRounds: input.maxReviewRounds,
    maxTransientRetriesPerRound: retries,
    planned,
    observed,
    reserved: planned - observed,
    remaining: planned - observed,
  };
}

/** Record one admitted reviewer launch, preserving idempotent accounting. */
export function recordReviewLaunch(
  reservation: ReviewLaunchReservation,
  count = 1,
): ReviewLaunchReservation {
  if (reservation.schema !== "forgedock.review-launch-reservation/v1")
    throw new TypeError("Unsupported review launch reservation schema.");
  if (!Number.isSafeInteger(count) || count < 1)
    throw new TypeError("Review launch count must be a positive integer.");
  if (count > reservation.remaining)
    throw new Error(`Review launch reservation exhausted: ${count} requested, ${reservation.remaining} remaining.`);
  const observed = reservation.observed + count;
  const remaining = reservation.planned - observed;
  return { ...reservation, observed, reserved: remaining, remaining };
}

/**
 * Guard the first launch of a lifecycle.  This is intentionally separate from
 * the accounting update so callers can fail closed before starting any child.
 */
export interface ReviewContinuationHandoff {
  schema: "forgedock.review-continuation/v1";
  continuationId: string;
  previousRunIds: readonly string[];
  previousHeadSha: string;
  headSha: string;
  remediationCommitSha?: string;
  oldChildrenSettled: boolean;
  claimed: boolean;
}

/**
 * Atomically claim a fresh-session continuation.  A continuation is only
 * launchable after every old child has settled, and its id/head are retained
 * so a retry cannot double-launch or silently review a different head.
 */
export function claimReviewContinuation(
  handoff: ReviewContinuationHandoff,
): ReviewContinuationHandoff {
  if (handoff.schema !== "forgedock.review-continuation/v1")
    throw new TypeError("Unsupported review continuation schema.");
  if (!handoff.continuationId.trim() || !handoff.previousHeadSha.trim() || !handoff.headSha.trim())
    throw new TypeError("Review continuation requires stable run and head identities.");
  if (handoff.previousRunIds.length === 0 || new Set(handoff.previousRunIds).size !== handoff.previousRunIds.length)
    throw new TypeError("Review continuation must retain unique previous child run IDs.");
  if (!handoff.oldChildrenSettled)
    throw new Error("Review continuation cannot start while previous reviewer children are active.");
  if (handoff.claimed)
    throw new Error(`Review continuation ${handoff.continuationId} was already claimed.`);
  return { ...handoff, claimed: true };
}

export function assertReviewLaunchReservation(
  reservation: ReviewLaunchReservation,
  available: number,
): void {
  if (reservation.schema !== "forgedock.review-launch-reservation/v1")
    throw new TypeError("Unsupported review launch reservation schema.");
  if (!Number.isSafeInteger(available) || available < 0)
    throw new TypeError("Available review launches must be a non-negative integer.");
  if (available < reservation.remaining)
    throw new Error(
      `Review launch reservation cannot be satisfied: remaining ${reservation.remaining}, available ${available}.`,
    );
}

export interface ReviewDeadlineInput {
  reviewerTimeoutMs: number;
  /** The parent deadline includes the nested reviewer deadline and its join grace. */
  parentTimeoutMs?: number;
  joinGraceMs?: number;
}

export function reviewerEvidenceKey(input: ReviewerEvidenceKey): string {
  assertReviewerIdentity(input);
  return `${input.headSha}:${input.reviewer}:${input.attempt}`;
}

export function createReviewerEvidenceRecord(
  key: ReviewerEvidenceKey,
  result: ForgeReviewerResult,
): ReviewerEvidenceRecord {
  const canonical = reviewerEvidenceKey(key);
  if (
    result.headSha !== key.headSha ||
    result.reviewer !== key.reviewer
  )
    throw new TypeError("Reviewer evidence does not match its durable key.");
  if (result.schema !== "forgedock.reviewer-result/v1")
    throw new TypeError("Reviewer evidence has an unsupported result schema.");
  return { schema: REVIEW_RECOVERY_SCHEMA, key: canonical, ...key, result };
}

/**
 * Validate and order a complete panel. A partial or mixed-head panel is never
 * eligible for synthesis; callers may retain valid entries for a later retry.
 */
export function validateReviewerPanel(input: {
  results: readonly ForgeReviewerResult[];
  reviewers: readonly string[];
  headSha: string;
  attempt: number;
}): readonly ForgeReviewerResult[] {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
    throw new TypeError("Reviewer attempt must be a positive integer.");
  const expected = new Set(input.reviewers);
  if (expected.size !== input.reviewers.length || expected.size === 0)
    throw new TypeError("Reviewer roster must be unique and non-empty.");
  const byRole = new Map<string, ForgeReviewerResult>();
  for (const result of input.results) {
    if (
      result.headSha !== input.headSha ||
      !expected.has(result.reviewer) ||
      byRole.has(result.reviewer)
    )
      throw new Error("Reviewer evidence does not match the frozen panel key.");
    for (const finding of result.findings) {
      if (
        finding.reviewer !== result.reviewer ||
        finding.headSha !== input.headSha
      )
        throw new Error("Reviewer finding does not match its panel key.");
    }
    byRole.set(result.reviewer, result);
  }
  if (byRole.size !== expected.size)
    throw new Error("Reviewer panel is incomplete; synthesis is forbidden.");
  return input.reviewers.map((reviewer) => byRole.get(reviewer)!);
}

export function planReviewRecovery(input: {
  reviewers: readonly string[];
  headSha: string;
  attempt: number;
  completed: readonly ForgeReviewerResult[];
  failures?: Readonly<Record<string, ReviewerFailureKind>>;
  reviewerTimeoutMs: number;
}): ReviewRecoveryPlan {
  if (!input.headSha.trim() || !Number.isSafeInteger(input.attempt) || input.attempt < 1)
    throw new TypeError("Review recovery requires a frozen head and positive attempt.");
  const retained: ForgeReviewerResult[] = [];
  const seen = new Set<string>();
  for (const result of input.completed) {
    if (
      result.headSha !== input.headSha ||
      !input.reviewers.includes(result.reviewer) ||
      seen.has(result.reviewer)
    )
      continue;
    retained.push(result);
    seen.add(result.reviewer);
  }
  const missingReviewers = input.reviewers.filter((reviewer) => !seen.has(reviewer));
  const failures = input.failures ?? {};
  const retryReviewers = missingReviewers.filter((reviewer) => {
    const kind = failures[reviewer];
    return kind === "timeout" || kind === "provider-inactivity";
  });
  const extendedTimeoutMs = extendedReviewerTimeout(input.reviewerTimeoutMs);
  const synthesisAllowed = missingReviewers.length === 0;
  return {
    retained,
    missingReviewers,
    retryReviewers,
    failureKinds: { ...failures },
    extendedTimeoutMs,
    synthesisAllowed,
    ...(synthesisAllowed
      ? {}
      : {
          reason:
            retryReviewers.length > 0
              ? `Reviewer panel incomplete; retry only: ${retryReviewers.join(", ")}.`
              : "Reviewer panel incomplete and is not safely retryable.",
        }),
  };
}

export function extendedReviewerTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError("Reviewer timeout must be a positive integer.");
  // Never let a recovery retry become an unbounded parent-held operation.
  return Math.min(Math.max(timeoutMs, 30_000) * 2, 1_800_000);
}

export function validateReviewDeadlines(input: ReviewDeadlineInput): void {
  if (!Number.isSafeInteger(input.reviewerTimeoutMs) || input.reviewerTimeoutMs < 1)
    throw new TypeError("Reviewer timeout must be a positive integer.");
  const grace = input.joinGraceMs ?? 30_000;
  if (!Number.isSafeInteger(grace) || grace < 0)
    throw new TypeError("Reviewer join grace must be a non-negative integer.");
  if (input.parentTimeoutMs === undefined) return;
  if (!Number.isSafeInteger(input.parentTimeoutMs) || input.parentTimeoutMs < 1)
    throw new TypeError("Parent timeout must be a positive integer.");
  if (input.parentTimeoutMs <= input.reviewerTimeoutMs + grace)
    throw new Error(
      "Unsafe deadline: parent timeout must exceed the nested reviewer timeout and join grace, or be omitted.",
    );
}

export function classifyReviewerFailure(
  error: unknown,
  signal?: AbortSignal,
): ReviewerFailureKind {
  if (
    error &&
    typeof error === "object" &&
    REVIEWER_FAILURE_KINDS.includes(
      (error as { kind?: ReviewerFailureKind }).kind as ReviewerFailureKind,
    )
  )
    return (error as { kind: ReviewerFailureKind }).kind;
  const message = error instanceof Error ? error.message : String(error);
  if (signal?.aborted) {
    const reason = String(signal.reason ?? message).toLowerCase();
    if (/parent|terminated|shutdown|session/.test(reason)) return "parent-termination";
    return "cancelled";
  }
  if (/parent.{0,20}(?:timeout|deadline)|(?:timeout|deadline).{0,20}parent|terminated by parent/.test(message))
    return "parent-termination";
  if (/timed?\s*out|timeout|deadline exceeded/i.test(message)) return "timeout";
  if (/inactiv|provider|socket|websocket|connection|transport|no valid bound result/i.test(message))
    return "provider-inactivity";
  return "invalid-result";
}

function assertReviewerIdentity(input: ReviewerEvidenceKey): void {
  if (!input.headSha.trim() || !input.reviewer.trim())
    throw new TypeError("Reviewer evidence key requires head and reviewer.");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
    throw new TypeError("Reviewer evidence attempt must be positive.");
}
