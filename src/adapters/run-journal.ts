import {
  type GitHubStateBranchStore,
  StateBranchConflictError,
} from "./github-state.ts";
import {
  createRunEvent,
  type RunEvent,
  type RunEventPayload,
  type RunEventType,
} from "../core/events.ts";
import { acquireLease, isLeaseExpired, type RepositoryLease } from "../core/lease.ts";
import { applyRunEvent, type RunState } from "../core/state.ts";

const MAX_CAS_ATTEMPTS = 12;

export interface InitializeRunInput {
  runId: string;
  repository: string;
  issueNumber: number;
  integrationBranch: string;
  protectedBranch: string;
  sessionId: string;
  leaseSeconds: number;
  orchestration?: {
    ownerRunId: string;
    epoch: number;
  };
  now?: Date;
  signal?: AbortSignal;
}

export interface JournalSnapshot {
  tip: string;
  events: readonly RunEvent[];
  state: RunState;
  lease?: RepositoryLease;
}

export class RunJournal {
  readonly #store: GitHubStateBranchStore;

  constructor(store: GitHubStateBranchStore) {
    this.#store = store;
  }

  async initialize(input: InitializeRunInput): Promise<JournalSnapshot> {
    await this.#store.ensureBranch(input.now ?? new Date(), input.signal);
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.#store.readRun(input.runId, input.signal);
      if (existing.events.length > 0)
        throw new Error(`Run ${input.runId} already exists.`);
      const now = input.now ?? new Date();
      const lease = input.orchestration
        ? validateOrchestrationLease(existing.lease, input.orchestration, now)
        : acquireLease(existing.lease, {
            repository: input.repository,
            owner: { runId: input.runId, sessionId: input.sessionId },
            now,
            ttlSeconds: input.leaseSeconds,
          });
      const created = createRunEvent({
        runId: input.runId,
        repository: input.repository,
        sequence: 1,
        previousEventHash: null,
        type: "run.created",
        actor: { kind: "extension", sessionId: input.sessionId, leaseEpoch: 0 },
        idempotencyKey: "run:create",
        payload: {
          issueNumber: input.issueNumber,
          integrationBranch: input.integrationBranch,
          protectedBranch: input.protectedBranch,
          ...(input.orchestration
            ? {
                orchestrationRunId: input.orchestration.ownerRunId,
                leaseEpoch: input.orchestration.epoch,
              }
            : {}),
        },
        occurredAt: now.toISOString(),
      });
      let state = applyRunEvent(undefined, created);
      const events: RunEvent[] = [created];
      if (!input.orchestration) {
        const acquired = createRunEvent({
          runId: input.runId,
          repository: input.repository,
          sequence: 2,
          previousEventHash: state.lastEventHash,
          type: "lease.acquired",
          actor: {
            kind: "extension",
            sessionId: input.sessionId,
            leaseEpoch: lease.epoch,
          },
          idempotencyKey: `lease:acquire:${lease.epoch}`,
          payload: { lease },
          occurredAt: now.toISOString(),
        });
        state = applyRunEvent(state, acquired);
        events.push(acquired);
      }
      try {
        const tip = await this.#store.commitRunState({
          expectedTip: existing.tip,
          events,
          state,
          ...(input.orchestration
            ? { preserveRepositoryLease: true }
            : { lease }),
          message: `Initialize ForgeDock run ${input.runId}`,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return { tip, events, state, ...(input.orchestration ? {} : { lease }) };
      } catch (error) {
        if (
          !(error instanceof StateBranchConflictError) ||
          attempt === MAX_CAS_ATTEMPTS
        )
          throw error;
        await casBackoff(attempt, input.signal);
      }
    }
    throw new Error(`Unable to initialize run ${input.runId}.`);
  }

  async append(input: {
    runId: string;
    type: RunEventType;
    payload: RunEventPayload;
    idempotencyKey: string;
    sessionId: string;
    actorKind?: "extension" | "human";
    allowExpiredLease?: boolean;
    allowRevokedOrchestrationCancellation?: boolean;
    message: string;
    signal?: AbortSignal;
  }): Promise<JournalSnapshot> {
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#store.readRun(input.runId, input.signal);
      if (!current.state) throw new Error(`Run ${input.runId} does not exist.`);
      if (
        !isRevokedOrchestrationCancellationAuthorized({
          state: current.state,
          type: input.type,
          actorKind: input.actorKind,
          allowRevokedOrchestrationCancellation:
            input.allowRevokedOrchestrationCancellation,
        })
      )
        assertCurrentAuthority(
          current.state,
          current.lease,
          input.allowExpiredLease === true && input.actorKind === "human",
        );
      const epoch = current.state.lease?.epoch ?? current.state.leaseBinding?.epoch;
      if (epoch === undefined)
        throw new Error(`Run ${input.runId} has no active lease authority.`);
      const priorEvent = current.state.idempotencyKeys[input.idempotencyKey];
      if (priorEvent)
        return {
          tip: current.tip,
          events: current.events,
          state: current.state,
          ...(current.state.lease ? { lease: current.state.lease } : {}),
        };
      const event = createRunEvent({
        runId: input.runId,
        repository: current.state.repository,
        sequence: current.state.sequence + 1,
        previousEventHash: current.state.lastEventHash,
        type: input.type,
        actor: {
          kind: input.actorKind ?? "extension",
          sessionId: input.sessionId,
          leaseEpoch: epoch,
        },
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      });
      const state = applyRunEvent(current.state, event);
      const events = [...current.events, event];
      try {
        const tip = await this.#store.commitRunState({
          expectedTip: current.tip,
          events,
          state,
          ...(state.lease
            ? { lease: state.lease }
            : state.leaseBinding
              ? { preserveRepositoryLease: true }
              : {}),
          message: input.message,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return { tip, events, state, ...(state.lease ? { lease: state.lease } : {}) };
      } catch (error) {
        if (
          !(error instanceof StateBranchConflictError) ||
          attempt === MAX_CAS_ATTEMPTS
        )
          throw error;
        await casBackoff(attempt, input.signal);
      }
    }
    throw new Error(`Unable to append run ${input.runId}.`);
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

function validateOrchestrationLease(
  lease: RepositoryLease | undefined,
  binding: { ownerRunId: string; epoch: number },
  now: Date,
): RepositoryLease {
  if (!lease)
    throw new Error(
      `Repository lease for orchestration ${binding.ownerRunId} is missing.`,
    );
  if (
    lease.ownerRunId !== binding.ownerRunId ||
    lease.epoch !== binding.epoch ||
    isLeaseExpired(lease, now)
  ) {
    throw new Error(
      `Repository lease no longer authorizes orchestration ${binding.ownerRunId} epoch ${binding.epoch}.`,
    );
  }
  return lease;
}

export function isRevokedOrchestrationCancellationAuthorized(input: {
  state: RunState;
  type: RunEventType;
  actorKind: "extension" | "human" | undefined;
  allowRevokedOrchestrationCancellation: boolean | undefined;
}): boolean {
  return Boolean(
    input.allowRevokedOrchestrationCancellation === true &&
      input.actorKind === "human" &&
      input.type === "run.cancelled" &&
      input.state.leaseBinding,
  );
}

export function assertCurrentAuthority(
  state: RunState,
  repositoryLease: RepositoryLease | undefined,
  allowExpiredLease = false,
): void {
  if (state.lease) {
    if (
      !repositoryLease ||
      repositoryLease.ownerRunId !== state.runId ||
      repositoryLease.epoch !== state.lease.epoch ||
      (!allowExpiredLease && isLeaseExpired(repositoryLease, new Date()))
    )
      throw new Error(`Run ${state.runId} no longer owns the repository lease.`);
    return;
  }
  if (state.leaseBinding) {
    if (
      !repositoryLease ||
      repositoryLease.ownerRunId !== state.leaseBinding.ownerRunId ||
      repositoryLease.epoch !== state.leaseBinding.epoch ||
      (!allowExpiredLease && isLeaseExpired(repositoryLease, new Date()))
    ) {
      throw new Error(
        `Run ${state.runId} orchestration lease binding is stale.`,
      );
    }
    return;
  }
  throw new Error(`Run ${state.runId} has no lease authority.`);
}
