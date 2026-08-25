import {
  GitHubStateBranchStore,
  StateBranchConflictError,
} from "../adapters/github-state.ts";
import {
  applyOrchestrationEvent,
  createOrchestrationEvent,
  type OrchestrationEvent,
  type OrchestrationEventType,
  type OrchestrationState,
} from "../core/orchestration.ts";
import {
  acquireLease,
  heartbeatLease,
  isLeaseExpired,
  type RepositoryLease,
} from "../core/lease.ts";

const MAX_CAS_ATTEMPTS = 12;

export interface OrchestrationJournalSnapshot {
  tip: string;
  events: readonly OrchestrationEvent[];
  state: OrchestrationState;
  lease: RepositoryLease;
}

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
    sessionId: string;
    leaseSeconds: number;
    now?: Date;
    signal?: AbortSignal;
  }): Promise<OrchestrationJournalSnapshot> {
    await this.#store.ensureBranch(input.now ?? new Date(), input.signal);
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#store.readOrchestration(
        input.orchestrationId,
        input.signal,
      );
      if (current.events.length > 0)
        throw new Error(
          `Orchestration ${input.orchestrationId} already exists.`,
        );
      const now = input.now ?? new Date();
      const lease = acquireLease(current.lease, {
        repository: input.repository,
        owner: {
          runId: input.orchestrationId,
          sessionId: input.sessionId,
        },
        now,
        ttlSeconds: input.leaseSeconds,
      });
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
          leaseEpoch: lease.epoch,
        },
        occurredAt: now.toISOString(),
      });
      const state = applyOrchestrationEvent(undefined, event);
      try {
        const tip = await this.#store.commitOrchestrationState({
          expectedTip: current.tip,
          events: [event],
          state,
          leaseUpdate: lease,
          message: `Initialize ForgeDock orchestration ${input.orchestrationId}`,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return { tip, events: [event], state, lease };
      } catch (error) {
        if (
          !(error instanceof StateBranchConflictError) ||
          attempt === MAX_CAS_ATTEMPTS
        )
          throw error;
        await casBackoff(attempt, input.signal);
      }
    }
    throw new Error(
      `Unable to initialize orchestration ${input.orchestrationId}.`,
    );
  }

  async append(input: {
    orchestrationId: string;
    type: OrchestrationEventType;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<OrchestrationJournalSnapshot> {
    return this.#mutate(input, false);
  }

  async heartbeat(input: {
    orchestrationId: string;
    sessionId: string;
    leaseSeconds: number;
    now?: Date;
    signal?: AbortSignal;
  }): Promise<OrchestrationJournalSnapshot> {
    return this.#mutate(
      {
        orchestrationId: input.orchestrationId,
        type: "lease.heartbeat",
        payload: { epoch: 0 },
        idempotencyKey: `lease:heartbeat:${(input.now ?? new Date()).toISOString()}`,
        message: `Heartbeat ForgeDock orchestration ${input.orchestrationId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      false,
      {
        sessionId: input.sessionId,
        leaseSeconds: input.leaseSeconds,
        now: input.now ?? new Date(),
      },
    );
  }

  async complete(input: {
    orchestrationId: string;
    signal?: AbortSignal;
  }): Promise<OrchestrationJournalSnapshot> {
    return this.#mutate(
      {
        orchestrationId: input.orchestrationId,
        type: "orchestration.completed",
        payload: {},
        idempotencyKey: "orchestration:complete",
        message: `Complete ForgeDock orchestration ${input.orchestrationId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      true,
    );
  }

  async cancel(input: {
    orchestrationId: string;
    reason: string;
    signal?: AbortSignal;
  }): Promise<OrchestrationJournalSnapshot> {
    const reason = input.reason.trim();
    if (!reason) throw new Error("Cancellation reason must be non-empty.");
    return this.#mutate(
      {
        orchestrationId: input.orchestrationId,
        type: "orchestration.cancelled",
        payload: { reason },
        idempotencyKey: "orchestration:cancel",
        message: `Cancel ForgeDock orchestration ${input.orchestrationId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      true,
      undefined,
      true,
    );
  }

  async #mutate(
    input: {
      orchestrationId: string;
      type: OrchestrationEventType;
      payload: Record<string, unknown>;
      idempotencyKey: string;
      message: string;
      signal?: AbortSignal;
    },
    release: boolean,
    heartbeat?: { sessionId: string; leaseSeconds: number; now: Date },
    allowExpired = false,
  ): Promise<OrchestrationJournalSnapshot> {
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#store.readOrchestration(
        input.orchestrationId,
        input.signal,
      );
      if (!current.state || !current.lease)
        throw new Error(
          `Orchestration ${input.orchestrationId} is not initialized.`,
        );
      if (
        current.lease.ownerRunId !== input.orchestrationId ||
        current.lease.epoch !== current.state.leaseEpoch ||
        (!allowExpired &&
          isLeaseExpired(current.lease, heartbeat?.now ?? new Date()))
      ) {
        throw new Error(
          `Orchestration ${input.orchestrationId} no longer owns its repository lease.`,
        );
      }
      const prior = current.state.idempotencyKeys[input.idempotencyKey];
      if (prior)
        return {
          tip: current.tip,
          events: current.events,
          state: current.state,
          lease: current.lease,
        };
      const lease = heartbeat
        ? heartbeatLease(current.lease, {
            repository: current.state.repository,
            owner: {
              runId: input.orchestrationId,
              sessionId: heartbeat.sessionId,
            },
            epoch: current.lease.epoch,
            now: heartbeat.now,
            ttlSeconds: heartbeat.leaseSeconds,
          })
        : current.lease;
      const payload =
        input.type === "lease.heartbeat"
          ? { ...input.payload, epoch: lease.epoch }
          : input.payload;
      const event = createOrchestrationEvent({
        orchestrationId: input.orchestrationId,
        repository: current.state.repository,
        sequence: current.state.sequence + 1,
        previousEventHash: current.state.lastEventHash,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        payload,
      });
      const state = applyOrchestrationEvent(current.state, event);
      const events = [...current.events, event];
      try {
        const tip = await this.#store.commitOrchestrationState({
          expectedTip: current.tip,
          events,
          state,
          leaseUpdate: release ? null : heartbeat ? lease : undefined,
          message: input.message,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return { tip, events, state, lease };
      } catch (error) {
        if (
          !(error instanceof StateBranchConflictError) ||
          attempt === MAX_CAS_ATTEMPTS
        )
          throw error;
        await casBackoff(attempt, input.signal);
      }
    }
    throw new Error(
      `Unable to update orchestration ${input.orchestrationId}.`,
    );
  }
}

async function casBackoff(
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  const delayMs = Math.min(2_000, 50 * 2 ** Math.min(attempt - 1, 5));
  const jitterMs = Math.floor(Math.random() * 100);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("CAS retry aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs + jitterMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref();
  });
}
