import {
  type CommitReviewStateInput,
  type GitHubStateBranchStore,
  type ReadReviewStateResult,
  StateBranchConflictError,
} from "./github-state.ts";
import { canonicalJson } from "../core/events.ts";
import {
  applyReviewEvent,
  createReviewEvent,
  type ReviewEvent,
  type ReviewEventPayload,
  type ReviewEventType,
  type ReviewMode,
  type ReviewRoute,
  type ReviewRoster,
  type ReviewState,
} from "../core/review-state.ts";
import {
  MAX_STATE_CAS_ATTEMPTS,
  stateCasBackoff,
} from "./state-cas.ts";

export interface InitializeReviewInput {
  reviewId: string;
  repository: string;
  pullNumber?: number;
  /** Alias accepted at the adapter boundary for GitHub terminology. */
  pullRequest?: number;
  issueNumber?: number;
  mode: ReviewMode;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  roster: ReviewRoster;
  route?: ReviewRoute;
  now?: Date;
  signal?: AbortSignal;
}

export interface ReviewJournalSnapshot extends ReadReviewStateResult {
  state: ReviewState;
}

export interface AppendReviewEventInput {
  reviewId: string;
  type: ReviewEventType;
  payload: ReviewEventPayload;
  idempotencyKey: string;
  message: string;
  signal?: AbortSignal;
}

/**
 * Durable controller-owned review journal. Reviewer processes only return typed
 * artifacts; they never receive this adapter or a GitHub write capability.
 */
export class ReviewJournal {
  readonly #store: GitHubStateBranchStore;

  constructor(store: GitHubStateBranchStore) {
    this.#store = store;
  }

  async initialize(input: InitializeReviewInput): Promise<ReviewJournalSnapshot> {
    const pullNumber = input.pullNumber ?? input.pullRequest;
    if (pullNumber === undefined) throw new TypeError("pullNumber is required.");
    if (
      input.pullNumber !== undefined &&
      input.pullRequest !== undefined &&
      input.pullNumber !== input.pullRequest
    )
      throw new TypeError("pullNumber and pullRequest must match.");

    await this.#store.ensureBranch(input.now ?? new Date(), input.signal);
    for (let attempt = 1; attempt <= MAX_STATE_CAS_ATTEMPTS; attempt += 1) {
      const existing = await this.#store.readReview(input.reviewId, input.signal);
      if (!existing.snapshotMatchesJournal)
        throw new Error(`Review ${input.reviewId} has an invalid snapshot/journal pair.`);
      if (existing.events.length > 0) {
        if (!existing.state)
          throw new Error(`Review ${input.reviewId} has events without a snapshot.`);
        assertExistingReviewMatches(existing.state, input, pullNumber);
        return {
          tip: existing.tip,
          events: existing.events,
          state: existing.state,
          snapshotMatchesJournal: true,
        };
      }
      const now = input.now ?? new Date();
      const event = createReviewEvent({
        reviewId: input.reviewId,
        repository: input.repository,
        sequence: 1,
        previousEventHash: null,
        type: "review.created",
        idempotencyKey: "review:create",
        payload: {
          pullNumber,
          ...(input.issueNumber === undefined
            ? {}
            : { issueNumber: input.issueNumber }),
          mode: input.mode,
          headRef: input.headRef,
          headSha: input.headSha,
          baseRef: input.baseRef,
          baseSha: input.baseSha,
          roster: input.roster,
          ...(input.route === undefined ? {} : { route: input.route }),
        },
        occurredAt: now.toISOString(),
      });
      const state = applyReviewEvent(undefined, event);
      const events: ReviewEvent[] = [event];
      try {
        const tip = await this.#store.commitReviewState({
          expectedTip: existing.tip,
          events,
          state,
          message: `Initialize ForgeDock review ${input.reviewId}`,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return { tip, events, state, snapshotMatchesJournal: true };
      } catch (error) {
        if (
          !(error instanceof StateBranchConflictError) ||
          attempt === MAX_STATE_CAS_ATTEMPTS
        )
          throw error;
        await stateCasBackoff(attempt, input.signal);
      }
    }
    throw new Error(`Unable to initialize review ${input.reviewId}.`);
  }

  async read(
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<ReviewJournalSnapshot | undefined> {
    const current = await this.#store.readReview(reviewId, signal);
    if (!current.snapshotMatchesJournal)
      throw new Error(`Review ${reviewId} has an invalid snapshot/journal pair.`);
    if (!current.state) return undefined;
    return {
      tip: current.tip,
      events: current.events,
      state: current.state,
      snapshotMatchesJournal: true,
    };
  }

  async append(input: AppendReviewEventInput): Promise<ReviewJournalSnapshot> {
    for (let attempt = 1; attempt <= MAX_STATE_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#store.readReview(input.reviewId, input.signal);
      if (!current.snapshotMatchesJournal)
        throw new Error(`Review ${input.reviewId} has an invalid snapshot/journal pair.`);
      if (!current.state)
        throw new Error(`Review ${input.reviewId} does not exist.`);
      const priorEventId = current.state.idempotencyKeys[input.idempotencyKey];
      if (priorEventId) {
        const priorEvent = current.events.find(
          (event) => event.eventId === priorEventId,
        );
        if (
          !priorEvent ||
          priorEvent.type !== input.type ||
          canonicalJson(priorEvent.payload) !== canonicalJson(input.payload)
        )
          throw new Error(
            `Review idempotency key ${input.idempotencyKey} conflicts with an existing event.`,
          );
        return {
          tip: current.tip,
          events: current.events,
          state: current.state,
          snapshotMatchesJournal: current.snapshotMatchesJournal,
        };
      }
      const event = createReviewEvent({
        reviewId: input.reviewId,
        repository: current.state.repository,
        sequence: current.state.sequence + 1,
        previousEventHash: current.state.lastEventHash,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      });
      const state = applyReviewEvent(current.state, event);
      const events = [...current.events, event];
      const commit: CommitReviewStateInput = {
        expectedTip: current.tip,
        events,
        state,
        message: input.message,
        ...(input.signal ? { signal: input.signal } : {}),
      };
      try {
        const tip = await this.#store.commitReviewState(commit);
        return { tip, events, state, snapshotMatchesJournal: true };
      } catch (error) {
        if (
          !(error instanceof StateBranchConflictError) ||
          attempt === MAX_STATE_CAS_ATTEMPTS
        )
          throw error;
        await stateCasBackoff(attempt, input.signal);
      }
    }
    throw new Error(`Unable to append review ${input.reviewId}.`);
  }

  /** Explicit name for callers that append a review event. */
  async appendEvent(input: AppendReviewEventInput): Promise<ReviewJournalSnapshot> {
    return this.append(input);
  }

  /** Alias matching the durable event operation used by other journals. */
  async appendReviewEvent(input: AppendReviewEventInput): Promise<ReviewJournalSnapshot> {
    return this.append(input);
  }
}

function assertExistingReviewMatches(
  state: ReviewState,
  input: InitializeReviewInput,
  pullNumber: number,
): void {
  const expected = {
    reviewId: input.reviewId,
    repository: input.repository,
    pullNumber,
    issueNumber: input.issueNumber,
    mode: input.mode,
    headRef: input.headRef,
    headSha: input.headSha,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    roster: input.roster,
    route: input.route,
  };
  const actual = {
    reviewId: state.reviewId,
    repository: state.repository,
    pullNumber: state.pullNumber,
    issueNumber: state.issueNumber,
    mode: state.mode,
    headRef: state.headRef,
    headSha: state.headSha,
    baseRef: state.baseRef,
    baseSha: state.baseSha,
    roster: state.roster,
    route: state.route,
  };
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error(
      `Review ${input.reviewId} already exists with different frozen identity or roster.`,
    );
}

export const ReviewStateJournal = ReviewJournal;
export type ReviewJournalInput = InitializeReviewInput;
