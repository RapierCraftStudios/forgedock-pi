import {
  type GitHubStateBranchStore,
} from "../adapters/github-state.ts";
import { StateBranchConflictError } from "../adapters/github-state.ts";
import { stateCas } from "../adapters/state-cas.ts";
import { canonicalJson } from "../core/events.ts";
import {
  applyOrchestrationEvent,
  createOrchestrationEvent,
  type OrchestrationDependencyEdge,
  type OrchestrationEventType,
  type OrchestrationState,
} from "../core/orchestration.ts";
import {
  createIntegrationLane,
  type IntegrationLane,
  type IntegrationLaneInput,
  type IntegrationLanePromotionReceipt,
  type IntegrationLaneStagingEvidence,
} from "../core/integration-lane.ts";

export class OrchestrationJournal {
  readonly #store: GitHubStateBranchStore;

  constructor(store: GitHubStateBranchStore) {
    this.#store = store;
  }

  async initialize(input: {
    orchestrationId: string;
    repository: string;
    issueNumbers: readonly number[];
    integrationBranch: string;
    maxConcurrent: number;
    dependencies?: readonly OrchestrationDependencyEdge[];
    /** New typed lane binding. `integrationLane` is retained as an alias for callers. */
    lane?: IntegrationLane | IntegrationLaneInput;
    integrationLane?: IntegrationLane | IntegrationLaneInput;
    now?: Date;
    signal?: AbortSignal;
  }): Promise<OrchestrationState> {
    await this.#store.ensureBranch(input.now ?? new Date(), input.signal);
    return stateCas(async () => {
      const current = await this.#store.readOrchestration(
        input.orchestrationId,
        input.signal,
      );
      if (current.events.length > 0)
        throw new Error(
          `Orchestration ${input.orchestrationId} already exists.`,
        );
      const now = input.now ?? new Date();
      const laneInput = input.lane ?? input.integrationLane;
      const lane = laneInput ? createIntegrationLane(laneInput as IntegrationLaneInput) : undefined;
      if (lane && lane.repository !== input.repository)
        throw new Error(
          "Integration lane repository must match orchestration repository.",
        );
      if (lane && !lane.legacy && lane.branch !== input.integrationBranch)
        throw new Error(
          "Integration lane branch must match orchestration integration branch.",
        );
      const event = createOrchestrationEvent({
        orchestrationId: input.orchestrationId,
        repository: input.repository,
        sequence: 1,
        previousEventHash: null,
        type: "orchestration.created",
        idempotencyKey: "orchestration:create",
        payload: {
          issueNumbers: [...input.issueNumbers],
          integrationBranch: input.integrationBranch,
          maxConcurrent: input.maxConcurrent,
          dependencies: [...(input.dependencies ?? [])],
          ...(lane ? { integrationLane: lane } : {}),
          leaseEpoch: 1,
        },
        occurredAt: now.toISOString(),
      });
      const state = applyOrchestrationEvent(undefined, event);
      await this.#store.commitOrchestrationState({
        expectedTip: current.tip,
        events: [event],
        state,
        message: `Initialize ForgeDock orchestration ${input.orchestrationId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return state;
    }, input.signal);
  }

  async append(input: {
    orchestrationId: string;
    type: OrchestrationEventType;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<OrchestrationState> {
    return this.#mutate(input);
  }

  /**
   * Allocate a queue position in the same state-branch CAS attempt as the
   * queue event.  Computing the maximum outside that attempt lets concurrent
   * promoters choose the same position; a CAS retry must re-read all lanes and
   * allocate a new token instead of replaying stale event data.
   */
  async queueLane(input: { orchestrationId: string; laneId: string; queuePosition?: number; signal?: AbortSignal }): Promise<OrchestrationState> {
    return stateCas(async () => {
      const current = await this.#store.readOrchestration(input.orchestrationId, input.signal);
      if (!current.state) throw new Error(`Orchestration ${input.orchestrationId} is not initialized.`);
      const idempotencyKey = `integration-lane:${input.laneId}:queue`;
      const prior = current.events.find((event) => event.type === "integration-lane.queued" && event.payload.laneId === input.laneId);
      if (prior) return current.state;
      const records = await this.#store.listOrchestrations(input.signal);
      const latestTip = await this.#store.getTip(input.signal);
      if (latestTip !== current.tip) throw new StateBranchConflictError(current.tip);
      let highest = -1;
      for (const record of records) {
        const position = record.orchestrationId === input.orchestrationId
          ? current.state.integrationLane?.promotion.queuePosition
          : record.state?.integrationLane?.promotion.queuePosition;
        if (position !== undefined) highest = Math.max(highest, position);
      }
      const queuePosition = highest + 1;
      const event = createOrchestrationEvent({
        orchestrationId: input.orchestrationId,
        repository: current.state.repository,
        sequence: current.state.sequence + 1,
        previousEventHash: current.state.lastEventHash,
        type: "integration-lane.queued",
        idempotencyKey,
        payload: { laneId: input.laneId, queuePosition },
      });
      const state = applyOrchestrationEvent(current.state, event);
      await this.#store.commitOrchestrationState({
        expectedTip: current.tip,
        events: [...current.events, event],
        state,
        message: `Queue integration lane ${input.laneId} at position ${queuePosition}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return state;
    }, input.signal);
  }

  async acquireLaneQueueLease(input: { orchestrationId: string; laneId: string; ownerId: string; leaseSeconds: number; attempt?: number; signal?: AbortSignal }): Promise<OrchestrationState> {
    const attempt = input.attempt ?? 1;
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Lease acquisition attempt must be a positive integer.");
    return this.append({ orchestrationId: input.orchestrationId, type: "integration-lane.lease-acquired", payload: { laneId: input.laneId, ownerId: input.ownerId, leaseSeconds: input.leaseSeconds, attempt }, idempotencyKey: `integration-lane:${input.laneId}:lease:${input.ownerId}:${attempt}`, message: `Acquire integration lane queue lease ${input.laneId}`, ...(input.signal ? { signal: input.signal } : {}) });
  }

  async releaseLaneQueueLease(input: { orchestrationId: string; laneId: string; ownerId: string; signal?: AbortSignal }): Promise<OrchestrationState> {
    return this.append({ orchestrationId: input.orchestrationId, type: "integration-lane.lease-released", payload: { laneId: input.laneId, ownerId: input.ownerId }, idempotencyKey: `integration-lane:${input.laneId}:lease-release:${input.ownerId}`, message: `Release integration lane queue lease ${input.laneId}`, ...(input.signal ? { signal: input.signal } : {}) });
  }

  async syncLane(input: { orchestrationId: string; laneId: string; ownerId: string; leaseEpoch: number; staging: IntegrationLaneStagingEvidence; signal?: AbortSignal }): Promise<OrchestrationState> {
    return this.append({ orchestrationId: input.orchestrationId, type: "integration-lane.sync", payload: { laneId: input.laneId, ownerId: input.ownerId, leaseEpoch: input.leaseEpoch, staging: input.staging }, idempotencyKey: `integration-lane:${input.laneId}:sync:${input.staging.sha}`, message: `Record integration lane sync ${input.laneId}`, ...(input.signal ? { signal: input.signal } : {}) });
  }

  async promoteLane(input: {
    orchestrationId: string;
    laneId: string;
    ownerId: string;
    queueHeadLaneId: string;
    leaseEpoch: number;
    staging: IntegrationLaneStagingEvidence;
    stagingReadbackSha: string;
    receipt: IntegrationLanePromotionReceipt;
    reviewPassed: boolean;
    verificationPassed: boolean;
    mergeable: boolean;
    authorityValid: boolean;
    mergeCommit: boolean;
    /** Re-read provider staging/ownership evidence for every state-CAS attempt. */
    readPromotionEvidence: (state: OrchestrationState) => Promise<{
      ownerId: string;
      queueHeadLaneId: string;
      leaseEpoch: number;
      staging: IntegrationLaneStagingEvidence;
      stagingReadbackSha: string;
    }>;
    signal?: AbortSignal;
  }): Promise<OrchestrationState> {
    return stateCas(async () => {
      const current = await this.#store.readOrchestration(
        input.orchestrationId,
        input.signal,
      );
      if (!current.state)
        throw new Error(`Orchestration ${input.orchestrationId} is not initialized.`);
      const evidence = await input.readPromotionEvidence(current.state);
      const priorReceipt = current.state.integrationLane?.promotion.receipt;
      if (priorReceipt && priorReceipt.mergeCommitSha === input.receipt.mergeCommitSha)
        return current.state;
      const idempotencyKey = `integration-lane:${input.laneId}:promoted:${input.receipt.mergeCommitSha}:${evidence.stagingReadbackSha}`;
      const prior = current.state.idempotencyKeys[idempotencyKey];
      if (prior) return current.state;
      const event = createOrchestrationEvent({
        orchestrationId: input.orchestrationId,
        repository: current.state.repository,
        sequence: current.state.sequence + 1,
        previousEventHash: current.state.lastEventHash,
        type: "integration-lane.promoted",
        idempotencyKey,
        payload: {
          laneId: input.laneId,
          ownerId: evidence.ownerId,
          queueHeadLaneId: evidence.queueHeadLaneId,
          leaseEpoch: evidence.leaseEpoch,
          staging: evidence.staging,
          stagingReadbackSha: evidence.stagingReadbackSha,
          receipt: input.receipt,
          reviewPassed: input.reviewPassed,
          verificationPassed: input.verificationPassed,
          mergeable: input.mergeable,
          authorityValid: input.authorityValid,
          mergeCommit: input.mergeCommit,
        },
      });
      const state = applyOrchestrationEvent(current.state, event);
      await this.#store.commitOrchestrationState({
        expectedTip: current.tip,
        events: [...current.events, event],
        state,
        message: `Promote integration lane ${input.laneId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return state;
    }, input.signal);
  }

  async closeLane(input: { orchestrationId: string; laneId: string; signal?: AbortSignal }): Promise<OrchestrationState> {
    return this.append({ orchestrationId: input.orchestrationId, type: "integration-lane.closed", payload: { laneId: input.laneId }, idempotencyKey: `integration-lane:${input.laneId}:closed`, message: `Close integration lane ${input.laneId}`, ...(input.signal ? { signal: input.signal } : {}) });
  }

  async complete(input: {
    orchestrationId: string;
    signal?: AbortSignal;
  }): Promise<OrchestrationState> {
    return this.#mutate({
      orchestrationId: input.orchestrationId,
      type: "orchestration.completed",
      payload: {},
      idempotencyKey: "orchestration:complete",
      message: `Complete ForgeDock orchestration ${input.orchestrationId}`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async cancel(input: {
    orchestrationId: string;
    reason: string;
    signal?: AbortSignal;
  }): Promise<OrchestrationState> {
    const reason = input.reason.trim();
    if (!reason) throw new Error("Cancellation reason must be non-empty.");
    return this.#mutate({
      orchestrationId: input.orchestrationId,
      type: "orchestration.cancelled",
      payload: { reason },
      idempotencyKey: "orchestration:cancel",
      message: `Cancel ForgeDock orchestration ${input.orchestrationId}`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async #mutate(input: {
    orchestrationId: string;
    type: OrchestrationEventType;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<OrchestrationState> {
    return stateCas(async () => {
      const current = await this.#store.readOrchestration(
        input.orchestrationId,
        input.signal,
      );
      if (!current.state)
        throw new Error(
          `Orchestration ${input.orchestrationId} is not initialized.`,
        );
      const prior = current.state.idempotencyKeys[input.idempotencyKey];
      if (prior) {
        const priorEvent = current.events.find((event) => event.idempotencyKey === input.idempotencyKey);
        if (!priorEvent || priorEvent.type !== input.type || canonicalJson(priorEvent.payload) !== canonicalJson(input.payload))
          throw new Error(`Idempotency key ${input.idempotencyKey} was reused with different event data.`);
        return current.state;
      }
      const event = createOrchestrationEvent({
        orchestrationId: input.orchestrationId,
        repository: current.state.repository,
        sequence: current.state.sequence + 1,
        previousEventHash: current.state.lastEventHash,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      });
      const state = applyOrchestrationEvent(current.state, event);
      const events = [...current.events, event];
      await this.#store.commitOrchestrationState({
        expectedTip: current.tip,
        events,
        state,
        message: input.message,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return state;
    }, input.signal);
  }
}
