import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubStateBranchStore,
  StateBranchConflictError,
} from "../../src/adapters/github-state.ts";
import type {
  GitHubRequest,
  GitHubResponse,
  GitHubTransport,
} from "../../src/adapters/github-api.ts";
import { ReviewJournal } from "../../src/adapters/review-journal.ts";
import {
  applyReviewEvent,
  createReviewEvent,
  type ReviewEvent,
  type ReviewState,
} from "../../src/core/review-state.ts";

class MockTransport implements GitHubTransport {
  readonly requests: GitHubRequest[] = [];
  readonly #handler: (request: GitHubRequest) => GitHubResponse<unknown>;

  constructor(handler: (request: GitHubRequest) => GitHubResponse<unknown>) {
    this.#handler = handler;
  }

  async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
    this.requests.push(request);
    return this.#handler(request) as GitHubResponse<T>;
  }
}

const repository = "owner/repo";
const reviewId = "review-branch-1";
const timestamp = "2026-08-27T00:00:00.000Z";

function reviewJournal(): { events: ReviewEvent[]; state: ReviewState } {
  const event = createReviewEvent({
    reviewId,
    repository,
    sequence: 1,
    previousEventHash: null,
    type: "review.created",
    idempotencyKey: "create",
    eventId: "review-event-1",
    occurredAt: timestamp,
    payload: {
      pullNumber: 12,
      mode: "standard",
      headRef: "forge/12",
      headSha: "head-sha",
      baseRef: "main",
      baseSha: "base-sha",
      roster: { version: "v1", reviewers: ["correctness"] },
    },
  });
  return { events: [event], state: applyReviewEvent(undefined, event) };
}

function response(status: number, data: unknown): GitHubResponse<unknown> {
  return { status, data, headers: {} };
}

test("review state commits write an isolated journal and non-force CAS update", async () => {
  const { events, state } = reviewJournal();
  let blobCounter = 0;
  let treeBody: unknown;
  const transport = new MockTransport((request) => {
    if (request.method === "GET" && request.path.endsWith("/git/commits/tip-1"))
      return response(200, { sha: "tip-1", tree: { sha: "tree-1" } });
    if (request.method === "POST" && request.path.endsWith("/git/blobs"))
      return response(201, { sha: `blob-${++blobCounter}` });
    if (request.method === "POST" && request.path.endsWith("/git/trees")) {
      treeBody = request.body;
      return response(201, { sha: "tree-2" });
    }
    if (request.method === "POST" && request.path.endsWith("/git/commits"))
      return response(201, { sha: "commit-2" });
    if (request.method === "PATCH" && request.path.includes("/git/refs/heads/"))
      return response(200, { object: { sha: "commit-2" } });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const store = new GitHubStateBranchStore(transport, repository);
  assert.equal(await store.commitReviewState({
    expectedTip: "tip-1", events, state, message: "Record standalone review",
  }), "commit-2");
  const entries = (treeBody as { tree: Array<{ path: string; sha: string }> }).tree;
  assert.deepEqual(entries.map((entry) => entry.path).sort(), [
    ".forgedock/reviews/review-branch-1/events.ndjson",
    ".forgedock/reviews/review-branch-1/snapshot.json",
  ]);
  const patch = transport.requests.find((request) => request.method === "PATCH");
  assert.deepEqual(patch?.body, { sha: "commit-2", force: false });
});

test("review commits reject a snapshot that does not replay from its journal", async () => {
  const { events, state } = reviewJournal();
  const transport = new MockTransport(() =>
    response(200, { sha: "tip-1", tree: { sha: "tree-1" } }),
  );
  const store = new GitHubStateBranchStore(transport, repository);
  await assert.rejects(
    store.commitReviewState({
      expectedTip: "tip-1",
      events,
      state: { ...state, baseSha: "tampered" },
      message: "Reject stale snapshot",
    }),
    /snapshot does not match/i,
  );
  assert.equal(transport.requests.length, 0);
});

test("review CAS conflicts use the shared state branch conflict error", async () => {
  const { events, state } = reviewJournal();
  let blobCounter = 0;
  const transport = new MockTransport((request) => {
    if (request.method === "GET")
      return response(200, { sha: "tip-1", tree: { sha: "tree-1" } });
    if (request.method === "POST" && request.path.endsWith("/git/blobs"))
      return response(201, { sha: `blob-${++blobCounter}` });
    if (request.method === "POST" && request.path.endsWith("/git/trees"))
      return response(201, { sha: "tree-2" });
    if (request.method === "POST" && request.path.endsWith("/git/commits"))
      return response(201, { sha: "commit-2" });
    if (request.method === "PATCH")
      return response(409, { message: "non-fast-forward" });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const store = new GitHubStateBranchStore(transport, repository);
  await assert.rejects(
    store.commitReviewState({ expectedTip: "tip-1", events, state, message: "CAS" }),
    StateBranchConflictError,
  );
});

test("review journal initialization and event retries are identity-idempotent", async () => {
  let stored:
    | {
        tip: string;
        events: ReviewEvent[];
        state: ReviewState;
        snapshotMatchesJournal: true;
      }
    | undefined;
  const store = {
    async ensureBranch(): Promise<string> {
      return stored?.tip ?? "tip-0";
    },
    async readReview(): Promise<{
      tip: string;
      events: ReviewEvent[];
      state?: ReviewState;
      snapshotMatchesJournal: boolean;
    }> {
      return (
        stored ?? {
          tip: "tip-0",
          events: [],
          snapshotMatchesJournal: true,
        }
      );
    },
    async commitReviewState(input: {
      events: ReviewEvent[];
      state: ReviewState;
    }): Promise<string> {
      const tip = `tip-${input.state.sequence}`;
      stored = {
        tip,
        events: input.events,
        state: input.state,
        snapshotMatchesJournal: true,
      };
      return tip;
    },
  } as unknown as GitHubStateBranchStore;
  const journal = new ReviewJournal(store);
  const initialize = {
    reviewId: "review-idempotent",
    repository,
    pullNumber: 12,
    mode: "standard" as const,
    headRef: "forge/12",
    headSha: "head-sha",
    baseRef: "main",
    baseSha: "base-sha",
    roster: { version: "v1", reviewers: ["correctness"] },
    now: new Date(timestamp),
  };

  const created = await journal.initialize(initialize);
  assert.deepEqual(await journal.initialize(initialize), created);
  await assert.rejects(
    journal.initialize({ ...initialize, headSha: "different-head" }),
    /different frozen identity/i,
  );
  await assert.rejects(
    journal.initialize({ ...initialize, pullRequest: 13 }),
    /must match/i,
  );

  const append = {
    reviewId: initialize.reviewId,
    type: "review.panel-started" as const,
    payload: { round: 1 },
    idempotencyKey: "panel:1:start",
    message: "Start review panel",
  };
  const started = await journal.append(append);
  assert.deepEqual(await journal.append(append), started);
  await assert.rejects(
    journal.append({ ...append, payload: { round: 2 } }),
    /idempotency key.*conflicts/i,
  );
  assert.deepEqual(await journal.read(initialize.reviewId), started);
});
