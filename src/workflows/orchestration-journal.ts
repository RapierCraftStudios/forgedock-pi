import {
  type GitHubStateBranchStore,
} from "../adapters/github-state.ts";
import {
  stateCas,
} from "../adapters/state-cas.ts";
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
          ...((input.lane ?? input.integrationLane)
            ? {
                integrationLane: createIntegrationLane(
                  (input.lane ?? input.integrationLane) as IntegrationLaneInput,
                ),
              }
            : {}),
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
      if (prior) return current.state;
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
