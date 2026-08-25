import {
  hashRunEvent,
  isRunPhase,
  RUN_PHASES,
  type EffectRecordedPayload,
  type PhaseAttemptStatus,
  type PhaseCompletedPayload,
  type PhaseQueuedPayload,
  type PhaseStartedPayload,
  type PhaseStoppedPayload,
  type NodeEventPayload,
  type RunCreatedPayload,
  type RunEvent,
  type RunPhase,
  validateRunEvent,
} from "./events.ts";
import { type RepositoryLease, validateRepositoryLease } from "./lease.ts";

export const RUN_STATE_SCHEMA = "forgedock.run-state/v1" as const;

export type RunStatus =
  | "active"
  | "blocked"
  | "needs-human"
  | "completed"
  | "cancelled"
  | "failed";

export interface PhaseAttempt {
  attempt: number;
  status: PhaseAttemptStatus;
  leaseEpoch: number;
  restartAction: string;
  inputArtifactHash?: string;
  logicalNodeId?: string;
  subagentRunId?: string;
  worktreePath?: string;
  branch?: string;
  baseSha?: string;
  outputArtifactHash?: string;
  commitSha?: string;
  evidence: readonly string[];
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface PhaseState {
  phase: RunPhase;
  attempts: readonly PhaseAttempt[];
}

export interface NodeState extends NodeEventPayload {
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "blocked"
    | "needs-human";
  startedAt?: string;
  finishedAt?: string;
}

export interface RecordedEffect {
  effectType: EffectRecordedPayload["effectType"];
  effectId: string;
  digest: string;
  eventId: string;
}

export interface RunLeaseBinding {
  ownerRunId: string;
  epoch: number;
}

export interface RunState {
  schema: typeof RUN_STATE_SCHEMA;
  runId: string;
  repository: string;
  issueNumber: number;
  integrationBranch: string;
  protectedBranch: string;
  status: RunStatus;
  sequence: number;
  lastEventHash: string;
  lease?: RepositoryLease;
  leaseBinding?: RunLeaseBinding;
  phases: Partial<Record<RunPhase, PhaseState>>;
  nodes: Record<string, NodeState>;
  effects: Record<string, RecordedEffect>;
  idempotencyKeys: Record<string, string>;
  eventIds: Record<string, true>;
  outcome?: "merged" | "closed";
  pullNumber?: number;
  cancellationReason?: string;
}

export class StateTransitionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StateTransitionError";
    this.code = code;
  }
}

function payloadRecord(event: RunEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new StateTransitionError(
      "invalid-payload",
      `${eventLabel(record)} ${field} must be a non-empty string.`,
    );
  }
  return value;
}

function requirePositiveInteger(
  record: Record<string, unknown>,
  field: string,
): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new StateTransitionError(
      "invalid-payload",
      `${eventLabel(record)} ${field} must be a positive safe integer.`,
    );
  }
  return value as number;
}

function eventLabel(record: Record<string, unknown>): string {
  return typeof record.phase === "string"
    ? `Phase ${record.phase}`
    : "Event payload";
}

function requirePhasePayload(event: RunEvent): {
  record: Record<string, unknown>;
  phase: RunPhase;
  attempt: number;
} {
  const record = payloadRecord(event);
  if (!isRunPhase(record.phase)) {
    throw new StateTransitionError(
      "invalid-phase",
      `Unsupported phase: ${String(record.phase)}.`,
    );
  }
  return {
    record,
    phase: record.phase,
    attempt: requirePositiveInteger(record, "attempt"),
  };
}

function currentAttempt(
  state: RunState,
  phase: RunPhase,
): PhaseAttempt | undefined {
  return state.phases[phase]?.attempts.at(-1);
}

function assertCurrentAttempt(
  state: RunState,
  phase: RunPhase,
  attemptNumber: number,
  expected: readonly PhaseAttemptStatus[],
): PhaseAttempt {
  const attempt = currentAttempt(state, phase);
  if (!attempt || attempt.attempt !== attemptNumber) {
    throw new StateTransitionError(
      "attempt-mismatch",
      `Phase ${phase} attempt ${attemptNumber} is not current.`,
    );
  }
  if (!expected.includes(attempt.status)) {
    throw new StateTransitionError(
      "illegal-phase-transition",
      `Phase ${phase} attempt ${attemptNumber} is ${attempt.status}; expected ${expected.join(" or ")}.`,
    );
  }
  return attempt;
}

function cloneState(state: RunState): RunState {
  const phases: RunState["phases"] = {};
  for (const phase of RUN_PHASES) {
    const existing = state.phases[phase];
    if (existing)
      phases[phase] = {
        phase,
        attempts: existing.attempts.map((attempt) => ({ ...attempt })),
      };
  }
  return {
    ...state,
    phases,
    nodes: Object.fromEntries(
      Object.entries(state.nodes).map(([id, node]) => [
        id,
        {
          ...node,
          ...(node.evidence ? { evidence: [...node.evidence] } : {}),
          ...(node.verificationResults
            ? {
                verificationResults: node.verificationResults.map((result) => ({
                  ...result,
                })),
              }
            : {}),
        },
      ]),
    ),
    effects: { ...state.effects },
    idempotencyKeys: { ...state.idempotencyKeys },
    eventIds: { ...state.eventIds },
  };
}

function assertEnvelopeContinuation(state: RunState, event: RunEvent): void {
  if (event.runId !== state.runId || event.repository !== state.repository) {
    throw new StateTransitionError(
      "run-identity-mismatch",
      "Event run/repository does not match the current state.",
    );
  }
  if (event.sequence !== state.sequence + 1) {
    throw new StateTransitionError(
      "sequence-gap",
      `Expected sequence ${state.sequence + 1}, received ${event.sequence}.`,
    );
  }
  if (event.previousEventHash !== state.lastEventHash) {
    throw new StateTransitionError(
      "hash-chain-break",
      "Event previousEventHash does not match the current event hash.",
    );
  }
  if (state.eventIds[event.eventId]) {
    throw new StateTransitionError(
      "duplicate-event",
      `Event ${event.eventId} was already applied.`,
    );
  }
  const prior = state.idempotencyKeys[event.idempotencyKey];
  if (prior) {
    throw new StateTransitionError(
      "duplicate-idempotency-key",
      `Idempotency key ${event.idempotencyKey} was already consumed by ${prior}.`,
    );
  }
}

function assertLeaseEpoch(state: RunState, event: RunEvent): void {
  const epoch = state.lease?.epoch ?? state.leaseBinding?.epoch;
  const ownerRunId = state.lease?.ownerRunId ?? state.leaseBinding?.ownerRunId;
  if (epoch === undefined || ownerRunId === undefined)
    throw new StateTransitionError(
      "missing-lease",
      `${event.type} requires active repository lease authority.`,
    );
  if (event.actor.leaseEpoch !== epoch) {
    throw new StateTransitionError(
      "stale-lease-epoch",
      `Event lease epoch ${event.actor.leaseEpoch} does not match ${epoch}.`,
    );
  }
  if (state.lease && event.runId !== ownerRunId) {
    throw new StateTransitionError(
      "lease-owner-mismatch",
      "Standalone event run does not own the repository lease.",
    );
  }
}

function assertPreviousPhaseComplete(state: RunState, phase: RunPhase): void {
  const index = RUN_PHASES.indexOf(phase);
  if (index === 0) return;
  const previousPhase = RUN_PHASES[index - 1];
  if (!previousPhase) return;
  const previous = currentAttempt(state, previousPhase);
  if (!previous || previous.status !== "completed") {
    throw new StateTransitionError(
      "previous-phase-incomplete",
      `Phase ${phase} requires completed phase ${previousPhase}.`,
    );
  }
}

function replaceAttempt(
  state: RunState,
  phase: RunPhase,
  updated: PhaseAttempt,
): void {
  const phaseState = state.phases[phase];
  if (!phaseState)
    throw new StateTransitionError(
      "missing-phase",
      `Phase ${phase} has not been queued.`,
    );
  state.phases[phase] = {
    phase,
    attempts: [...phaseState.attempts.slice(0, -1), updated],
  };
}

function applyLeaseEvent(state: RunState, event: RunEvent): void {
  if (state.leaseBinding)
    throw new StateTransitionError(
      "bound-run-lease-mutation",
      "An orchestration-bound child cannot mutate the repository lease.",
    );
  const lease = payloadRecord(event).lease;
  validateRepositoryLease(lease);
  if (
    lease.repository !== state.repository ||
    lease.ownerRunId !== state.runId
  ) {
    throw new StateTransitionError(
      "lease-identity-mismatch",
      "Lease does not belong to this repository/run.",
    );
  }
  if (event.type === "lease.acquired") {
    if (state.lease)
      throw new StateTransitionError(
        "lease-already-exists",
        "Run already has a lease.",
      );
    if (lease.epoch !== 1)
      throw new StateTransitionError(
        "invalid-lease-epoch",
        "Initial lease epoch must be 1.",
      );
  } else {
    if (!state.lease)
      throw new StateTransitionError(
        "missing-lease",
        `${event.type} requires an existing lease.`,
      );
    if (event.type === "lease.heartbeat" && lease.epoch !== state.lease.epoch) {
      throw new StateTransitionError(
        "stale-lease-epoch",
        "Heartbeat cannot change lease epoch.",
      );
    }
    if (
      event.type === "lease.taken-over" &&
      lease.epoch !== state.lease.epoch + 1
    ) {
      throw new StateTransitionError(
        "invalid-lease-epoch",
        "Takeover must increment the lease epoch exactly once.",
      );
    }
  }
  if (event.actor.leaseEpoch !== lease.epoch) {
    throw new StateTransitionError(
      "stale-lease-epoch",
      "Lease event actor epoch must equal the resulting lease epoch.",
    );
  }
  state.lease = lease;
}

function applyLeaseRelease(state: RunState, event: RunEvent): void {
  if (state.leaseBinding)
    throw new StateTransitionError(
      "bound-run-lease-release",
      "An orchestration-bound child cannot release the repository lease.",
    );
  assertLeaseEpoch(state, event);
  if (state.status !== "completed" && state.status !== "cancelled") {
    throw new StateTransitionError(
      "run-not-terminal",
      "Repository lease can only be released after a terminal run event.",
    );
  }
  const payload = payloadRecord(event);
  if (
    payload.ownerRunId !== state.runId ||
    payload.epoch !== state.lease?.epoch
  ) {
    throw new StateTransitionError(
      "lease-owner-mismatch",
      "Lease release does not match the current run and epoch.",
    );
  }
  state.lease = undefined;
}

function applyPhaseQueued(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const { record, phase, attempt } = requirePhasePayload(event);
  const restartAction = requireString(record, "restartAction");
  const prior = currentAttempt(state, phase);

  if (prior) {
    if (attempt !== prior.attempt + 1) {
      throw new StateTransitionError(
        "attempt-gap",
        `Expected ${phase} attempt ${prior.attempt + 1}, received ${attempt}.`,
      );
    }
    if (
      !(["failed", "blocked", "needs-human", "abandoned"] as const).includes(
        prior.status as never,
      )
    ) {
      throw new StateTransitionError(
        "illegal-retry",
        `Cannot retry ${phase} from ${prior.status}.`,
      );
    }
    if (
      (prior.status === "blocked" || prior.status === "needs-human") &&
      event.actor.leaseEpoch <= prior.leaseEpoch
    ) {
      throw new StateTransitionError(
        "takeover-required",
        `Retrying ${phase} from ${prior.status} requires a newer lease epoch.`,
      );
    }
  } else {
    if (attempt !== 1)
      throw new StateTransitionError(
        "attempt-gap",
        `First ${phase} attempt must be 1.`,
      );
    assertPreviousPhaseComplete(state, phase);
  }

  const queued: PhaseAttempt = {
    attempt,
    status: "queued",
    leaseEpoch: event.actor.leaseEpoch,
    restartAction,
    evidence: [],
    ...(typeof record.inputArtifactHash === "string"
      ? { inputArtifactHash: record.inputArtifactHash }
      : {}),
  };
  state.phases[phase] = {
    phase,
    attempts: [...(state.phases[phase]?.attempts ?? []), queued],
  };
  state.status = "active";
}

function applyPhaseStarted(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const { record, phase, attempt } = requirePhasePayload(event);
  const current = assertCurrentAttempt(state, phase, attempt, ["queued"]);
  const started: PhaseAttempt = {
    ...current,
    status: "running",
    logicalNodeId: requireString(record, "logicalNodeId"),
    startedAt: event.occurredAt,
    ...(typeof record.subagentRunId === "string"
      ? { subagentRunId: record.subagentRunId }
      : {}),
    ...(typeof record.worktreePath === "string"
      ? { worktreePath: record.worktreePath }
      : {}),
    ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
    ...(typeof record.baseSha === "string" ? { baseSha: record.baseSha } : {}),
  };
  replaceAttempt(state, phase, started);
}

function applyPhaseCompleted(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const { record, phase, attempt } = requirePhasePayload(event);
  const current = assertCurrentAttempt(state, phase, attempt, ["running"]);
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const completed: PhaseAttempt = {
    ...current,
    status: "completed",
    evidence,
    finishedAt: event.occurredAt,
    ...(typeof record.outputArtifactHash === "string"
      ? { outputArtifactHash: record.outputArtifactHash }
      : {}),
    ...(typeof record.commitSha === "string"
      ? { commitSha: record.commitSha }
      : {}),
  };
  replaceAttempt(state, phase, completed);
}

function applyPhaseStopped(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const { record, phase, attempt } = requirePhasePayload(event);
  const current = assertCurrentAttempt(state, phase, attempt, [
    "queued",
    "running",
  ]);
  const statusByType = {
    "phase.failed": "failed",
    "phase.blocked": "blocked",
    "phase.needs-human": "needs-human",
    "phase.abandoned": "abandoned",
  } as const;
  const status = statusByType[event.type as keyof typeof statusByType];
  if (!status)
    throw new StateTransitionError(
      "invalid-event",
      `${event.type} is not a stopped phase event.`,
    );
  replaceAttempt(state, phase, {
    ...current,
    status,
    reason: requireString(record, "reason"),
    finishedAt: event.occurredAt,
  });
  state.status =
    status === "needs-human"
      ? "needs-human"
      : status === "blocked"
        ? "blocked"
        : "failed";
}

function applyNodeEvent(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const record = payloadRecord(event) as Partial<NodeEventPayload>;
  if (
    typeof record.nodeId !== "string" ||
    !record.nodeId.trim() ||
    typeof record.node !== "string" ||
    !record.node.trim()
  )
    throw new StateTransitionError(
      "invalid-node",
      "Node events require nodeId and node.",
    );
  if (!Number.isSafeInteger(record.attempt) || (record.attempt as number) < 1)
    throw new StateTransitionError(
      "invalid-node",
      "Node attempt must be positive.",
    );
  const prior = state.nodes[record.nodeId];
  const statusByType = {
    "node.queued": "queued",
    "node.started": "running",
    "node.resumed": "running",
    "node.completed": "completed",
    "node.failed": "failed",
    "node.blocked": "blocked",
    "node.needs-human": "needs-human",
    "reviewer.artifact-published": "completed",
  } as const;
  const status = statusByType[event.type as keyof typeof statusByType];
  if (!status)
    throw new StateTransitionError(
      "invalid-node-event",
      `Unsupported node event ${event.type}.`,
    );
  if (event.type === "node.queued") {
    if (prior && prior.status === "running")
      throw new StateTransitionError(
        "node-running",
        `Node ${record.nodeId} is already running.`,
      );
    if (prior && prior.status === "completed")
      throw new StateTransitionError(
        "node-completed",
        `Node ${record.nodeId} is already complete.`,
      );
    if (prior && ["failed", "blocked", "needs-human"].includes(prior.status))
      throw new StateTransitionError(
        "node-terminal",
        `Node ${record.nodeId} is immutable after ${prior.status}.`,
      );
  } else if (
    !prior ||
    prior.status !== (event.type === "node.started" ? "queued" : "running")
  ) {
    throw new StateTransitionError(
      "illegal-node-transition",
      `Node ${record.nodeId} cannot transition to ${status}.`,
    );
  }
  if (event.type === "reviewer.artifact-published") {
    if (
      prior?.node !== "review-correctness" &&
      prior?.node !== "review-security"
    )
      throw new StateTransitionError(
        "invalid-reviewer-artifact",
        `Node ${record.nodeId} is not a reviewer node.`,
      );
    if (
      !Number.isSafeInteger(record.publishedCommentId) ||
      (record.publishedCommentId as number) < 1
    )
      throw new StateTransitionError(
        "invalid-reviewer-artifact",
        `Node ${record.nodeId} requires a published GitHub comment ID.`,
      );
  }
  if (event.type === "node.resumed") {
    if (
      typeof record.subagentRunId !== "string" ||
      typeof record.previousSubagentRunId !== "string" ||
      record.previousSubagentRunId !== prior?.subagentRunId
    )
      throw new StateTransitionError(
        "invalid-node-resume",
        `Node ${record.nodeId} resume must replace its current subagent run.`,
      );
    const expectedRetries = (prior.transportRetries ?? 0) + 1;
    if (record.transportRetries !== expectedRetries)
      throw new StateTransitionError(
        "invalid-node-resume",
        `Node ${record.nodeId} expected transport retry ${expectedRetries}.`,
      );
  }
  state.nodes[record.nodeId] = {
    ...(prior ?? {}),
    nodeId: record.nodeId,
    node: record.node,
    attempt: record.attempt as number,
    status,
    ...(typeof record.headSha === "string" ? { headSha: record.headSha } : {}),
    ...(typeof record.baseSha === "string" ? { baseSha: record.baseSha } : {}),
    ...(typeof record.subagentRunId === "string"
      ? { subagentRunId: record.subagentRunId }
      : {}),
    ...(typeof record.previousSubagentRunId === "string"
      ? { previousSubagentRunId: record.previousSubagentRunId }
      : {}),
    ...(Number.isSafeInteger(record.transportRetries) &&
    (record.transportRetries as number) >= 0
      ? { transportRetries: record.transportRetries as number }
      : {}),
    ...(typeof record.resultPath === "string"
      ? { resultPath: record.resultPath }
      : {}),
    ...(record.reviewerResult && typeof record.reviewerResult === "object"
      ? { reviewerResult: record.reviewerResult }
      : {}),
    ...(Number.isSafeInteger(record.publishedCommentId)
      ? { publishedCommentId: record.publishedCommentId as number }
      : {}),
    ...(record.finalReviewDecision &&
    typeof record.finalReviewDecision === "object"
      ? { finalReviewDecision: record.finalReviewDecision }
      : {}),
    ...(Array.isArray(record.verificationResults)
      ? {
          verificationResults: record.verificationResults.map((result) => ({
            ...result,
          })),
        }
      : {}),
    ...(typeof record.outcome === "string" ? { outcome: record.outcome } : {}),
    ...(Array.isArray(record.evidence)
      ? {
          evidence: record.evidence.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(status === "running" && !prior?.startedAt
      ? { startedAt: event.occurredAt }
      : {}),
    ...(status !== "queued" && status !== "running"
      ? { finishedAt: event.occurredAt }
      : {}),
  };
  if (status === "failed") state.status = "failed";
  if (status === "blocked") state.status = "blocked";
  if (status === "needs-human") state.status = "needs-human";
}

function applyEffect(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const record = payloadRecord(event);
  const effectId = requireString(record, "effectId");
  if (state.effects[effectId]) {
    throw new StateTransitionError(
      "duplicate-effect",
      `Effect ${effectId} is already recorded.`,
    );
  }
  const effectType = record.effectType;
  const supported = [
    "github-comment",
    "github-label",
    "push",
    "pull-request",
    "merge",
    "issue-close",
    "cleanup",
  ];
  if (typeof effectType !== "string" || !supported.includes(effectType)) {
    throw new StateTransitionError(
      "invalid-effect",
      `Unsupported effect type: ${String(effectType)}.`,
    );
  }
  state.effects[effectId] = {
    effectType: effectType as RecordedEffect["effectType"],
    effectId,
    digest: requireString(record, "digest"),
    eventId: event.eventId,
  };
}

function createInitialState(event: RunEvent): RunState {
  if (
    event.type !== "run.created" ||
    event.sequence !== 1 ||
    event.previousEventHash !== null
  ) {
    throw new StateTransitionError(
      "invalid-genesis",
      "The first event must be run.created at sequence 1 with no previous hash.",
    );
  }
  if (event.actor.leaseEpoch !== 0) {
    throw new StateTransitionError(
      "invalid-genesis",
      "run.created must use lease epoch 0.",
    );
  }
  const payload = payloadRecord(event);
  const issueNumber = requirePositiveInteger(payload, "issueNumber");
  const integrationBranch = requireString(payload, "integrationBranch");
  const protectedBranch = requireString(payload, "protectedBranch");
  const orchestrationRunId =
    typeof payload.orchestrationRunId === "string"
      ? requireString(payload, "orchestrationRunId")
      : undefined;
  const leaseEpoch = orchestrationRunId
    ? requirePositiveInteger(payload, "leaseEpoch")
    : undefined;
  const eventHash = hashRunEvent(event);
  return {
    schema: RUN_STATE_SCHEMA,
    runId: event.runId,
    repository: event.repository,
    issueNumber,
    integrationBranch,
    protectedBranch,
    status: "active",
    ...(orchestrationRunId && leaseEpoch
      ? { leaseBinding: { ownerRunId: orchestrationRunId, epoch: leaseEpoch } }
      : {}),
    sequence: event.sequence,
    lastEventHash: eventHash,
    phases: {},
    nodes: {},
    effects: {},
    idempotencyKeys: { [event.idempotencyKey]: event.eventId },
    eventIds: { [event.eventId]: true },
  };
}

export function applyRunEvent(
  current: RunState | undefined,
  event: RunEvent,
): RunState {
  validateRunEvent(event);
  if (!current) return createInitialState(event);
  assertEnvelopeContinuation(current, event);
  if (current.status === "completed" || current.status === "cancelled") {
    if (event.type !== "lease.released")
      throw new StateTransitionError(
        "terminal-run",
        "Terminal runs reject further mutations.",
      );
  }
  const state = cloneState(current);

  switch (event.type) {
    case "run.created":
      throw new StateTransitionError(
        "duplicate-run",
        "run.created can only be the genesis event.",
      );
    case "lease.acquired":
    case "lease.heartbeat":
    case "lease.taken-over":
      applyLeaseEvent(state, event);
      break;
    case "lease.released":
      applyLeaseRelease(state, event);
      break;
    case "phase.queued":
      applyPhaseQueued(state, event);
      break;
    case "phase.started":
      applyPhaseStarted(state, event);
      break;
    case "phase.completed":
      applyPhaseCompleted(state, event);
      break;
    case "phase.failed":
    case "phase.blocked":
    case "phase.needs-human":
    case "phase.abandoned":
      applyPhaseStopped(state, event);
      break;
    case "node.queued":
    case "node.started":
    case "node.resumed":
    case "node.completed":
    case "node.failed":
    case "node.blocked":
    case "node.needs-human":
    case "reviewer.artifact-published":
      applyNodeEvent(state, event);
      break;
    case "effect.recorded":
      applyEffect(state, event);
      break;
    case "run.completed": {
      assertLeaseEpoch(state, event);
      if (state.status !== "active")
        throw new StateTransitionError(
          "run-not-active",
          "Only an active nonterminal run can complete.",
        );
      const cleanup = currentAttempt(state, "cleanup");
      const cleanupNode = Object.values(state.nodes).find(
        (node) => node.node === "cleanup" && node.status === "completed",
      );
      if ((!cleanup || cleanup.status !== "completed") && !cleanupNode) {
        throw new StateTransitionError(
          "cleanup-incomplete",
          "Run cannot complete before cleanup completes.",
        );
      }
      const payload = payloadRecord(event);
      const outcome = payload.outcome;
      if (outcome !== "merged" && outcome !== "closed") {
        throw new StateTransitionError(
          "invalid-outcome",
          `Unsupported run outcome: ${String(outcome)}.`,
        );
      }
      if (outcome === "merged") {
        if (
          !Number.isSafeInteger(payload.pullNumber) ||
          (payload.pullNumber as number) < 1
        )
          throw new StateTransitionError(
            "missing-pull-number",
            "Merged completion requires a pull number.",
          );
        state.pullNumber = payload.pullNumber as number;
      }
      state.status = "completed";
      state.outcome = outcome;
      break;
    }
    case "run.cancelled":
      assertLeaseEpoch(state, event);
      state.status = "cancelled";
      state.cancellationReason = requireString(payloadRecord(event), "reason");
      break;
  }

  state.sequence = event.sequence;
  state.lastEventHash = hashRunEvent(event);
  state.idempotencyKeys[event.idempotencyKey] = event.eventId;
  state.eventIds[event.eventId] = true;
  return state;
}

export function replayRunEvents(events: readonly RunEvent[]): RunState {
  if (events.length === 0)
    throw new StateTransitionError(
      "empty-journal",
      "Cannot replay an empty run journal.",
    );
  let state: RunState | undefined;
  for (const event of events) state = applyRunEvent(state, event);
  if (!state)
    throw new StateTransitionError(
      "empty-journal",
      "Cannot replay an empty run journal.",
    );
  return state;
}

export function getCurrentPhase(state: RunState): RunPhase | undefined {
  for (const phase of RUN_PHASES) {
    const attempt = currentAttempt(state, phase);
    if (!attempt || attempt.status !== "completed") return phase;
  }
  return undefined;
}

export function isTerminalRunState(state: RunState): boolean {
  return state.status === "completed" || state.status === "cancelled";
}

export type {
  PhaseCompletedPayload,
  PhaseQueuedPayload,
  PhaseStartedPayload,
  PhaseStoppedPayload,
  RunCreatedPayload,
};
