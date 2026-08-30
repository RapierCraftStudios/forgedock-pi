import type { IntegrationLane } from "./integration-lane.ts";
import { validateIntegrationLane } from "./integration-lane.ts";
import type { OrchestrationLane, OrchestrationState } from "./orchestration.ts";

export const ORCHESTRATION_RECOVERY_SCHEMA =
  "forgedock.orchestration-recovery/v1" as const;

export type OrchestrationClassification =
  | "DONE"
  | "GATED"
  | "FAILED"
  | "IN_PROGRESS";

/** Durable state carried by an orchestration batch, not by provider receipts. */
export interface OrchestrationBatchState {
  schema: typeof ORCHESTRATION_RECOVERY_SCHEMA;
  batchId: string;
  leaseEpoch: number;
  childKeys: Readonly<Record<string, string>>;
  predecessors: Readonly<Record<string, readonly number[]>>;
  ready: readonly number[];
  deferred: readonly number[];
  /** Present for new typed lane records; omitted for legacy fast-lane snapshots. */
  laneId?: string;
  queue?: readonly OrchestrationQueueEntry[];
}

export interface OrchestrationQueueEntry {
  issueNumber: number;
  laneId: string;
  position: number;
}

export interface RetainedOrchestrationChild {
  childKey: string;
  issueNumber: number;
  status: "running" | "completed" | "failed" | "cancelled" | "missing";
  forgeRunId?: string;
  laneId?: string;
  baseSha?: string;
  leaseEpoch?: number;
}

export interface OrchestrationReloadPlan {
  schema: typeof ORCHESTRATION_RECOVERY_SCHEMA;
  classifications: Readonly<Record<number, OrchestrationClassification>>;
  retained: readonly RetainedOrchestrationChild[];
  resume: readonly number[];
  reconcile: readonly number[];
  paused: boolean;
  reason?: string;
}

export function renderOrchestrationReloadReport(
  plan: Pick<OrchestrationReloadPlan, "classifications" | "resume" | "reconcile" | "paused" | "reason">,
): string {
  const lanes = Object.entries(plan.classifications)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([issue, classification]) => `#${issue}=${classification}`)
    .join(", ");
  const action = plan.paused
    ? `PAUSED: ${plan.reason ?? "unsafe reload state"}`
    : `resume=[${plan.resume.join(",")}] reconcile=[${plan.reconcile.join(",")}]`;
  return `ForgeDock orchestration reload: ${lanes}; ${action}`;
}

export function orchestrationChildKey(
  batchId: string,
  issueNumber: number,
): string {
  if (!batchId.trim() || !Number.isSafeInteger(issueNumber) || issueNumber < 1)
    throw new TypeError("A child key requires a batch and positive issue number.");
  return `${batchId}:issue:${issueNumber}`;
}

export function classifyOrchestrationLane(
  lane: Pick<OrchestrationLane, "status">,
): OrchestrationClassification {
  switch (lane.status) {
    case "merged":
    case "closed":
      return "DONE";
    case "blocked":
    case "needs-human":
      return "GATED";
    case "failed":
      return "FAILED";
    default:
      return "IN_PROGRESS";
  }
}

export function createOrchestrationBatchState(
  state: Pick<OrchestrationState, "orchestrationId" | "leaseEpoch" | "lanes" | "dependencies"> & { integrationLane?: IntegrationLane },
): OrchestrationBatchState {
  const childKeys: Record<string, string> = {};
  const predecessors: Record<string, readonly number[]> = {};
  const ready: number[] = [];
  const deferred: number[] = [];
  const byIssue = new Map(state.lanes.map((lane) => [lane.issueNumber, lane]));
  for (const lane of [...state.lanes].sort((a, b) => a.ordinal - b.ordinal)) {
    const issue = String(lane.issueNumber);
    childKeys[issue] = orchestrationChildKey(state.orchestrationId, lane.issueNumber);
    predecessors[issue] = state.dependencies
      .filter((edge) => edge.toIssue === lane.issueNumber)
      .map((edge) => edge.fromIssue)
      .sort((a, b) => a - b);
    const predecessorsComplete = predecessors[issue]!.every((predecessor) => {
      const prior = byIssue.get(predecessor);
      return prior?.status === "merged" || prior?.status === "closed";
    });
    if (lane.status === "queued" && predecessorsComplete) ready.push(lane.issueNumber);
    else if (lane.status === "queued") deferred.push(lane.issueNumber);
  }
  const result: OrchestrationBatchState = {
    schema: ORCHESTRATION_RECOVERY_SCHEMA,
    batchId: state.orchestrationId,
    leaseEpoch: state.leaseEpoch,
    childKeys,
    predecessors,
    ready,
    deferred,
  };
  if (state.integrationLane) {
    result.laneId = state.integrationLane.stableId;
    result.queue = state.lanes
      .filter((lane) => lane.status !== "closed")
      .map((lane) => ({
        issueNumber: lane.issueNumber,
        laneId: state.integrationLane!.stableId,
        position: lane.ordinal,
      }));
  }
  return result;
}

/**
 * Reconcile only durable child identities. A provider receipt is evidence of
 * execution, never authority to invent a missing lane result. Ambiguous or
 * duplicate child identity pauses the drain and launches nothing.
 */
export function planOrchestrationReload(input: {
  state: Pick<OrchestrationState, "orchestrationId" | "leaseEpoch" | "lanes" | "dependencies" | "maxConcurrent"> & { integrationLane?: IntegrationLane };
  retainedChildren: readonly RetainedOrchestrationChild[];
  /** Optional persisted queue supplied by reload callers; derived when omitted. */
  queue?: readonly OrchestrationQueueEntry[];
}): OrchestrationReloadPlan {
  const batch = createOrchestrationBatchState(input.state);
  let unsafeReason: string | undefined;
  if (input.state.integrationLane) {
    try {
      validateIntegrationLane(input.state.integrationLane);
    } catch (error) {
      unsafeReason = error instanceof Error ? error.message : String(error);
    }
    const expectedMembers = new Set(input.state.lanes.map((lane) => lane.issueNumber));
    const actualMembers = new Set(input.state.integrationLane.membership.map((member) => member.issueNumber));
    if (expectedMembers.size !== actualMembers.size || [...expectedMembers].some((issue) => !actualMembers.has(issue)))
      unsafeReason ??= "Durable lane membership does not match orchestration lanes.";
  }
  const queue = input.queue ?? batch.queue;
  if (queue && input.state.integrationLane) {
    const seenIssues = new Set<number>();
    const seenPositions = new Set<number>();
    for (const entry of queue) {
      if (entry.laneId !== input.state.integrationLane.stableId)
        unsafeReason ??= `Queue entry for issue #${entry.issueNumber} has unknown lane identity.`;
      if (!input.state.lanes.some((lane) => lane.issueNumber === entry.issueNumber))
        unsafeReason ??= `Queue entry references unknown issue #${entry.issueNumber}.`;
      if (seenIssues.has(entry.issueNumber) || seenPositions.has(entry.position))
        unsafeReason ??= "Duplicate or ambiguous integration queue entry.";
      if (!Number.isSafeInteger(entry.position) || entry.position < 0)
        unsafeReason ??= "Integration queue position is invalid.";
      seenIssues.add(entry.issueNumber);
      seenPositions.add(entry.position);
    }
    const expectedQueueIssues = new Set(
      input.state.lanes
        .filter((lane) => lane.status !== "closed")
        .map((lane) => lane.issueNumber),
    );
    if (seenIssues.size !== expectedQueueIssues.size || [...expectedQueueIssues].some((issue) => !seenIssues.has(issue)))
      unsafeReason ??= "Integration queue is stale or incomplete.";
    const orderedPositions = [...seenPositions].sort((left, right) => left - right);
    if (orderedPositions.some((position, index) => position !== index))
      unsafeReason ??= "Integration queue positions are stale or ambiguous.";
  }
  const knownKeys = new Set(Object.values(batch.childKeys));
  const byKey = new Map<string, RetainedOrchestrationChild>();
  for (const child of input.retainedChildren) {
    if (!knownKeys.has(child.childKey)) {
      unsafeReason ??= `Unknown retained child key ${child.childKey}.`;
      continue;
    }
    const expectedIssue = Object.entries(batch.childKeys).find(([, key]) => key === child.childKey)?.[0];
    if (Number(expectedIssue) !== child.issueNumber) {
      unsafeReason ??= `Retained child ${child.childKey} has mismatched issue identity.`;
      continue;
    }
    if (byKey.has(child.childKey)) {
      unsafeReason ??= `Duplicate retained child key ${child.childKey}.`;
      continue;
    }
    if (input.state.integrationLane) {
      if (child.laneId !== input.state.integrationLane.stableId)
        unsafeReason ??= `Retained child ${child.childKey} has stale or ambiguous lane identity.`;
      if (child.baseSha !== undefined && child.baseSha !== input.state.integrationLane.frozenBase.sha)
        unsafeReason ??= `Retained child ${child.childKey} has a stale frozen base.`;
      if (child.leaseEpoch !== undefined && child.leaseEpoch !== input.state.leaseEpoch)
        unsafeReason ??= `Retained child ${child.childKey} has a stale lease epoch.`;
    }
    byKey.set(child.childKey, child);
  }
  const classifications: Record<number, OrchestrationClassification> = {};
  const reconcile: number[] = [];
  for (const lane of input.state.lanes) {
    classifications[lane.issueNumber] = classifyOrchestrationLane(lane);
    const child = byKey.get(batch.childKeys[String(lane.issueNumber)]!);
    if (child && ["running", "completed", "failed", "cancelled"].includes(child.status))
      reconcile.push(lane.issueNumber);
  }
  if (unsafeReason) {
    return {
      schema: ORCHESTRATION_RECOVERY_SCHEMA,
      classifications,
      retained: [...input.retainedChildren],
      resume: [],
      reconcile: reconcile.sort((a, b) => a - b),
      paused: true,
      reason: `Paused orchestration reload: ${unsafeReason}`,
    };
  }
  const active = input.state.lanes.filter((lane) =>
    ["running", "ready", "refreshing", "integrating"].includes(lane.status),
  ).length;
  const capacity = Math.max(0, input.state.maxConcurrent - active);
  const done = new Set(
    input.state.lanes
      .filter((lane) => lane.status === "merged" || lane.status === "closed")
      .map((lane) => lane.issueNumber),
  );
  const gated = new Set(
    input.state.lanes
      .filter((lane) => ["blocked", "needs-human", "failed"].includes(lane.status))
      .map((lane) => lane.issueNumber),
  );
  const resumed = new Set(
    Array.from(byKey.values(), (child) => child.issueNumber),
  );
  const resume = input.state.lanes
    .filter((lane) => lane.status === "queued")
    .filter((lane) => !resumed.has(lane.issueNumber))
    .filter((lane) => input.state.dependencies
      .filter((edge) => edge.toIssue === lane.issueNumber)
      .every((edge) => done.has(edge.fromIssue) && !gated.has(edge.fromIssue)))
    .sort((a, b) => a.ordinal - b.ordinal || a.issueNumber - b.issueNumber)
    .slice(0, capacity)
    .map((lane) => lane.issueNumber);
  return {
    schema: ORCHESTRATION_RECOVERY_SCHEMA,
    classifications,
    retained: [...input.retainedChildren],
    resume,
    reconcile: [...new Set(reconcile)].sort((a, b) => a - b),
    paused: false,
  };
}
