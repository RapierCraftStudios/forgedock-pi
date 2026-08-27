import { createHash, randomUUID } from "node:crypto";

import { canonicalJson } from "./events.ts";
import type {
  FindingCategory,
  FindingConfidence,
  FindingSeverity,
  ReviewDecision,
  ReviewFinding as CoreReviewFinding,
  VerificationResult as CoreVerificationResult,
} from "./review.ts";

/** The schema is deliberately separate from run state: reviews can outlive a run. */
export const REVIEW_EVENT_SCHEMA = "forgedock.review-event/v1" as const;
export const REVIEW_STATE_SCHEMA = "forgedock.review-state/v1" as const;

export const REVIEW_MODES = ["standard", "staging"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export interface ReviewRouteSnapshot {
  pullNumber: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
}

export type ReviewRoute = string | ReviewRouteSnapshot;

export interface ReviewRef {
  ref: string;
  sha: string;
}

export interface ReviewIdentity {
  repository: string;
  pullNumber: number;
  issueNumber?: number;
  mode: ReviewMode;
  head: ReviewRef;
  base: ReviewRef;
  roster: ReviewRoster;
  route?: ReviewRoute;
}

export interface ReviewRoster {
  version: string;
  reviewers: readonly string[];
  profiles?: readonly Record<string, unknown>[];
}

/** A standalone finding is not required to belong to an issue RunState. */
export type ReviewFinding = Omit<CoreReviewFinding, "runId"> & {
  runId?: string;
};

export type ReviewPanelStatus = "running" | "completed";

export interface ReviewPanel {
  round: number;
  status: ReviewPanelStatus;
  reviewers: readonly string[];
  completedReviewers: readonly string[];
  startedAt: string;
  completedAt?: string;
}

export type VerificationResult = CoreVerificationResult;

export interface ReviewVerdict {
  decision: ReviewDecision;
  headSha: string;
  baseSha: string;
  reasons: readonly string[];
  blockingFindingIds: readonly string[];
  followUpFindingIds: readonly string[];
}

export interface ReviewGate {
  decision: ReviewDecision;
  passed: boolean;
  headSha: string;
  baseSha: string;
  reasons: readonly string[];
}

export interface MergeAuthorization {
  authorized: boolean;
  headSha: string;
  baseSha: string;
  reason?: string;
  authorizedBy?: string;
}

export type ReviewCompletionOutcome = "reviewed" | "merged";

export interface ReviewCompletion {
  round: number;
  outcome: ReviewCompletionOutcome;
  reason?: string;
}

export type ReviewStatus = "active" | "completed" | "cancelled";

export interface ReviewState {
  schema: typeof REVIEW_STATE_SCHEMA;
  reviewId: string;
  repository: string;
  pullNumber: number;
  /** Non-enumerable compatibility aliases exposed by create/replay helpers. */
  readonly pullRequest?: number;
  readonly head?: ReviewRef;
  readonly base?: ReviewRef;
  issueNumber?: number;
  mode: ReviewMode;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  roster: ReviewRoster;
  route?: ReviewRoute;
  panel?: ReviewPanel;
  checks: readonly VerificationResult[];
  findings: readonly ReviewFinding[];
  verdict?: ReviewVerdict;
  gate?: ReviewGate;
  mergeAuthorization?: MergeAuthorization;
  completion?: ReviewCompletion;
  status: ReviewStatus;
  cancellationReason?: string;
  sequence: number;
  lastEventHash: string;
  idempotencyKeys: Record<string, string>;
  eventIds: Record<string, true>;
  createdAt: string;
  updatedAt: string;
}

export type ReviewEventType =
  | "review.created"
  | "review.routed"
  | "review.route-selected"
  | "review.panel-started"
  | "review.panel.started"
  | "review.panel-completed"
  | "review.panel.completed"
  | "review.check-recorded"
  | "review.check.recorded"
  | "review.findings-recorded"
  | "review.findings.recorded"
  | "review.verdict-recorded"
  | "review.verdict.recorded"
  | "review.gate-recorded"
  | "review.gate.recorded"
  | "review.merge-authorized"
  | "review.merge.authorization"
  | "review.completed"
  | "review.cancelled";

export interface ReviewCreatedPayload {
  pullNumber: number;
  issueNumber?: number;
  mode: ReviewMode;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  roster: ReviewRoster;
  route?: ReviewRoute;
}

export interface ReviewRoutePayload {
  route: ReviewRoute;
}

export interface ReviewPanelStartedPayload {
  round: number;
  reviewers?: readonly string[];
}

export interface ReviewPanelCompletedPayload {
  round: number;
  completedReviewers: readonly string[];
}

export interface ReviewCheckRecordedPayload {
  round: number;
  check: VerificationResult;
}

export interface ReviewFindingsRecordedPayload {
  round: number;
  findings: readonly ReviewFinding[];
}

export interface ReviewVerdictRecordedPayload extends ReviewVerdict {
  round: number;
}
export interface ReviewGateRecordedPayload extends ReviewGate {
  round: number;
}
export interface ReviewMergeAuthorizedPayload extends MergeAuthorization {
  round: number;
}
export interface ReviewCompletedPayload extends ReviewCompletion {}
export interface ReviewCancelledPayload {
  reason: string;
}

export type ReviewEventPayload =
  | ReviewCreatedPayload
  | ReviewRoutePayload
  | ReviewPanelStartedPayload
  | ReviewPanelCompletedPayload
  | ReviewCheckRecordedPayload
  | ReviewFindingsRecordedPayload
  | ReviewVerdictRecordedPayload
  | ReviewGateRecordedPayload
  | ReviewMergeAuthorizedPayload
  | ReviewCompletedPayload
  | ReviewCancelledPayload
  | Record<string, unknown>;

export interface ReviewEvent<TPayload extends ReviewEventPayload = ReviewEventPayload> {
  schema: typeof REVIEW_EVENT_SCHEMA;
  eventId: string;
  reviewId: string;
  repository: string;
  sequence: number;
  previousEventHash: string | null;
  type: ReviewEventType;
  occurredAt: string;
  idempotencyKey: string;
  payload: TPayload;
}

export class ReviewTransitionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReviewTransitionError";
    this.code = code;
  }
}

export function createReviewEvent<TPayload extends ReviewEventPayload>(input: {
  reviewId: string;
  repository: string;
  sequence: number;
  previousEventHash: string | null;
  type: ReviewEventType;
  idempotencyKey: string;
  payload: TPayload;
  eventId?: string;
  occurredAt?: string;
}): ReviewEvent<TPayload> {
  const event: ReviewEvent<TPayload> = {
    schema: REVIEW_EVENT_SCHEMA,
    eventId: input.eventId ?? randomUUID(),
    reviewId: requiredString(input.reviewId, "reviewId"),
    repository: requiredString(input.repository, "repository"),
    sequence: positiveInteger(input.sequence, "sequence"),
    previousEventHash: input.previousEventHash,
    type: input.type,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey"),
    payload: input.payload,
  };
  validateReviewEvent(event);
  return event;
}

export function hashReviewEvent(event: ReviewEvent): string {
  // Importing the run hash helper would make the review contract depend on run events.
  // canonicalJson is the shared, deterministic hash-chain representation.
  return `sha256:${cryptoHash(canonicalJson(event))}`;
}

export function validateReviewEvent(value: unknown): asserts value is ReviewEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewTransitionError("invalid-event", "Review event must be an object.");
  const event = value as Partial<ReviewEvent>;
  if (event.schema !== REVIEW_EVENT_SCHEMA)
    throw new ReviewTransitionError(
      "unsupported-schema",
      `Unsupported review event schema: ${String(event.schema)}.`,
    );
  requiredString(event.eventId, "eventId");
  requiredString(event.reviewId, "reviewId");
  requiredString(event.repository, "repository");
  requiredString(event.idempotencyKey, "idempotencyKey");
  positiveInteger(event.sequence, "sequence");
  if (event.previousEventHash !== null)
    requiredString(event.previousEventHash, "previousEventHash");
  if (!REVIEW_EVENT_TYPES.has(event.type as ReviewEventType))
    throw new ReviewTransitionError(
      "unsupported-event-type",
      `Unsupported review event type: ${String(event.type)}.`,
    );
  requiredString(event.occurredAt, "occurredAt");
  if (Number.isNaN(Date.parse(event.occurredAt as string)))
    throw new ReviewTransitionError(
      "invalid-timestamp",
      "occurredAt must be RFC3339-compatible.",
    );
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload))
    throw new ReviewTransitionError("invalid-payload", "payload must be an object.");
}

export function applyReviewEvent(
  current: ReviewState | undefined,
  event: ReviewEvent,
): ReviewState {
  validateReviewEvent(event);
  if (!current) return createInitialState(event);
  assertContinuation(current, event);
  if (current.status !== "active")
    throw new ReviewTransitionError(
      "terminal-review",
      `Cannot apply ${event.type} to ${current.status} review.`,
    );
  if (
    current.mergeAuthorization?.authorized &&
    event.type !== "review.completed"
  )
    throw new ReviewTransitionError(
      "merge-authorized",
      "An authorized merge must settle before any other review transition.",
    );

  const state = cloneState(current);
  switch (event.type) {
    case "review.created":
      throw new ReviewTransitionError(
        "duplicate-create",
        "review.created is only valid as the genesis event.",
      );
    case "review.routed":
    case "review.route-selected":
      {
        const route = routePayload(event).route;
        assertRouteIdentity(route, state.pullNumber, state.headRef, state.headSha, state.baseRef, state.baseSha);
        if (state.route !== undefined && canonicalJson(state.route) !== canonicalJson(route))
          throw new ReviewTransitionError("route-frozen", "Review route is immutable once selected.");
        state.route = route;
      }
      break;
    case "review.panel-started":
    case "review.panel.started":
      applyPanelStarted(state, event);
      break;
    case "review.panel-completed":
    case "review.panel.completed":
      applyPanelCompleted(state, event);
      break;
    case "review.check-recorded":
    case "review.check.recorded":
      applyCheck(state, event);
      break;
    case "review.findings-recorded":
    case "review.findings.recorded":
      applyFindings(state, event);
      break;
    case "review.verdict-recorded":
    case "review.verdict.recorded":
      applyVerdict(state, event);
      break;
    case "review.gate-recorded":
    case "review.gate.recorded":
      applyGate(state, event);
      break;
    case "review.merge-authorized":
    case "review.merge.authorization":
      applyMergeAuthorization(state, event);
      break;
    case "review.completed":
      applyCompletion(state, event);
      break;
    case "review.cancelled":
      state.status = "cancelled";
      state.cancellationReason = requiredString(payload(event).reason, "reason");
      break;
  }
  state.sequence = event.sequence;
  state.lastEventHash = hashReviewEvent(event);
  state.idempotencyKeys[event.idempotencyKey] = event.eventId;
  state.eventIds[event.eventId] = true;
  state.updatedAt = event.occurredAt;
  return state;
}

export function replayReviewEvents(events: readonly ReviewEvent[]): ReviewState {
  if (events.length === 0)
    throw new ReviewTransitionError("empty-journal", "Cannot replay an empty review journal.");
  let state: ReviewState | undefined;
  for (const event of events) state = applyReviewEvent(state, event);
  if (!state) throw new ReviewTransitionError("empty-journal", "Cannot replay an empty review journal.");
  return state;
}

/** Validate snapshots before comparing them with the journal-derived state. */
export function validateReviewState(value: unknown): asserts value is ReviewState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewTransitionError("invalid-snapshot", "Review snapshot must be an object.");
  const state = value as Partial<ReviewState>;
  if (state.schema !== REVIEW_STATE_SCHEMA)
    throw new ReviewTransitionError("unsupported-schema", "Unsupported review state schema.");
  requiredString(state.reviewId, "reviewId");
  requiredString(state.repository, "repository");
  positiveInteger(state.pullNumber, "pullNumber");
  if (state.issueNumber !== undefined) positiveInteger(state.issueNumber, "issueNumber");
  assertMode(state.mode);
  requiredString(state.headRef, "headRef");
  requiredString(state.headSha, "headSha");
  requiredString(state.baseRef, "baseRef");
  requiredString(state.baseSha, "baseSha");
  if (state.route !== undefined) {
    const route = validateRoute(state.route);
    assertRouteIdentity(route, state.pullNumber as number, state.headRef as string, state.headSha as string, state.baseRef as string, state.baseSha as string);
  }
  const roster = validateRoster(state.roster);
  if (canonicalJson(roster) !== canonicalJson(state.roster))
    throw new ReviewTransitionError("invalid-snapshot", "Frozen roster is malformed.");
  if (state.panel !== undefined) {
    const panel = validatePanel(state.panel);
    if (!sameMembers(panel.reviewers, roster.reviewers))
      throw new ReviewTransitionError("invalid-snapshot", "Panel reviewers must equal the frozen roster.");
  }
  if (!Array.isArray(state.checks) || !Array.isArray(state.findings))
    throw new ReviewTransitionError("invalid-snapshot", "Review checks and findings must be arrays.");
  for (const check of state.checks) validateCheck(check);
  const findingIds = new Set<string>();
  for (const finding of state.findings) {
    const checked = validateFinding(finding);
    if (checked.headSha !== state.headSha)
      throw new ReviewTransitionError("invalid-snapshot", "Finding headSha does not match the frozen review head.");
    if (!roster.reviewers.includes(checked.reviewer))
      throw new ReviewTransitionError("invalid-snapshot", "Finding reviewer is not in the frozen roster.");
    if (findingIds.has(checked.id))
      throw new ReviewTransitionError("invalid-snapshot", "Finding IDs must be unique.");
    findingIds.add(checked.id);
  }
  if (state.verdict !== undefined) {
    // SAFETY: validateVerdict only reads Record<string, unknown> fields defensively;
    // the double cast bypasses the partial ReviewState type, not runtime validation.
    const verdict = validateVerdict(state.verdict as unknown as Record<string, unknown>);
    if (verdict.headSha !== state.headSha || verdict.baseSha !== state.baseSha)
      throw new ReviewTransitionError("invalid-snapshot", "Verdict identity does not match the frozen route.");
  }
  if (state.gate !== undefined) {
    // SAFETY: validateGate only reads Record<string, unknown> fields defensively;
    // the double cast bypasses the partial ReviewState type, not runtime validation.
    const gate = validateGate(state.gate as unknown as Record<string, unknown>);
    if (gate.headSha !== state.headSha || gate.baseSha !== state.baseSha)
      throw new ReviewTransitionError("invalid-snapshot", "Gate identity does not match the frozen route.");
    if (state.verdict && gate.decision !== state.verdict.decision)
      throw new ReviewTransitionError("invalid-snapshot", "Gate decision does not match the verdict.");
  }
  if (state.mergeAuthorization !== undefined) {
    // SAFETY: validateMergeAuthorization only reads Record<string, unknown> fields
    // defensively; the double cast bypasses the partial ReviewState type, not
    // runtime validation.
    const authorization = validateMergeAuthorization(state.mergeAuthorization as unknown as Record<string, unknown>);
    if (authorization.headSha !== state.headSha || authorization.baseSha !== state.baseSha)
      throw new ReviewTransitionError("invalid-snapshot", "Merge authorization identity does not match the frozen route.");
    if (!state.gate)
      throw new ReviewTransitionError("invalid-snapshot", "Merge authorization requires a review gate.");
    if (authorization.authorized && !state.gate.passed)
      throw new ReviewTransitionError("invalid-snapshot", "Merge authorization bypasses the review gate.");
  }
  if (state.completion !== undefined) {
    // SAFETY: validateCompletion only reads Record<string, unknown> fields
    // defensively; the double cast bypasses the partial ReviewState type, not
    // runtime validation.
    const completion = validateCompletion(state.completion as unknown as Record<string, unknown>);
    if (
      !state.panel ||
      state.panel.status !== "completed" ||
      completion.round !== state.panel.round
    )
      throw new ReviewTransitionError("invalid-snapshot", "Completion requires the matching completed review panel.");
    if (!state.verdict || !state.gate)
      throw new ReviewTransitionError("invalid-snapshot", "Completion requires a verdict and gate.");
    if (completion.outcome === "merged" && !state.mergeAuthorization?.authorized)
      throw new ReviewTransitionError("invalid-snapshot", "Merged completion requires merge authorization.");
    if (completion.outcome === "reviewed" && state.mergeAuthorization?.authorized)
      throw new ReviewTransitionError("invalid-snapshot", "Authorized merge cannot complete as review-only.");
  }
  if (state.status === "completed" && !state.completion)
    throw new ReviewTransitionError("invalid-snapshot", "Completed review must record its outcome.");
  if (state.completion && state.status !== "completed")
    throw new ReviewTransitionError("invalid-snapshot", "Review completion requires completed status.");
  if (state.status !== "cancelled" && state.cancellationReason !== undefined)
    throw new ReviewTransitionError("invalid-snapshot", "Cancellation reason requires cancelled status.");
  if (state.status === "cancelled") requiredString(state.cancellationReason, "cancellationReason");
  if (!REVIEW_STATUSES.has(state.status as ReviewStatus))
    throw new ReviewTransitionError("invalid-snapshot", "Review status is unsupported.");
  positiveInteger(state.sequence, "sequence");
  if (!/^sha256:[0-9a-f]{64}$/.test(state.lastEventHash as string))
    throw new ReviewTransitionError("invalid-snapshot", "Review lastEventHash is malformed.");
  if (!state.idempotencyKeys || typeof state.idempotencyKeys !== "object" || Array.isArray(state.idempotencyKeys))
    throw new ReviewTransitionError("invalid-snapshot", "Review idempotency keys are required.");
  for (const [key, eventId] of Object.entries(state.idempotencyKeys)) {
    requiredString(key, "idempotency key");
    requiredString(eventId, `idempotencyKeys.${key}`);
  }
  if (!state.eventIds || typeof state.eventIds !== "object" || Array.isArray(state.eventIds))
    throw new ReviewTransitionError("invalid-snapshot", "Review event IDs are required.");
  for (const [eventId, present] of Object.entries(state.eventIds)) {
    requiredString(eventId, "event ID");
    if (present !== true)
      throw new ReviewTransitionError("invalid-snapshot", `eventIds.${eventId} must be true.`);
  }
  if (Object.keys(state.idempotencyKeys).length !== state.sequence || Object.keys(state.eventIds).length !== state.sequence)
    throw new ReviewTransitionError("invalid-snapshot", "Review event indexes do not match the sequence.");
  assertTimestamp(state.createdAt, "createdAt");
  assertTimestamp(state.updatedAt, "updatedAt");
}

function createInitialState(event: ReviewEvent): ReviewState {
  if (event.type !== "review.created" || event.sequence !== 1 || event.previousEventHash !== null)
    throw new ReviewTransitionError(
      "invalid-genesis",
      "The first review event must be review.created at sequence 1 with no previous hash.",
    );
  const data = payload(event);
  const pullNumber = positiveInteger(data.pullNumber ?? data.pullRequest, "pullNumber");
  if (data.pullNumber !== undefined && data.pullRequest !== undefined && positiveInteger(data.pullRequest, "pullRequest") !== pullNumber)
    throw new ReviewTransitionError("identity-mismatch", "pullNumber and pullRequest must match.");
  const mode = assertMode(data.mode);
  const head = reference(data.head, "head");
  const base = reference(data.base, "base");
  const headRef = requiredString(data.headRef ?? head?.ref, "headRef");
  const headSha = requiredString(data.headSha ?? head?.sha, "headSha");
  const baseRef = requiredString(data.baseRef ?? base?.ref, "baseRef");
  const baseSha = requiredString(data.baseSha ?? base?.sha, "baseSha");
  if (head && (head.ref !== headRef || head.sha !== headSha))
    throw new ReviewTransitionError("identity-mismatch", "head and headRef/headSha must match.");
  if (base && (base.ref !== baseRef || base.sha !== baseSha))
    throw new ReviewTransitionError("identity-mismatch", "base and baseRef/baseSha must match.");
  const roster = validateRoster(data.roster ?? data.frozenRoster);
  const route = data.route === undefined ? undefined : validateRoute(data.route);
  if (route !== undefined) assertRouteIdentity(route, pullNumber, headRef, headSha, baseRef, baseSha);
  const issueNumber = data.issueNumber === undefined ? undefined : positiveInteger(data.issueNumber, "issueNumber");
  const eventHash = hashReviewEvent(event);
  const state: ReviewState = {
    schema: REVIEW_STATE_SCHEMA,
    reviewId: event.reviewId,
    repository: event.repository,
    pullNumber,
    issueNumber,
    mode,
    headRef,
    headSha,
    baseRef,
    baseSha,
    roster,
    ...(route ? { route } : {}),
    checks: [],
    findings: [],
    status: "active",
    sequence: event.sequence,
    lastEventHash: eventHash,
    idempotencyKeys: Object.assign(Object.create(null), { [event.idempotencyKey]: event.eventId }),
    eventIds: Object.assign(Object.create(null), { [event.eventId]: true }),
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  };
  defineIdentityAliases(state);
  return state;
}

function defineIdentityAliases(state: ReviewState): void {
  Object.defineProperties(state, {
    pullRequest: {
      configurable: false,
      enumerable: false,
      get: () => state.pullNumber,
    },
    head: {
      configurable: false,
      enumerable: false,
      get: () => ({ ref: state.headRef, sha: state.headSha }),
    },
    base: {
      configurable: false,
      enumerable: false,
      get: () => ({ ref: state.baseRef, sha: state.baseSha }),
    },
  });
}

function cloneState(state: ReviewState): ReviewState {
  const cloned: ReviewState = {
    ...state,
    roster: {
      version: state.roster.version,
      reviewers: [...state.roster.reviewers],
      ...(state.roster.profiles === undefined
        ? {}
        : { profiles: state.roster.profiles.map((profile) => ({ ...profile })) }),
    },
    ...(state.panel
      ? {
          panel: {
            ...state.panel,
            reviewers: [...state.panel.reviewers],
            completedReviewers: [...state.panel.completedReviewers],
          },
        }
      : {}),
    checks: state.checks.map((check) => ({ ...check })),
    findings: state.findings.map((finding) => ({ ...finding, evidence: [...finding.evidence] })),
    ...(state.verdict
      ? {
          verdict: {
            ...state.verdict,
            reasons: [...state.verdict.reasons],
            blockingFindingIds: [...state.verdict.blockingFindingIds],
            followUpFindingIds: [...state.verdict.followUpFindingIds],
          },
        }
      : {}),
    ...(state.gate
      ? { gate: { ...state.gate, reasons: [...state.gate.reasons] } }
      : {}),
    ...(state.mergeAuthorization ? { mergeAuthorization: { ...state.mergeAuthorization } } : {}),
    ...(state.completion ? { completion: { ...state.completion } } : {}),
    idempotencyKeys: Object.assign(Object.create(null), state.idempotencyKeys),
    eventIds: Object.assign(Object.create(null), state.eventIds),
  };
  defineIdentityAliases(cloned);
  return cloned;
}

function applyPanelStarted(state: ReviewState, event: ReviewEvent): void {
  const data = payload(event);
  const round = positiveInteger(data.round, "round");
  if (state.panel?.status === "running")
    throw new ReviewTransitionError("panel-running", "A review panel is already running.");
  const expectedRound = (state.panel?.round ?? 0) + 1;
  if (round !== expectedRound)
    throw new ReviewTransitionError("panel-round", `Expected panel round ${expectedRound}.`);
  const reviewers = data.reviewers === undefined
    ? [...state.roster.reviewers]
    : stringArray(data.reviewers, "reviewers");
  if (!sameMembers(reviewers, state.roster.reviewers))
    throw new ReviewTransitionError("roster-mismatch", "Panel reviewers must equal the frozen roster.");
  state.panel = { round, status: "running", reviewers, completedReviewers: [], startedAt: event.occurredAt };
  state.checks = [];
  state.findings = [];
  delete state.verdict;
  delete state.gate;
  delete state.mergeAuthorization;
  delete state.completion;
}

function applyPanelCompleted(state: ReviewState, event: ReviewEvent): void {
  const data = payload(event);
  const panel = state.panel;
  if (!panel || panel.status !== "running")
    throw new ReviewTransitionError("panel-not-running", "Panel completion requires a running panel.");
  const round = positiveInteger(data.round, "round");
  if (round !== panel.round)
    throw new ReviewTransitionError("panel-round", "Panel completion round does not match the active panel.");
  const completed = stringArray(data.completedReviewers, "completedReviewers");
  if (!sameMembers(completed, panel.reviewers))
    throw new ReviewTransitionError("panel-incomplete", "Panel completion must include the complete frozen roster.");
  state.panel = { ...panel, status: "completed", completedReviewers: completed, completedAt: event.occurredAt };
}

function applyCheck(state: ReviewState, event: ReviewEvent): void {
  const panel = requireRunningPanel(state);
  assertEventRound(event, panel.round);
  const data = payload(event);
  const check = validateCheck(data.check);
  const prior = state.checks.findIndex((candidate) => candidate.name === check.name);
  state.checks = prior < 0
    ? [...state.checks, check]
    : state.checks.map((candidate, index) => (index === prior ? check : candidate));
  clearTerminalDecisions(state);
}

function applyFindings(state: ReviewState, event: ReviewEvent): void {
  const panel = requireRunningPanel(state);
  assertEventRound(event, panel.round);
  const values = payload(event).findings;
  if (!Array.isArray(values))
    throw new ReviewTransitionError("invalid-findings", "findings must be an array.");
  const findings = values.map(validateFinding);
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length)
    throw new ReviewTransitionError(
      "duplicate-finding",
      "Review findings must have unique IDs within a panel.",
    );
  for (const finding of findings) {
    if (finding.headSha !== state.headSha)
      throw new ReviewTransitionError("stale-head", "Finding headSha does not match the frozen review head.");
    if (!state.roster.reviewers.includes(finding.reviewer))
      throw new ReviewTransitionError(
        "roster-mismatch",
        `Finding reviewer ${finding.reviewer} is not in the frozen roster.`,
      );
  }
  // A findings event is a complete projection for the current panel; this avoids
  // duplicate journal retries while retaining duplicate findings from different reviewers.
  state.findings = findings;
  clearTerminalDecisions(state);
}

function applyVerdict(state: ReviewState, event: ReviewEvent): void {
  const panel = requireCompletedPanel(state);
  assertEventRound(event, panel.round);
  if (state.verdict)
    throw new ReviewTransitionError("duplicate-verdict", "A verdict is already recorded for this panel.");
  const verdict = validateVerdict(payload(event));
  assertFrozenIdentity(state, verdict.headSha, verdict.baseSha);
  const findingIds = new Set(state.findings.map((finding) => finding.id));
  const referenced = [
    ...verdict.blockingFindingIds,
    ...verdict.followUpFindingIds,
  ];
  if (new Set(referenced).size !== referenced.length)
    throw new ReviewTransitionError(
      "duplicate-finding-reference",
      "A finding cannot be both blocking and follow-up evidence.",
    );
  const unknownFinding = referenced.find((id) => !findingIds.has(id));
  if (unknownFinding)
    throw new ReviewTransitionError(
      "unknown-finding",
      `Verdict references unknown finding ${unknownFinding}.`,
    );
  state.verdict = verdict;
  delete state.gate;
  delete state.mergeAuthorization;
}

function applyGate(state: ReviewState, event: ReviewEvent): void {
  const panel = requireCompletedPanel(state);
  assertEventRound(event, panel.round);
  if (state.gate)
    throw new ReviewTransitionError("duplicate-gate", "A gate is already recorded for this panel.");
  if (!state.verdict)
    throw new ReviewTransitionError("missing-verdict", "A gate requires a recorded verdict.");
  const gate = validateGate(payload(event));
  assertFrozenIdentity(state, gate.headSha, gate.baseSha);
  if (gate.decision !== state.verdict.decision)
    throw new ReviewTransitionError("verdict-mismatch", "Gate decision must match the recorded verdict.");
  state.gate = gate;
  delete state.mergeAuthorization;
}

function applyMergeAuthorization(state: ReviewState, event: ReviewEvent): void {
  const panel = requireCompletedPanel(state);
  assertEventRound(event, panel.round);
  if (state.mergeAuthorization)
    throw new ReviewTransitionError("duplicate-merge-authorization", "Merge authorization is already recorded for this panel.");
  if (!state.gate)
    throw new ReviewTransitionError("missing-gate", "Merge authorization requires a recorded gate.");
  const authorization = validateMergeAuthorization(payload(event));
  assertFrozenIdentity(state, authorization.headSha, authorization.baseSha);
  if (authorization.authorized && !state.gate.passed)
    throw new ReviewTransitionError("gate-blocked", "A failed review gate cannot authorize merge.");
  state.mergeAuthorization = authorization;
}

function applyCompletion(state: ReviewState, event: ReviewEvent): void {
  const panel = requireCompletedPanel(state);
  if (!state.verdict || !state.gate)
    throw new ReviewTransitionError(
      "missing-gate",
      "Review completion requires a recorded verdict and gate.",
    );
  const completion = validateCompletion(payload(event));
  if (completion.round !== panel.round)
    throw new ReviewTransitionError(
      "panel-round",
      "Review completion round does not match the active panel.",
    );
  if (completion.outcome === "merged" && !state.mergeAuthorization?.authorized)
    throw new ReviewTransitionError(
      "missing-merge-authorization",
      "Merged completion requires merge authorization.",
    );
  if (completion.outcome === "reviewed" && state.mergeAuthorization?.authorized)
    throw new ReviewTransitionError(
      "completion-outcome",
      "Authorized merge cannot complete as review-only.",
    );
  state.completion = completion;
  state.status = "completed";
}

function clearTerminalDecisions(state: ReviewState): void {
  delete state.verdict;
  delete state.gate;
  delete state.mergeAuthorization;
  delete state.completion;
}

function requirePanel(state: ReviewState): ReviewPanel {
  if (!state.panel)
    throw new ReviewTransitionError("missing-panel", "Review evidence requires a started panel.");
  return state.panel;
}

function requireRunningPanel(state: ReviewState): ReviewPanel {
  const panel = requirePanel(state);
  if (panel.status !== "running")
    throw new ReviewTransitionError(
      "panel-completed",
      "Review evidence cannot change after panel completion.",
    );
  return panel;
}

function requireCompletedPanel(state: ReviewState): ReviewPanel {
  const panel = requirePanel(state);
  if (panel.status !== "completed")
    throw new ReviewTransitionError("panel-incomplete", "Review decision requires a completed panel.");
  return panel;
}

function assertEventRound(event: ReviewEvent, expectedRound: number): void {
  const round = positiveInteger(payload(event).round, "round");
  if (round !== expectedRound)
    throw new ReviewTransitionError(
      "panel-round",
      `Expected evidence for panel round ${expectedRound}, received ${round}.`,
    );
}

function assertFrozenIdentity(state: ReviewState, headSha: unknown, baseSha: unknown): void {
  if (headSha !== state.headSha || baseSha !== state.baseSha)
    throw new ReviewTransitionError("stale-identity", "Review evidence does not match the frozen head/base SHAs.");
}

function assertContinuation(state: ReviewState, event: ReviewEvent): void {
  if (state.reviewId !== event.reviewId || state.repository !== event.repository)
    throw new ReviewTransitionError("identity-mismatch", "Review event identity does not match the current state.");
  if (event.sequence !== state.sequence + 1)
    throw new ReviewTransitionError("sequence-gap", `Expected sequence ${state.sequence + 1}, received ${event.sequence}.`);
  if (event.previousEventHash !== state.lastEventHash)
    throw new ReviewTransitionError("hash-chain-break", "Review event hash chain is broken.");
  if (state.eventIds[event.eventId])
    throw new ReviewTransitionError("duplicate-event", `Review event ${event.eventId} was already applied.`);
  if (state.idempotencyKeys[event.idempotencyKey])
    throw new ReviewTransitionError("duplicate-idempotency-key", `Review idempotency key ${event.idempotencyKey} already exists.`);
}

function payload(event: ReviewEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

function routePayload(event: ReviewEvent): { route: ReviewRoute } {
  return { route: validateRoute(payload(event).route) };
}

function validateRoute(value: unknown): ReviewRoute {
  if (typeof value === "string") return requiredString(value, "route");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewTransitionError("invalid-route", "route must be a non-empty string or route snapshot.");
  const route = value as Partial<ReviewRouteSnapshot>;
  return {
    pullNumber: positiveInteger(route.pullNumber, "route.pullNumber"),
    headRef: requiredString(route.headRef, "route.headRef"),
    headSha: requiredString(route.headSha, "route.headSha"),
    baseRef: requiredString(route.baseRef, "route.baseRef"),
    baseSha: requiredString(route.baseSha, "route.baseSha"),
  };
}

function assertRouteIdentity(
  route: ReviewRoute,
  pullNumber: number,
  headRef: string,
  headSha: string,
  baseRef: string,
  baseSha: string,
): void {
  if (typeof route === "string") return;
  if (
    route.pullNumber !== pullNumber ||
    route.headRef !== headRef ||
    route.headSha !== headSha ||
    route.baseRef !== baseRef ||
    route.baseSha !== baseSha
  ) {
    throw new ReviewTransitionError(
      "route-identity-mismatch",
      "Route snapshot does not match the frozen pull request identity.",
    );
  }
}

function reference(value: unknown, field: string): ReviewRef | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewTransitionError("invalid-field", `${field} must be a ref/sha object.`);
  const ref = value as Partial<ReviewRef>;
  return {
    ref: requiredString(ref.ref, `${field}.ref`),
    sha: requiredString(ref.sha, `${field}.sha`),
  };
}

function validateRoster(value: unknown): ReviewRoster {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewTransitionError("invalid-roster", "A frozen reviewer roster is required.");
  const roster = value as Partial<ReviewRoster>;
  const version = requiredString(roster.version, "roster.version");
  const reviewers = stringArray(roster.reviewers, "roster.reviewers");
  if (reviewers.length === 0)
    throw new ReviewTransitionError("invalid-roster", "A frozen reviewer roster cannot be empty.");
  if (new Set(reviewers).size !== reviewers.length)
    throw new ReviewTransitionError("invalid-roster", "Frozen reviewer roster contains duplicates.");
  const profiles = roster.profiles;
  if (profiles !== undefined &&
      (!Array.isArray(profiles) || !profiles.every((profile) => profile && typeof profile === "object" && !Array.isArray(profile))))
    throw new ReviewTransitionError("invalid-roster", "Roster profiles must be objects.");
  return {
    version,
    reviewers: [...reviewers],
    ...(profiles === undefined
      ? {}
      : { profiles: profiles.map((profile) => ({ ...profile })) }),
  };
}

function validatePanel(value: unknown): ReviewPanel {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewTransitionError("invalid-panel", "A panel must be an object.");
  const panel = value as Partial<ReviewPanel>;
  const round = positiveInteger(panel.round, "panel.round");
  if (panel.status !== "running" && panel.status !== "completed")
    throw new ReviewTransitionError("invalid-panel", "panel.status is unsupported.");
  const reviewers = stringArray(panel.reviewers, "panel.reviewers");
  const completedReviewers = stringArray(panel.completedReviewers, "panel.completedReviewers");
  requiredString(panel.startedAt, "panel.startedAt");
  if (panel.status === "running") {
    if (completedReviewers.length > 0 || panel.completedAt !== undefined)
      throw new ReviewTransitionError(
        "invalid-panel",
        "A running panel cannot contain completion evidence.",
      );
  } else {
    requiredString(panel.completedAt, "panel.completedAt");
    if (!sameMembers(reviewers, completedReviewers))
      throw new ReviewTransitionError("invalid-panel", "Completed panel must include every reviewer.");
  }
  return {
    round,
    status: panel.status,
    reviewers,
    completedReviewers,
    startedAt: panel.startedAt as string,
    ...(panel.completedAt === undefined ? {} : { completedAt: panel.completedAt }),
  };
}

function validateCheck(value: unknown): VerificationResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewTransitionError("invalid-check", "A check must be an object.");
  const check = value as Partial<VerificationResult>;
  const name = requiredString(check.name, "check.name");
  const statuses = ["passed", "failed", "skipped", "pending", "unknown", "not-configured", "policy-exempt"];
  if (!statuses.includes(check.status as string))
    throw new ReviewTransitionError("invalid-check", `Unsupported check status: ${String(check.status)}.`);
  if (typeof check.required !== "boolean")
    throw new ReviewTransitionError("invalid-check", "check.required must be boolean.");
  return { name, required: check.required, status: check.status as VerificationResult["status"], ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }) };
}

function validateFinding(value: unknown): ReviewFinding {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReviewTransitionError("invalid-finding", "A finding must be an object.");
  const finding = value as Partial<ReviewFinding>;
  const requiredStrings = ["id", "reviewer", "headSha", "file", "summary"] as const;
  for (const field of requiredStrings) requiredString(finding[field], `finding.${field}`);
  if (finding.runId !== undefined) requiredString(finding.runId, "finding.runId");
  const line = finding.line;
  if (!Number.isSafeInteger(line) || (line as number) < 1)
    throw new ReviewTransitionError("invalid-finding", "finding.line must be a positive integer.");
  if (!["confirmed", "likely", "possible"].includes(finding.confidence as string))
    throw new ReviewTransitionError("invalid-finding", "finding.confidence is unsupported.");
  if (!["critical", "high", "medium", "low"].includes(finding.severity as string))
    throw new ReviewTransitionError("invalid-finding", "finding.severity is unsupported.");
  const categories: FindingCategory[] = ["security", "data-loss", "auth", "billing", "production-safety", "correctness", "performance", "maintainability"];
  if (!categories.includes(finding.category as FindingCategory))
    throw new ReviewTransitionError("invalid-finding", "finding.category is unsupported.");
  const evidence = stringArray(finding.evidence, "finding.evidence");
  return {
    id: finding.id as string,
    reviewer: finding.reviewer as string,
    ...(finding.runId === undefined ? {} : { runId: finding.runId as string }),
    headSha: finding.headSha as string,
    confidence: finding.confidence as FindingConfidence,
    severity: finding.severity as FindingSeverity,
    category: finding.category as FindingCategory,
    file: finding.file as string,
    line: line as number,
    summary: finding.summary as string,
    evidence,
  };
}

function validateVerdict(value: Record<string, unknown>): ReviewVerdict {
  const decision = reviewDecision(value.decision);
  return {
    decision,
    headSha: requiredString(value.headSha, "verdict.headSha"),
    baseSha: requiredString(value.baseSha, "verdict.baseSha"),
    reasons: stringArray(value.reasons, "verdict.reasons"),
    blockingFindingIds: stringArray(value.blockingFindingIds, "verdict.blockingFindingIds"),
    followUpFindingIds: stringArray(value.followUpFindingIds, "verdict.followUpFindingIds"),
  };
}

function validateGate(value: Record<string, unknown>): ReviewGate {
  const decision = reviewDecision(value.decision);
  if (typeof value.passed !== "boolean")
    throw new ReviewTransitionError("invalid-gate", "gate.passed must be boolean.");
  const passingDecision = decision === "approved" || decision === "approved-with-follow-ups";
  if (value.passed !== passingDecision)
    throw new ReviewTransitionError("verdict-mismatch", "Gate passed must agree with its verdict decision.");
  return {
    decision,
    passed: value.passed,
    headSha: requiredString(value.headSha, "gate.headSha"),
    baseSha: requiredString(value.baseSha, "gate.baseSha"),
    reasons: stringArray(value.reasons, "gate.reasons"),
  };
}

function validateMergeAuthorization(value: Record<string, unknown>): MergeAuthorization {
  if (typeof value.authorized !== "boolean")
    throw new ReviewTransitionError("invalid-merge-authorization", "authorized must be boolean.");
  return {
    authorized: value.authorized,
    headSha: requiredString(value.headSha, "mergeAuthorization.headSha"),
    baseSha: requiredString(value.baseSha, "mergeAuthorization.baseSha"),
    ...(value.reason === undefined ? {} : { reason: requiredString(value.reason, "reason") }),
    ...(value.authorizedBy === undefined ? {} : { authorizedBy: requiredString(value.authorizedBy, "authorizedBy") }),
  };
}

function validateCompletion(value: Record<string, unknown>): ReviewCompletion {
  const round = positiveInteger(value.round, "completion.round");
  if (value.outcome !== "reviewed" && value.outcome !== "merged")
    throw new ReviewTransitionError(
      "invalid-completion",
      `Unsupported completion outcome: ${String(value.outcome)}.`,
    );
  return {
    round,
    outcome: value.outcome,
    ...(value.reason === undefined
      ? {}
      : { reason: requiredString(value.reason, "completion.reason") }),
  };
}

function reviewDecision(value: unknown): ReviewDecision {
  const values: readonly ReviewDecision[] = ["approved", "approved-with-follow-ups", "changes-requested", "blocked", "needs-human"];
  if (!values.includes(value as ReviewDecision))
    throw new ReviewTransitionError("invalid-verdict", `Unsupported review decision: ${String(value)}.`);
  return value as ReviewDecision;
}

function assertMode(value: unknown): ReviewMode {
  if (!REVIEW_MODES.includes(value as ReviewMode))
    throw new ReviewTransitionError("invalid-mode", `Unsupported review mode: ${String(value)}.`);
  return value as ReviewMode;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() === entry && entry.length > 0))
    throw new ReviewTransitionError("invalid-field", `${field} must be an array of non-empty trimmed strings.`);
  return [...(value as string[])];
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim())
    throw new ReviewTransitionError("invalid-field", `${field} must be a non-empty trimmed string.`);
  return value;
}

function assertTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  if (Number.isNaN(Date.parse(timestamp)))
    throw new ReviewTransitionError("invalid-snapshot", `${field} must be RFC3339-compatible.`);
  return timestamp;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new ReviewTransitionError("invalid-field", `${field} must be a positive safe integer.`);
  return value as number;
}

function cryptoHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const REVIEW_EVENT_TYPES: ReadonlySet<ReviewEventType> = new Set([
  "review.created",
  "review.routed",
  "review.route-selected",
  "review.panel-started",
  "review.panel.started",
  "review.panel-completed",
  "review.panel.completed",
  "review.check-recorded",
  "review.check.recorded",
  "review.findings-recorded",
  "review.findings.recorded",
  "review.verdict-recorded",
  "review.verdict.recorded",
  "review.gate-recorded",
  "review.gate.recorded",
  "review.merge-authorized",
  "review.merge.authorization",
  "review.completed",
  "review.cancelled",
]);

const REVIEW_STATUSES: ReadonlySet<ReviewStatus> = new Set(["active", "completed", "cancelled"]);

export type ReviewStateEvent = ReviewEvent;
export type ReviewStateEventType = ReviewEventType;
export type ReviewStateSnapshot = ReviewState;

export const applyReviewStateEvent = applyReviewEvent;
export const replayReviewJournal = replayReviewEvents;
export const replayReviewState = replayReviewEvents;
export const createReviewStateEvent = createReviewEvent;

