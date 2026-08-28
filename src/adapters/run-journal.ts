import {
  type CommitRunStateInput,
  type GitHubStateBranchStore,
} from "./github-state.ts";
import {
  createRunEvent,
  type RunEvent,
  type RunEventPayload,
  type RunEventType,
} from "../core/events.ts";
import {
  acquireLease,
  isLeaseExpired,
  type RepositoryLease,
} from "../core/lease.ts";
import { applyRunEvent, type RunState } from "../core/state.ts";
import {
  stateCas,
  StateCasRetry,
} from "./state-cas.ts";

export interface InitializeRunInput {
  runId: string;
  repository: string;
  issueNumber: number;
  integrationBranch: string;
  protectedBranch: string;
  sessionId: string;
  leaseSeconds: number;
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
    return stateCas(async () => {
      const existing = await this.#store.readRun(input.runId, input.signal);
      if (existing.events.length > 0)
        throw new Error(`Run ${input.runId} already exists.`);
      const now = input.now ?? new Date();
      const lease = acquireLease(undefined, {
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
          authorityMode: "run-scoped",
        },
        occurredAt: now.toISOString(),
      });
      let state = applyRunEvent(undefined, created);
      const events: RunEvent[] = [created];
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
      const tip = await this.#store.commitRunState({
        expectedTip: existing.tip,
        events,
        state,
        runScopedAuthority: true,
        message: `Initialize ForgeDock run ${input.runId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { tip, events, state, lease };
    }, input.signal);
  }

  async append(input: {
    runId: string;
    type: RunEventType;
    payload: RunEventPayload;
    idempotencyKey: string;
    sessionId: string;
    actorKind?: "extension" | "human";
    /** Explicit actor epoch for authority re-authorization events (takeover). */
    actorLeaseEpoch?: number;
    message: string;
    signal?: AbortSignal;
  }): Promise<JournalSnapshot> {
    return stateCas(async () => {
      const current = await this.#store.readRun(input.runId, input.signal);
      if (!current.state)
        throw new StateCasRetry(`Run ${input.runId} does not exist.`);
      assertCurrentAuthority(
        current.state,
        current.lease,
        new Date(),
        input.type,
      );
      const epoch =
        input.actorLeaseEpoch ??
        current.state.lease?.epoch ??
        current.state.leaseBinding?.epoch;
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
      const tip = await this.#store.commitRunState({
        expectedTip: current.tip,
        events,
        state,
        ...commitAuthorityFlags(state),
        message: input.message,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { tip, events, state, ...(state.lease ? { lease: state.lease } : {}) };
    }, input.signal);
  }
}

/** Select the durable-authority flags a run-state commit must carry. */
function commitAuthorityFlags(
  state: RunState,
): Partial<
  Pick<
    CommitRunStateInput,
    "runScopedAuthority" | "lease" | "preserveRepositoryLease"
  >
> {
  if (state.authorityMode === "run-scoped") return { runScopedAuthority: true };
  if (state.lease) return { lease: state.lease };
  if (state.leaseBinding) return { preserveRepositoryLease: true };
  return {};
}

function assertCurrentAuthority(
  state: RunState,
  repositoryLease: RepositoryLease | undefined,
  now: Date,
  eventType?: RunEventType,
): void {
  // Cancellation, lease release, and takeover are authority transitions that
  // must never be blocked by lease expiry: a stale or crashed run must stay
  // cancellable by the operator, and recovery/adoption re-arms authority with
  // a new epoch (takeoverLease enforces expiry + authorization identity).
  const authorityTransition =
    eventType === "run.cancelled" ||
    eventType === "lease.released" ||
    eventType === "lease.taken-over";
  if (state.authorityMode === "run-scoped") {
    if (
      !state.lease ||
      state.lease.ownerRunId !== state.runId ||
      (!authorityTransition && isLeaseExpired(state.lease, now))
    )
      throw new Error(`Run ${state.runId} has invalid or expired run-scoped authority.`);
    return;
  }
  if (state.lease) {
    if (
      !repositoryLease ||
      repositoryLease.ownerRunId !== state.runId ||
      repositoryLease.epoch !== state.lease.epoch ||
      (!authorityTransition &&
        (isLeaseExpired(state.lease, now) ||
          isLeaseExpired(repositoryLease, now)))
    )
      throw new Error(`Run ${state.runId} no longer owns the repository lease.`);
    return;
  }
  if (state.leaseBinding) {
    if (
      !repositoryLease ||
      repositoryLease.ownerRunId !== state.leaseBinding.ownerRunId ||
      repositoryLease.epoch !== state.leaseBinding.epoch ||
      (!authorityTransition && isLeaseExpired(repositoryLease, now))
    ) {
      throw new Error(
        `Run ${state.runId} orchestration lease binding is stale.`,
      );
    }
    return;
  }
  throw new Error(`Run ${state.runId} has no lease authority.`);
}
