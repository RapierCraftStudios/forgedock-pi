import { createHash, randomUUID } from "node:crypto";

import {
  buildDag,
  findDagCycle,
  getReadyQueue,
  type Dag,
  type DagEdge,
} from "./dag.ts";
import { canonicalJson } from "./events.ts";

export const ORCHESTRATION_EVENT_SCHEMA =
  "forgedock.orchestration-event/v1" as const;
export const ORCHESTRATION_STATE_SCHEMA =
  "forgedock.orchestration-state/v1" as const;

export type OrchestrationLaneStatus =
  | "queued"
  | "running"
  | "ready"
  | "refreshing"
  | "integrating"
  | "merged"
  | "closed"
  | "blocked"
  | "needs-human"
  | "failed";

export type OrchestrationStatus =
  | "running"
  | "completed"
  | "blocked"
  | "needs-human"
  | "failed"
  | "cancelled";

export interface OrchestrationDependencyEdge {
  fromIssue: number;
  toIssue: number;
  kind: "explicit";
  reason: string;
}

export interface BlockedOrchestrationLane {
  lane: OrchestrationLane;
  blockedBy: OrchestrationLane;
  reason: string;
}

export interface OrchestrationLane {
  issueNumber: number;
  ordinal: number;
  status: OrchestrationLaneStatus;
  forgeRunId?: string;
  subagentRunId?: string;
  refreshes: number;
  pullNumber?: number;
  headSha?: string;
  baseSha?: string;
  reason?: string;
}

export interface OrchestrationState {
  schema: typeof ORCHESTRATION_STATE_SCHEMA;
  orchestrationId: string;
  repository: string;
  integrationBranch: string;
  status: OrchestrationStatus;
  maxConcurrent: number;
  leaseEpoch: number;
  sequence: number;
  lastEventHash: string;
  lanes: readonly OrchestrationLane[];
  dependencies: readonly OrchestrationDependencyEdge[];
  graphHash: string;
  idempotencyKeys: Readonly<Record<string, string>>;
  createdAt: string;
  completedAt?: string;
  reason?: string;
}

export type OrchestrationEventType =
  | "orchestration.created"
  | "lane.started"
  | "lane.recovered"
  | "lane.ready"
  | "lane.refreshing"
  | "lane.integrating"
  | "lane.merged"
  | "lane.closed"
  | "lane.blocked"
  | "lane.needs-human"
  | "lane.failed"
  | "lease.heartbeat"
  | "orchestration.completed"
  | "orchestration.cancelled";

export interface OrchestrationEvent {
  schema: typeof ORCHESTRATION_EVENT_SCHEMA;
  eventId: string;
  orchestrationId: string;
  repository: string;
  sequence: number;
  previousEventHash: string | null;
  type: OrchestrationEventType;
  occurredAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export class OrchestrationTransitionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestrationTransitionError";
    this.code = code;
  }
}

export function createOrchestrationEvent(input: {
  orchestrationId: string;
  repository: string;
  sequence: number;
  previousEventHash: string | null;
  type: OrchestrationEventType;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  eventId?: string;
  occurredAt?: string;
}): OrchestrationEvent {
  const event: OrchestrationEvent = {
    schema: ORCHESTRATION_EVENT_SCHEMA,
    eventId: input.eventId ?? randomUUID(),
    orchestrationId: requiredString(input.orchestrationId, "orchestrationId"),
    repository: requiredString(input.repository, "repository"),
    sequence: positiveInteger(input.sequence, "sequence"),
    previousEventHash: input.previousEventHash,
    type: input.type,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey"),
    payload: input.payload,
  };
  validateOrchestrationEvent(event);
  return event;
}

export function applyOrchestrationEvent(
  current: OrchestrationState | undefined,
  event: OrchestrationEvent,
): OrchestrationState {
  validateOrchestrationEvent(event);
  if (!current) return createInitialState(event);
  validateOrchestrationGraph(current);
  if (
    current.orchestrationId !== event.orchestrationId ||
    current.repository !== event.repository
  ) {
    throw new OrchestrationTransitionError(
      "identity-mismatch",
      "Orchestration event identity does not match the current state.",
    );
  }
  if (event.sequence !== current.sequence + 1)
    throw new OrchestrationTransitionError(
      "sequence-gap",
      `Expected sequence ${current.sequence + 1}, received ${event.sequence}.`,
    );
  if (event.previousEventHash !== current.lastEventHash)
    throw new OrchestrationTransitionError(
      "hash-chain-break",
      "Orchestration event hash chain is broken.",
    );
  if (current.idempotencyKeys[event.idempotencyKey])
    throw new OrchestrationTransitionError(
      "duplicate-idempotency-key",
      `Idempotency key ${event.idempotencyKey} already exists.`,
    );
  if (current.status !== "running")
    throw new OrchestrationTransitionError(
      "terminal-orchestration",
      `Cannot apply ${event.type} to ${current.status} orchestration.`,
    );

  const state: OrchestrationState = {
    ...current,
    lanes: current.lanes.map((lane) => ({ ...lane })),
    idempotencyKeys: { ...current.idempotencyKeys },
  };

  if (event.type.startsWith("lane.")) applyLaneEvent(state, event);
  else if (event.type === "lease.heartbeat") {
    const epoch = positiveInteger(event.payload.epoch, "epoch");
    if (epoch !== state.leaseEpoch)
      throw new OrchestrationTransitionError(
        "stale-lease-epoch",
        `Heartbeat epoch ${epoch} does not match ${state.leaseEpoch}.`,
      );
  } else if (event.type === "orchestration.completed") {
    if (!state.lanes.every(isTerminalLane))
      throw new OrchestrationTransitionError(
        "active-lanes",
        "Orchestration cannot complete while lanes remain active.",
      );
    state.status = aggregateOrchestrationStatus(state.lanes);
    state.completedAt = event.occurredAt;
  } else if (event.type === "orchestration.cancelled") {
    state.status = "cancelled";
    state.reason = payloadString(event, "reason");
    state.completedAt = event.occurredAt;
  } else {
    throw new OrchestrationTransitionError(
      "duplicate-create",
      "orchestration.created is only valid as the genesis event.",
    );
  }

  state.sequence = event.sequence;
  state.lastEventHash = hashOrchestrationEvent(event);
  (state.idempotencyKeys as Record<string, string>)[event.idempotencyKey] =
    event.eventId;
  return state;
}

export function replayOrchestrationEvents(
  events: readonly OrchestrationEvent[],
): OrchestrationState {
  if (events.length === 0)
    throw new OrchestrationTransitionError(
      "empty-journal",
      "Cannot replay an empty orchestration journal.",
    );
  let state: OrchestrationState | undefined;
  for (const event of events) state = applyOrchestrationEvent(state, event);
  if (!state) throw new Error("Orchestration replay produced no state.");
  return state;
}

export function readyOrchestrationLanes(
  state: OrchestrationState,
  effectiveMaxConcurrent = state.maxConcurrent,
): OrchestrationLane[] {
  if (
    !Number.isSafeInteger(effectiveMaxConcurrent) ||
    effectiveMaxConcurrent < 0 ||
    effectiveMaxConcurrent > state.maxConcurrent
  )
    throw new TypeError(
      "Effective orchestration concurrency must be within the configured limit.",
    );
  const dag = buildOrchestrationDag(state.lanes, state.dependencies);
  const completed = new Set(
    state.lanes
      .filter((lane) => lane.status === "merged" || lane.status === "closed")
      .map((lane) => issueNodeId(lane.issueNumber)),
  );
  const activeNodes = new Set(
    state.lanes
      .filter((lane) =>
        ["running", "ready", "refreshing", "integrating"].includes(lane.status),
      )
      .map((lane) => issueNodeId(lane.issueNumber)),
  );
  const blocked = new Set(
    state.lanes
      .filter((lane) =>
        ["blocked", "needs-human", "failed"].includes(lane.status),
      )
      .map((lane) => issueNodeId(lane.issueNumber)),
  );
  const byId = new Map(
    state.lanes.map((lane) => [issueNodeId(lane.issueNumber), lane]),
  );
  return getReadyQueue(dag, {
    completed,
    active: activeNodes,
    blocked,
    // getReadyQueue treats limit as the total active capacity and subtracts
    // active nodes itself. Passing only the remaining slots would subtract
    // active nodes twice and under-fill the configured concurrency.
    limit: effectiveMaxConcurrent,
  })
    .map((node) => byId.get(node.id))
    .filter((lane): lane is OrchestrationLane => lane?.status === "queued")
    .map((lane) => ({ ...lane }));
}

/**
 * Return queued lanes that can no longer run because a predecessor reached a
 * terminal unsuccessful state. The result is ordered by lane ordinal and a
 * lane with multiple failed predecessors uses the lowest-ordinal blocker so
 * the emitted evidence is deterministic.
 *
 * This deliberately reports only direct blockers. Callers append the returned
 * lane.blocked events and call this function again, which gives transitive
 * dependents their own durable event rather than mutating state implicitly.
 */
export function blockedOrchestrationLanes(
  state: OrchestrationState,
): BlockedOrchestrationLane[] {
  const byIssue = new Map(
    state.lanes.map((lane) => [lane.issueNumber, lane]),
  );
  const ordinal = (issueNumber: number): number =>
    byIssue.get(issueNumber)?.ordinal ?? Number.MAX_SAFE_INTEGER;
  return state.lanes
    .filter((lane) => lane.status === "queued")
    .flatMap((lane) => {
      const blocker = state.dependencies
        .filter((edge) => edge.toIssue === lane.issueNumber)
        .map((edge) => byIssue.get(edge.fromIssue))
        .filter(
          (candidate): candidate is OrchestrationLane =>
            candidate !== undefined &&
            ["blocked", "needs-human", "failed"].includes(candidate.status),
        )
        .sort(
          (left, right) =>
            ordinal(left.issueNumber) - ordinal(right.issueNumber) ||
            left.issueNumber - right.issueNumber,
        )[0];
      if (!blocker) return [];
      return [
        {
          lane: { ...lane },
          blockedBy: { ...blocker },
          reason: `Issue #${lane.issueNumber} cannot start because dependency #${blocker.issueNumber} is ${blocker.status}${blocker.reason ? `: ${blocker.reason}` : "."}`,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.lane.ordinal - right.lane.ordinal ||
        left.lane.issueNumber - right.lane.issueNumber,
    );
}

export function nextIntegrationLane(
  state: OrchestrationState,
): OrchestrationLane | undefined {
  if (
    state.lanes.some(
      (lane) => lane.status === "refreshing" || lane.status === "integrating",
    )
  )
    return undefined;
  const dag = buildOrchestrationDag(state.lanes, state.dependencies);
  const completed = new Set(
    state.lanes
      .filter((lane) => lane.status === "merged" || lane.status === "closed")
      .map((lane) => issueNodeId(lane.issueNumber)),
  );
  const eligible = state.lanes
    .filter((lane) => {
      if (lane.status !== "ready") return false;
      const nodeId = issueNodeId(lane.issueNumber);
      return (dag.incoming.get(nodeId) ?? []).every((edge) =>
        completed.has(edge.from),
      );
    })
    .sort((left, right) => left.ordinal - right.ordinal)[0];
  return eligible ? { ...eligible } : undefined;
}

export function aggregateOrchestrationStatus(
  lanes: readonly OrchestrationLane[],
): OrchestrationStatus {
  if (lanes.some((lane) => lane.status === "failed")) return "failed";
  if (lanes.some((lane) => lane.status === "needs-human")) return "needs-human";
  if (lanes.some((lane) => lane.status === "blocked")) return "blocked";
  if (
    lanes.every((lane) => lane.status === "merged" || lane.status === "closed")
  )
    return "completed";
  return "running";
}

export function isTerminalLane(lane: OrchestrationLane): boolean {
  return ["merged", "closed", "blocked", "needs-human", "failed"].includes(
    lane.status,
  );
}

function issueNodeId(issueNumber: number): string {
  return `issue:${issueNumber}`;
}

function buildOrchestrationDag(
  lanes: readonly Pick<OrchestrationLane, "issueNumber" | "ordinal">[],
  dependencies: readonly OrchestrationDependencyEdge[],
): Dag {
  const nodes = lanes.map((lane) => ({
    id: issueNodeId(lane.issueNumber),
    priority: lanes.length - lane.ordinal,
  }));
  const edges: DagEdge[] = dependencies.map((edge) => ({
    from: issueNodeId(edge.fromIssue),
    to: issueNodeId(edge.toIssue),
    kind: edge.kind,
    reason: edge.reason,
  }));
  return buildDag(nodes, edges);
}

function validateOrchestrationGraph(state: OrchestrationState): void {
  const orderedLanes = [...state.lanes].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const issueNumbers = orderedLanes.map((lane) => lane.issueNumber);
  let dependencies: OrchestrationDependencyEdge[];
  try {
    dependencies = parseDependencies(state.dependencies, issueNumbers);
  } catch (error) {
    throw new OrchestrationTransitionError(
      "graph-integrity",
      error instanceof Error ? error.message : String(error),
    );
  }
  const expectedHash = hashOrchestrationGraph(issueNumbers, dependencies);
  if (state.graphHash !== expectedHash)
    throw new OrchestrationTransitionError(
      "graph-integrity",
      "Orchestration graph hash does not match its confirmed issue set and dependencies.",
    );
}

export function hashOrchestrationGraph(
  issueNumbers: readonly number[],
  dependencies: readonly OrchestrationDependencyEdge[],
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson({ issueNumbers, dependencies }))
    .digest("hex")}`;
}

function parseDependencies(
  value: unknown,
  issueNumbers: readonly number[],
): OrchestrationDependencyEdge[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new OrchestrationTransitionError(
      "invalid-dependencies",
      "Orchestration dependencies must be an array.",
    );
  const issueSet = new Set(issueNumbers);
  const seen = new Set<string>();
  const dependencies = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new OrchestrationTransitionError(
        "invalid-dependencies",
        `dependencies[${index}] must be an object.`,
      );
    const record = entry as Record<string, unknown>;
    const fromIssue = positiveInteger(
      record.fromIssue,
      `dependencies[${index}].fromIssue`,
    );
    const toIssue = positiveInteger(
      record.toIssue,
      `dependencies[${index}].toIssue`,
    );
    if (!issueSet.has(fromIssue) || !issueSet.has(toIssue))
      throw new OrchestrationTransitionError(
        "unknown-dependency-issue",
        `Dependency ${fromIssue} -> ${toIssue} is outside the confirmed issue set.`,
      );
    if (record.kind !== "explicit")
      throw new OrchestrationTransitionError(
        "invalid-dependency-kind",
        `dependencies[${index}].kind must be explicit.`,
      );
    const reason = requiredString(
      record.reason,
      `dependencies[${index}].reason`,
    );
    const identity = `${fromIssue}:${toIssue}:explicit`;
    if (seen.has(identity))
      throw new OrchestrationTransitionError(
        "duplicate-dependency",
        `Duplicate dependency ${fromIssue} -> ${toIssue}.`,
      );
    seen.add(identity);
    return { fromIssue, toIssue, kind: "explicit" as const, reason };
  });
  const dag = buildOrchestrationDag(
    issueNumbers.map((issueNumber, ordinal) => ({ issueNumber, ordinal })),
    dependencies,
  );
  const cycle = findDagCycle(dag);
  if (cycle)
    throw new OrchestrationTransitionError(
      "dependency-cycle",
      `Orchestration dependency cycle: ${cycle.nodeIds.join(" -> ")}.`,
    );
  return dependencies;
}

function createInitialState(event: OrchestrationEvent): OrchestrationState {
  if (
    event.type !== "orchestration.created" ||
    event.sequence !== 1 ||
    event.previousEventHash !== null
  ) {
    throw new OrchestrationTransitionError(
      "invalid-genesis",
      "The first orchestration event must be orchestration.created.",
    );
  }
  const issues = event.payload.issueNumbers;
  if (!Array.isArray(issues) || issues.length === 0)
    throw new OrchestrationTransitionError(
      "invalid-issues",
      "Orchestration requires at least one issue.",
    );
  const issueNumbers = issues.map((issue, index) =>
    positiveInteger(issue, `issueNumbers[${index}]`),
  );
  if (new Set(issueNumbers).size !== issueNumbers.length)
    throw new OrchestrationTransitionError(
      "duplicate-issue",
      "Orchestration issue numbers must be unique.",
    );
  const dependencies = parseDependencies(
    event.payload.dependencies,
    issueNumbers,
  );
  const graphHash = hashOrchestrationGraph(issueNumbers, dependencies);
  const state: OrchestrationState = {
    schema: ORCHESTRATION_STATE_SCHEMA,
    orchestrationId: event.orchestrationId,
    repository: event.repository,
    integrationBranch: payloadString(event, "integrationBranch"),
    status: "running",
    maxConcurrent: positiveInteger(
      event.payload.maxConcurrent,
      "maxConcurrent",
    ),
    leaseEpoch: positiveInteger(event.payload.leaseEpoch, "leaseEpoch"),
    sequence: event.sequence,
    lastEventHash: hashOrchestrationEvent(event),
    lanes: issueNumbers.map((issueNumber, ordinal) => ({
      issueNumber,
      ordinal,
      status: "queued",
      refreshes: 0,
    })),
    dependencies,
    graphHash,
    idempotencyKeys: { [event.idempotencyKey]: event.eventId },
    createdAt: event.occurredAt,
  };
  return state;
}

function applyLaneEvent(
  state: OrchestrationState,
  event: OrchestrationEvent,
): void {
  const issueNumber = positiveInteger(event.payload.issueNumber, "issueNumber");
  const index = state.lanes.findIndex(
    (candidate) => candidate.issueNumber === issueNumber,
  );
  if (index < 0)
    throw new OrchestrationTransitionError(
      "unknown-lane",
      `Issue #${issueNumber} is not part of this orchestration.`,
    );
  const current = state.lanes[index];
  if (!current) throw new Error("Missing orchestration lane.");
  const next = { ...current };
  const transition = event.type.slice("lane.".length);
  const allowed: Record<string, readonly OrchestrationLaneStatus[]> = {
    started: ["queued"],
    recovered: ["failed", "blocked", "needs-human"],
    ready: ["running", "refreshing"],
    refreshing: ["ready", "integrating"],
    integrating: ["ready"],
    merged: ["integrating"],
    closed: ["running", "ready", "integrating"],
    blocked: ["queued", "running", "ready", "refreshing", "integrating"],
    "needs-human": ["queued", "running", "ready", "refreshing", "integrating"],
    failed: ["queued", "running", "ready", "refreshing", "integrating"],
  };
  if (!(allowed[transition] ?? []).includes(current.status))
    throw new OrchestrationTransitionError(
      "illegal-lane-transition",
      `Cannot apply ${event.type} to issue #${issueNumber} in ${current.status}.`,
    );

  if (transition === "started" || transition === "recovered") {
    next.status = "running";
    next.forgeRunId = payloadString(event, "forgeRunId");
    next.subagentRunId = payloadString(event, "subagentRunId");
    delete next.reason;
  } else if (transition === "ready") {
    next.status = "ready";
    next.headSha = payloadString(event, "headSha");
    next.baseSha = payloadString(event, "baseSha");
    if (typeof event.payload.subagentRunId === "string")
      next.subagentRunId = event.payload.subagentRunId;
  } else if (transition === "refreshing") {
    next.status = "refreshing";
    next.refreshes += 1;
    next.subagentRunId = payloadString(event, "subagentRunId");
    next.baseSha = payloadString(event, "baseSha");
  } else if (transition === "integrating") next.status = "integrating";
  else if (transition === "merged") {
    next.status = "merged";
    next.pullNumber = positiveInteger(event.payload.pullNumber, "pullNumber");
    next.headSha = payloadString(event, "headSha");
  } else if (transition === "closed") {
    next.status = "closed";
    next.reason = payloadString(event, "reason");
  } else {
    next.status = transition as "blocked" | "needs-human" | "failed";
    next.reason = payloadString(event, "reason");
  }
  (state.lanes as OrchestrationLane[])[index] = next;
}

function payloadString(event: OrchestrationEvent, field: string): string {
  return requiredString(event.payload[field], field);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim())
    throw new OrchestrationTransitionError(
      "invalid-field",
      `${field} must be a non-empty trimmed string.`,
    );
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new OrchestrationTransitionError(
      "invalid-field",
      `${field} must be a positive safe integer.`,
    );
  return value as number;
}

function validateOrchestrationEvent(event: OrchestrationEvent): void {
  if (event.schema !== ORCHESTRATION_EVENT_SCHEMA)
    throw new OrchestrationTransitionError(
      "unsupported-schema",
      `Unsupported orchestration event schema: ${String(event.schema)}.`,
    );
  requiredString(event.eventId, "eventId");
  requiredString(event.orchestrationId, "orchestrationId");
  requiredString(event.repository, "repository");
  requiredString(event.idempotencyKey, "idempotencyKey");
  positiveInteger(event.sequence, "sequence");
  if (Number.isNaN(Date.parse(event.occurredAt)))
    throw new OrchestrationTransitionError(
      "invalid-timestamp",
      "occurredAt must be RFC3339-compatible.",
    );
}

function hashOrchestrationEvent(event: OrchestrationEvent): string {
  return `sha256:${createHash("sha256").update(canonicalJson(event)).digest("hex")}`;
}
