import {
  isBuilderContractArtifact,
  normalizeBuilderContractArtifact,
  type BuilderContractArtifact,
} from "./builder-contract.ts";
import {
  hashRunEvent,
  isRunPhase,
  RUN_PHASES,
  type EffectRecordedPayload,
  type PhaseAttemptStatus,
  type ContractExtendedPayload,
  type PhaseCompletedPayload,
  type PhaseQueuedPayload,
  type PhaseStartedPayload,
  type PhaseStoppedPayload,
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
  contractHash?: string;
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
  builderContract?: BuilderContractArtifact;
  builderContractHistory?: readonly BuilderContractArtifact[];
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
      ? { builderContract: { ...state.builderContract, allowedPaths: state.builderContract.allowedPaths.map((entry) => ({ ...entry })) } }
      : {}),
    ...(state.builderContractHistory
      ? {
          builderContractHistory: state.builderContractHistory.map((contract) => ({
            ...contract,
            allowedPaths: contract.allowedPaths.map((entry) => ({ ...entry })),
          })),
        }
      : {}),
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

function requireBoundContractHash(
  state: RunState,
  phase: RunPhase,
  record: Record<string, unknown>,
): string | undefined {
  if (!state.builderContract || phase === "resolve" || phase === "investigate" || phase === "plan" || phase === "close" || phase === "cleanup") {
    return typeof record.contractHash === "string"
      ? record.contractHash
      : undefined;
  }
  const contractHash = record.contractHash;
  if (typeof contractHash !== "string" || contractHash !== state.builderContract.contractHash) {
    throw new StateTransitionError(
      "contract-hash-mismatch",
      `Phase ${phase} must bind accepted builder contract ${state.builderContract.contractHash}.`,
    );
  }
  return contractHash;
}

function applyPhaseQueued(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const { record, phase, attempt } = requirePhasePayload(event);
  const contractHash = requireBoundContractHash(state, phase, record);
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
    ...(contractHash ? { contractHash } : {}),
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
  const contractHash = requireBoundContractHash(state, phase, record);
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
    ...(contractHash ? { contractHash } : {}),
  };
  replaceAttempt(state, phase, started);
}

function applyPhaseCompleted(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const { record, phase, attempt } = requirePhasePayload(event);
  const contractHash = requireBoundContractHash(state, phase, record);
  const current = assertCurrentAttempt(state, phase, attempt, ["running"]);
  let builderContract = state.builderContract;
  if (phase === "plan") {
    if (!isBuilderContractArtifact(record.builderContract)) {
      throw new StateTransitionError(
        "missing-builder-contract",
        "Plan completion must persist a schema-valid builder contract artifact.",
      );
    }
    builderContract = normalizeBuilderContractArtifact(record.builderContract);
    if (record.contractHash !== builderContract.contractHash) {
      throw new StateTransitionError(
        "contract-hash-mismatch",
        "Plan completion contractHash does not match its builder contract artifact.",
      );
    }
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
    ...(phase === "plan" && builderContract
      ? { contractHash: builderContract.contractHash }
      : contractHash
        ? { contractHash }
        : {}),
    ...(typeof record.outputArtifactHash === "string"
      ? { outputArtifactHash: record.outputArtifactHash }
      : {}),
    ...(typeof record.commitSha === "string"
      ? { commitSha: record.commitSha }
      : {}),
  };
  replaceAttempt(state, phase, completed);
  if (phase === "plan" && builderContract) {
    state.builderContract = builderContract;
    state.builderContractHistory = [builderContract];
  }
}

function applyContractExtended(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const payload = payloadRecord(event) as Partial<ContractExtendedPayload>;
  if (payload.phase !== "review" || !Number.isSafeInteger(payload.attempt)) {
    throw new StateTransitionError(
      "invalid-contract-extension",
      "Contract extensions must target a review attempt.",
    );
  }
  const attemptNumber = payload.attempt as number;
  const currentAttemptState = assertCurrentAttempt(
    state,
    "review",
    attemptNumber,
    ["running"],
  );
  if (!state.builderContract) {
    throw new StateTransitionError(
      "missing-builder-contract",
      "Cannot extend a missing builder contract.",
    );
  }
  if (!isBuilderContractArtifact(payload.builderContract)) {
    throw new StateTransitionError(
      "invalid-contract-extension",
      "Contract extension must contain a schema-valid builder contract artifact.",
    );
  }
  const extension = normalizeBuilderContractArtifact(payload.builderContract);
  if (
    payload.contractHash !== extension.contractHash ||
    payload.supersedes !== state.builderContract.contractHash ||
    extension.supersedes !== state.builderContract.contractHash ||
    extension.revision !== state.builderContract.revision + 1 ||
    typeof payload.reason !== "string" ||
    !payload.reason.trim() ||
    extension.reason !== payload.reason
  ) {
    throw new StateTransitionError(
      "invalid-contract-extension",
      "Contract extension must increment revision and supersede the accepted contract with an auditable reason.",
    );
  }
  const previousContract = state.builderContract;
  state.builderContract = extension;
  state.builderContractHistory = [
    ...(state.builderContractHistory ?? (previousContract ? [previousContract] : [])),
    extension,
  ];
  replaceAttempt(state, "review", {
    ...currentAttemptState,
    contractHash: extension.contractHash,
  });
}

function applyPhaseStopped(state: RunState, event: RunEvent): void {
  assertLeaseEpoch(state, event);
  const { record, phase, attempt } = requirePhasePayload(event);
  const contractHash = requireBoundContractHash(state, phase, record);
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
    ...(contractHash ? { contractHash } : {}),
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
    case "contract.extended":
      applyContractExtended(state, event);
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
