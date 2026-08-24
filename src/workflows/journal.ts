import {
  createRunEvent,
  type RunEventPayload,
  type RunEventType,
} from "../core/events.ts";
import { acquireLease, type RepositoryLease } from "../core/lease.ts";
import { applyRunEvent, type RunState } from "../core/state.ts";
import type { GitHubStateBranchStore } from "../adapters/github-state.ts";

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
  events: readonly import("../core/events.ts").RunEvent[];
  state: RunState;
  lease?: RepositoryLease;
}

export class RunJournal {
  readonly #store: GitHubStateBranchStore;

  constructor(store: GitHubStateBranchStore) {
    this.#store = store;
  }

  async initialize(input: InitializeRunInput): Promise<JournalSnapshot> {
    const tip = await this.#store.ensureBranch(
      input.now ?? new Date(),
      input.signal,
    );
    const existing = await this.#store.readRun(input.runId, input.signal);
    if (existing.events.length > 0)
      throw new Error(`Run ${input.runId} already exists.`);
    const now = input.now ?? new Date();
    const lease = acquireLease(existing.lease, {
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
      },
      occurredAt: now.toISOString(),
    });
    let state = applyRunEvent(undefined, created);
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
    const events = [created, acquired];
    const nextTip = await this.#store.commitRunState({
      expectedTip: tip,
      events,
      state,
      lease,
      message: `Initialize ForgeDock run ${input.runId}`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { tip: nextTip, events, state, lease };
  }

  async append(input: {
    runId: string;
    type: RunEventType;
    payload: RunEventPayload;
    idempotencyKey: string;
    sessionId: string;
    actorKind?: "extension" | "human";
    message: string;
    signal?: AbortSignal;
  }): Promise<JournalSnapshot> {
    const current = await this.#store.readRun(input.runId, input.signal);
    if (!current.state) throw new Error(`Run ${input.runId} does not exist.`);
    const epoch = current.lease?.epoch ?? current.state.lease?.epoch;
    if (epoch === undefined)
      throw new Error(`Run ${input.runId} has no active lease.`);
    const priorEvent = current.state.idempotencyKeys[input.idempotencyKey];
    if (priorEvent)
      return {
        tip: current.tip,
        events: current.events,
        state: current.state,
        ...(current.lease ? { lease: current.lease } : {}),
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
    const lease = state.lease;
    const events = [...current.events, event];
    const tip = await this.#store.commitRunState({
      expectedTip: current.tip,
      events,
      state,
      ...(lease ? { lease } : {}),
      message: input.message,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { tip, events, state, ...(lease ? { lease } : {}) };
  }
}
