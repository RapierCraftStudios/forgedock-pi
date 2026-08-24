import { createHash, randomUUID } from "node:crypto";

import { type BuilderContractArtifact } from "./builder-contract.ts";
import { FORGEDOCK_EVENT_SCHEMA } from "./version.ts";

export const RUN_PHASES = [
  "resolve",
  "investigate",
  "plan",
  "prepare-worktree",
  "implement",
  "verify",
  "review",
  "merge",
  "close",
  "cleanup",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export const PHASE_ATTEMPT_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "blocked",
  "needs-human",
  "abandoned",
] as const;

export type PhaseAttemptStatus = (typeof PHASE_ATTEMPT_STATUSES)[number];

export type RunEventType =
  | "run.created"
  | "lease.acquired"
  | "lease.heartbeat"
  | "lease.taken-over"
  | "lease.released"
  | "phase.queued"
  | "phase.started"
  | "phase.completed"
  | "phase.failed"
  | "phase.blocked"
  | "phase.needs-human"
  | "phase.abandoned"
  | "contract.extended"
  | "effect.recorded"
  | "run.completed"
  | "run.cancelled";

export interface EventActor {
  kind: "extension" | "human";
  sessionId: string;
  leaseEpoch: number;
  login?: string;
}

export interface RunCreatedPayload {
  issueNumber: number;
  integrationBranch: string;
  protectedBranch: string;
}

export interface PhaseQueuedPayload {
  phase: RunPhase;
  attempt: number;
  restartAction: string;
  inputArtifactHash?: string;
  contractHash?: string;
}

export interface PhaseStartedPayload {
  phase: RunPhase;
  attempt: number;
  logicalNodeId: string;
  subagentRunId?: string;
  worktreePath?: string;
  branch?: string;
  baseSha?: string;
  contractHash?: string;
}

export interface PhaseCompletedPayload {
  phase: RunPhase;
  attempt: number;
  outputArtifactHash?: string;
  commitSha?: string;
  evidence?: readonly string[];
  contractHash?: string;
  builderContract?: BuilderContractArtifact;
}

export interface ContractExtendedPayload {
  phase: "review";
  attempt: number;
  contractHash: string;
  builderContract: BuilderContractArtifact;
  supersedes: string;
  reason: string;
}

export interface PhaseStoppedPayload {
  phase: RunPhase;
  attempt: number;
  reason: string;
}

export interface EffectRecordedPayload {
  effectType:
    | "github-comment"
    | "github-label"
    | "push"
    | "pull-request"
    | "merge"
    | "issue-close"
    | "cleanup";
  effectId: string;
  digest: string;
}

export interface RunCompletedPayload {
  outcome: "merged" | "closed";
}

export interface RunCancelledPayload {
  reason: string;
}

export type RunEventPayload =
  | RunCreatedPayload
  | PhaseQueuedPayload
  | PhaseStartedPayload
  | PhaseCompletedPayload
  | PhaseStoppedPayload
  | EffectRecordedPayload
  | RunCompletedPayload
  | RunCancelledPayload
  | Record<string, unknown>;

export interface RunEvent<TPayload extends RunEventPayload = RunEventPayload> {
  schema: typeof FORGEDOCK_EVENT_SCHEMA;
  eventId: string;
  runId: string;
  repository: string;
  sequence: number;
  previousEventHash: string | null;
  type: RunEventType;
  actor: EventActor;
  occurredAt: string;
  idempotencyKey: string;
  payload: TPayload;
}

export interface CreateRunEventInput<TPayload extends RunEventPayload> {
  runId: string;
  repository: string;
  sequence: number;
  previousEventHash: string | null;
  type: RunEventType;
  actor: EventActor;
  idempotencyKey: string;
  payload: TPayload;
  eventId?: string;
  occurredAt?: string;
}

export class EventValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EventValidationError";
    this.code = code;
  }
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new EventValidationError(
    "non-json-value",
    `Cannot canonicalize ${typeof value}.`,
  );
}

export function hashRunEvent(event: RunEvent): string {
  return `sha256:${createHash("sha256").update(canonicalJson(event)).digest("hex")}`;
}

export function createRunEvent<TPayload extends RunEventPayload>(
  input: CreateRunEventInput<TPayload>,
): RunEvent<TPayload> {
  const event: RunEvent<TPayload> = {
    schema: FORGEDOCK_EVENT_SCHEMA,
    eventId: input.eventId ?? randomUUID(),
    runId: input.runId,
    repository: input.repository,
    sequence: input.sequence,
    previousEventHash: input.previousEventHash,
    type: input.type,
    actor: input.actor,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  };
  validateRunEvent(event);
  return event;
}

function requireNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) {
    throw new EventValidationError(
      "invalid-field",
      `${field} must be a non-empty trimmed string.`,
    );
  }
}

export function validateRunEvent(value: unknown): asserts value is RunEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EventValidationError(
      "invalid-event",
      "Run event must be an object.",
    );
  }

  const event = value as Partial<RunEvent>;
  if (event.schema !== FORGEDOCK_EVENT_SCHEMA) {
    throw new EventValidationError(
      "unsupported-schema",
      `Unsupported event schema: ${String(event.schema)}.`,
    );
  }
  requireNonEmptyString(event.eventId, "eventId");
  requireNonEmptyString(event.runId, "runId");
  requireNonEmptyString(event.repository, "repository");
  requireNonEmptyString(event.idempotencyKey, "idempotencyKey");
  if (!Number.isSafeInteger(event.sequence) || (event.sequence ?? 0) < 1) {
    throw new EventValidationError(
      "invalid-sequence",
      "sequence must be a positive safe integer.",
    );
  }
  if (event.previousEventHash !== null)
    requireNonEmptyString(event.previousEventHash, "previousEventHash");
  if (!event.type || !RUN_EVENT_TYPES.has(event.type)) {
    throw new EventValidationError(
      "unsupported-event-type",
      `Unsupported event type: ${String(event.type)}.`,
    );
  }
  if (!event.actor || typeof event.actor !== "object") {
    throw new EventValidationError("invalid-actor", "actor must be an object.");
  }
  if (event.actor.kind !== "extension" && event.actor.kind !== "human") {
    throw new EventValidationError(
      "invalid-actor",
      "actor.kind must be extension or human.",
    );
  }
  requireNonEmptyString(event.actor.sessionId, "actor.sessionId");
  if (
    !Number.isSafeInteger(event.actor.leaseEpoch) ||
    event.actor.leaseEpoch < 0
  ) {
    throw new EventValidationError(
      "invalid-actor",
      "actor.leaseEpoch must be a non-negative safe integer.",
    );
  }
  requireNonEmptyString(event.occurredAt, "occurredAt");
  if (Number.isNaN(Date.parse(event.occurredAt))) {
    throw new EventValidationError(
      "invalid-timestamp",
      "occurredAt must be an RFC3339-compatible timestamp.",
    );
  }
  if (
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    throw new EventValidationError(
      "invalid-payload",
      "payload must be an object.",
    );
  }
}

const RUN_EVENT_TYPES: ReadonlySet<RunEventType> = new Set([
  "run.created",
  "lease.acquired",
  "lease.heartbeat",
  "lease.taken-over",
  "lease.released",
  "phase.queued",
  "phase.started",
  "phase.completed",
  "phase.failed",
  "phase.blocked",
  "phase.needs-human",
  "phase.abandoned",
  "contract.extended",
  "effect.recorded",
  "run.completed",
  "run.cancelled",
]);

export function isRunPhase(value: unknown): value is RunPhase {
  return (
    typeof value === "string" &&
    (RUN_PHASES as readonly string[]).includes(value)
  );
}
