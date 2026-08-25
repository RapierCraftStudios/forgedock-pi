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
  type RunCreatedPayload,
  type RunEvent,
  type RunPhase,
  validateRunEvent,
} from "./events.ts";
import {
  hashBuilderContract,
  normalizeBuilderContract,
  validateBuilderContractRevision,
  type BuilderContract,
  type BuilderContractRevision,
} from "./builder-contract.ts";
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
  contractHash?: string;
  contractRevision?: number;
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

export interface AcceptedBuilderContract {
  contract: BuilderContract;
  contractHash: string;
  revision: number;
  source: "plan" | "review-fix";
  eventId: string;
  previousContractHash?: string;
  reason?: string;
}

export interface RecordedEffect {
  effectType: EffectRecordedPayload["effectType"];
  effectId: string;
  digest: string;
  eventId: string;
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
  phases: Partial<Record<RunPhase, PhaseState>>;
  effects: Record<string, RecordedEffect>;
  builderContract?: AcceptedBuilderContract;
  contractRevisions: readonly BuilderContractRevision[];
  idempotencyKeys: Record<string, string>;
  eventIds: Record<string, true>;
  outcome?: "merged" | "closed";
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
    effects: { ...state.effects },
    ...(state.builderContract
      ? {
          builderContract: {
            ...state.builderContract,
            contract: {
              ...state.builderContract.contract,
              allowedPaths: state.builderContract.contract.allowedPaths.map(
                (rule) => ({ ...rule }),
              ),
            },
          },
        }
      : {}),
    contractRevisions: (state.contractRevisions ?? []).map((revision) => ({
      ...revision,
      contract: {
        ...revision.contract,
        allowedPaths: revision.contract.allowedPaths.map((rule) => ({ ...rule })),
      },
    })),
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
  if (!state.lease)
    throw new StateTransitionError(
      "missing-lease",
      `${event.type} requires an active repository lease.`,
    );
  if (event.actor.leaseEpoch !== state.lease.epoch) {
    throw new StateTransitionError(
      "stale-lease-epoch",
      `Event lease epoch ${event.actor.leaseEpoch} does not match ${state.lease.epoch}.`,
    );
  }
  if (event.runId !== state.lease.ownerRunId) {
    throw new StateTransitionError(
      "lease-owner-mismatch",
      "Event run does not own the repository lease.",
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
  assertContractBinding(state, phase, record);
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
    ...(typeof record.contractHash === "string"
      ? { contractHash: record.contractHash }
      : {}),
    ...(Number.isSafeInteger(record.contractRevision)
      ? { contractRevision: record.contractRevision as number }
      : {}),
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

function assertContractBinding(
  state: RunState,
  phase: RunPhase,
  record: Record<string, unknown>,
): void {
  if (!state.builderContract) return;
  if (phase !== "implement" && phase !== "verify" && phase !== "review")
    return;
  if (record.contractHash !== state.builderContract.contractHash) {
    throw new StateTransitionError(
      "contract-hash-mismatch",
      `Phase ${phase} must bind accepted builder contract ${state.builderContract.contractHash}.`,
    );
  }
  if (record.contractRevision !== state.builderContract.revision) {
    throw new StateTransitionError(
      "contract-revision-mismatch",
      `Phase ${phase} must bind builder contract revision ${state.builderContract.revision}.`,
    );
  }
}

function applyPhaseStarted(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const { record, phase, attempt } = requirePhasePayload(event);
  const current = assertCurrentAttempt(state, phase, attempt, ["queued"]);
  assertContractBinding(state, phase, record);
  const started: PhaseAttempt = {
    ...current,
    status: "running",
    logicalNodeId: requireString(record, "logicalNodeId"),
    ...(typeof record.contractHash === "string"
      ? { contractHash: record.contractHash }
      : {}),
    ...(Number.isSafeInteger(record.contractRevision)
      ? { contractRevision: record.contractRevision as number }
      : {}),
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
  if (phase === "plan" && record.builderContract !== undefined) {
    let contract: BuilderContract;
    try {
      contract = normalizeBuilderContract(record.builderContract);
    } catch (error) {
      throw new StateTransitionError(
        "invalid-builder-contract",
        error instanceof Error ? error.message : String(error),
      );
    }
    const contractHash = hashBuilderContract(contract);
    if (record.contractHash !== contractHash) {
      throw new StateTransitionError(
        "contract-hash-mismatch",
        "Plan builder contract hash does not match the contract artifact.",
      );
    }
    if (record.contractRevision !== contract.revision) {
      throw new StateTransitionError(
        "contract-revision-mismatch",
        "Plan builder contract revision does not match the contract artifact.",
      );
    }
    if (state.builderContract) {
      throw new StateTransitionError(
        "contract-already-accepted",
        "A builder contract is already accepted for this run.",
      );
    }
    state.builderContract = {
      contract,
      contractHash,
      revision: contract.revision,
      source: "plan",
      eventId: event.eventId,
    };
  } else {
    assertContractBinding(state, phase, record);
  }
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
    ...(typeof record.contractHash === "string"
      ? { contractHash: record.contractHash }
      : {}),
    ...(Number.isSafeInteger(record.contractRevision)
      ? { contractRevision: record.contractRevision as number }
      : {}),
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

function applyContractRevision(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const currentReview = currentAttempt(state, "review");
  if (!currentReview || currentReview.status !== "running") {
    throw new StateTransitionError(
      "contract-revision-phase",
      "Builder contract revisions are only accepted during a running review phase.",
    );
  }
  if (!state.builderContract) {
    throw new StateTransitionError(
      "missing-builder-contract",
      "Cannot revise a builder contract before plan acceptance.",
    );
  }
  const payload = payloadRecord(event);
  try {
    validateBuilderContractRevision(payload, state.builderContract.contract);
  } catch (error) {
    throw new StateTransitionError(
      "invalid-contract-revision",
      error instanceof Error ? error.message : String(error),
    );
  }
  const revision = payload as unknown as BuilderContractRevision;
  state.builderContract = {
    contract: revision.contract,
    contractHash: revision.contractHash,
    revision: revision.revision,
    source: "review-fix",
    eventId: event.eventId,
    previousContractHash: revision.previousContractHash,
    reason: revision.reason,
  };
  state.contractRevisions = [
    ...(state.contractRevisions ?? []),
    revision,
  ];
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
  const eventHash = hashRunEvent(event);
  return {
    schema: RUN_STATE_SCHEMA,
    runId: event.runId,
    repository: event.repository,
    issueNumber,
    integrationBranch,
    protectedBranch,
    status: "active",
    sequence: event.sequence,
    lastEventHash: eventHash,
    phases: {},
    effects: {},
    contractRevisions: [],
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
    case "contract.revised":
      applyContractRevision(state, event);
      break;
    case "effect.recorded":
      applyEffect(state, event);
      break;
    case "run.completed": {
      assertLeaseEpoch(state, event);
      const cleanup = currentAttempt(state, "cleanup");
      if (!cleanup || cleanup.status !== "completed") {
        throw new StateTransitionError(
          "cleanup-incomplete",
          "Run cannot complete before cleanup completes.",
        );
      }
      const outcome = payloadRecord(event).outcome;
      if (outcome !== "merged" && outcome !== "closed") {
        throw new StateTransitionError(
          "invalid-outcome",
          `Unsupported run outcome: ${String(outcome)}.`,
        );
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
export type { BuilderContract, BuilderContractRevision } from "./builder-contract.ts";
