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
import {
  createRunEvent,
  type RunEvent,
  type RunEventPayload,
  type RunEventType,
} from "../../src/core/events.ts";
import { acquireLease } from "../../src/core/lease.ts";
import {
  applyOrchestrationEvent,
  createOrchestrationEvent,
} from "../../src/core/orchestration.ts";
import { applyRunEvent, type RunState } from "../../src/core/state.ts";

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

const headers = {};
const repository = "owner/repo";
const runId = "run-1";
const sessionId = "session-1";
const timestamp = "2026-01-01T00:00:00.000Z";

function response(status: number, data: unknown): GitHubResponse<unknown> {
  return { status, data, headers };
}

function next(
  state: RunState | undefined,
  type: RunEventType,
  payload: RunEventPayload,
  key: string,
  epoch = state?.lease?.epoch ?? 0,
): RunEvent {
  return createRunEvent({
    runId,
    repository,
    sequence: (state?.sequence ?? 0) + 1,
    previousEventHash: state?.lastEventHash ?? null,
    type,
    actor: { kind: "extension", sessionId, leaseEpoch: epoch },
    idempotencyKey: key,
    payload,
    eventId: `event-${key}`,
    occurredAt: timestamp,
  });
}

function journal(): {
  events: RunEvent[];
  state: RunState;
  lease: NonNullable<RunState["lease"]>;
} {
  const events: RunEvent[] = [];
  const created = next(
    undefined,
    "run.created",
    {
      issueNumber: 42,
      integrationBranch: "staging",
      protectedBranch: "main",
    },
    "create",
  );
  events.push(created);
  let state = applyRunEvent(undefined, created);
  const lease = acquireLease(undefined, {
    repository,
    owner: { runId, sessionId },
    now: new Date(timestamp),
    ttlSeconds: 300,
  });
  const leased = next(state, "lease.acquired", { lease }, "lease", 1);
  events.push(leased);
  state = applyRunEvent(state, leased);
  return { events, state, lease };
}

test("state branch bootstrap creates an orphan state-only commit", async () => {
  let blobCounter = 0;
  const transport = new MockTransport((request) => {
    if (request.method === "GET" && request.path.includes("/git/ref/heads/"))
      return response(404, {});
    if (request.method === "POST" && request.path.endsWith("/git/blobs"))
      return response(201, { sha: `blob-${++blobCounter}` });
    if (request.method === "POST" && request.path.endsWith("/git/trees"))
      return response(201, { sha: "tree-1" });
    if (request.method === "POST" && request.path.endsWith("/git/commits"))
      return response(201, { sha: "commit-1" });
    if (request.method === "POST" && request.path.endsWith("/git/refs"))
      return response(201, { object: { sha: "commit-1" } });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const store = new GitHubStateBranchStore(transport, repository);
  assert.equal(await store.ensureBranch(new Date(timestamp)), "commit-1");
  const commitRequest = transport.requests.find(
    (request) =>
      request.method === "POST" && request.path.endsWith("/git/commits"),
  );
  assert.deepEqual((commitRequest?.body as { parents: string[] }).parents, []);
});

test("state append uses a non-force compare-and-set ref update", async () => {
  const { events, state, lease } = journal();
  let blobCounter = 0;
  const transport = new MockTransport((request) => {
    if (
      request.method === "GET" &&
      request.path.endsWith("/git/commits/tip-1")
    ) {
      return response(200, { sha: "tip-1", tree: { sha: "base-tree" } });
    }
    if (request.method === "POST" && request.path.endsWith("/git/blobs"))
      return response(201, { sha: `blob-${++blobCounter}` });
    if (request.method === "POST" && request.path.endsWith("/git/trees"))
      return response(201, { sha: "tree-2" });
    if (request.method === "POST" && request.path.endsWith("/git/commits"))
      return response(201, { sha: "commit-2" });
    if (request.method === "PATCH" && request.path.includes("/git/refs/heads/"))
      return response(200, { object: { sha: "commit-2" } });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const store = new GitHubStateBranchStore(transport, repository);
  assert.equal(
    await store.commitRunState({
      expectedTip: "tip-1",
      events,
      state,
      lease,
      message: "Fail issue #2 launch",
    }),
    "commit-2",
  );
  const patch = transport.requests.find(
    (request) => request.method === "PATCH",
  );
  assert.deepEqual(patch?.body, { sha: "commit-2", force: false });
  const commit = transport.requests.find(
    (request) =>
      request.method === "POST" && request.path.endsWith("/git/commits"),
  );
  assert.deepEqual((commit?.body as { parents: string[] }).parents, ["tip-1"]);
  assert.equal(
    (commit?.body as { message: string }).message,
    "Fail issue 2 launch",
  );
});

test("run-scoped state commits do not update the global repository lock", async () => {
  const events: RunEvent[] = [];
  const created = next(
    undefined,
    "run.created",
    {
      issueNumber: 42,
      integrationBranch: "staging",
      protectedBranch: "main",
      authorityMode: "run-scoped",
    },
    "run-scoped-create",
  );
  events.push(created);
  let state = applyRunEvent(undefined, created);
  const authority = acquireLease(undefined, {
    repository,
    owner: { runId, sessionId },
    now: new Date(timestamp),
    ttlSeconds: 300,
  });
  const acquired = next(state, "lease.acquired", { lease: authority }, "run-scoped-authority", 1);
  events.push(acquired);
  state = applyRunEvent(state, acquired);

  let treeBody: unknown;
  let blobCounter = 0;
  const transport = new MockTransport((request) => {
    if (request.method === "GET" && request.path.endsWith("/git/commits/tip-1"))
      return response(200, { sha: "tip-1", tree: { sha: "base-tree" } });
    if (request.method === "POST" && request.path.endsWith("/git/blobs"))
      return response(201, { sha: `blob-${++blobCounter}` });
    if (request.method === "POST" && request.path.endsWith("/git/trees")) {
      treeBody = request.body;
      return response(201, { sha: "tree-run-scoped" });
    }
    if (request.method === "POST" && request.path.endsWith("/git/commits"))
      return response(201, { sha: "commit-run-scoped" });
    if (request.method === "PATCH" && request.path.includes("/git/refs/heads/"))
      return response(200, { object: { sha: "commit-run-scoped" } });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const store = new GitHubStateBranchStore(transport, repository);
  await store.commitRunState({
    expectedTip: "tip-1",
    events,
    state,
    runScopedAuthority: true,
    message: "Initialize concurrent run authority",
  });
  const entries = (treeBody as { tree: Array<{ path: string; sha: string | null }> }).tree;
  assert.equal(
    entries.some((entry) => entry.path === ".forgedock/locks/repository.json"),
    false,
  );
});

test("orchestration commits preserve an unrelated repository lock", async () => {
  const orchestrationId = "orchestration-1";
  const event = createOrchestrationEvent({
    orchestrationId,
    repository,
    sequence: 1,
    previousEventHash: null,
    type: "orchestration.created",
    idempotencyKey: "orchestration:create",
    payload: {
      issueNumbers: [42],
      integrationBranch: "staging",
      maxConcurrent: 2,
      leaseEpoch: 1,
    },
    eventId: "orchestration-event-1",
    occurredAt: timestamp,
  });
  const state = applyOrchestrationEvent(undefined, event);

  let treeBody: unknown;
  let blobCounter = 0;
  const transport = new MockTransport((request) => {
    if (request.method === "GET" && request.path.endsWith("/git/commits/tip-1"))
      return response(200, { sha: "tip-1", tree: { sha: "base-tree" } });
    if (request.method === "POST" && request.path.endsWith("/git/blobs"))
      return response(201, { sha: `blob-${++blobCounter}` });
    if (request.method === "POST" && request.path.endsWith("/git/trees")) {
      treeBody = request.body;
      return response(201, { sha: "tree-orchestration" });
    }
    if (request.method === "POST" && request.path.endsWith("/git/commits"))
      return response(201, { sha: "commit-orchestration" });
    if (request.method === "PATCH" && request.path.includes("/git/refs/heads/"))
      return response(200, { object: { sha: "commit-orchestration" } });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const store = new GitHubStateBranchStore(transport, repository);
  await store.commitOrchestrationState({
    expectedTip: "tip-1",
    events: [event],
    state,
    message: "Initialize orchestration",
  });

  const body = treeBody as {
    base_tree: string;
    tree: Array<{ path: string; sha: string | null }>;
  };
  assert.equal(body.base_tree, "base-tree");
  assert.equal(
    body.tree.some(
      (entry) => entry.path === ".forgedock/locks/repository.json",
    ),
    false,
  );
});

test("run-scoped terminal state can release embedded authority without a global lock", async () => {
  const events: RunEvent[] = [];
  const created = next(
    undefined,
    "run.created",
    {
      issueNumber: 42,
      integrationBranch: "staging",
      protectedBranch: "main",
      authorityMode: "run-scoped",
    },
    "terminal-create",
  );
  events.push(created);
  let state = applyRunEvent(undefined, created);
  const authority = acquireLease(undefined, {
    repository,
    owner: { runId, sessionId },
    now: new Date(timestamp),
    ttlSeconds: 300,
  });
  const acquired = next(
    state,
    "lease.acquired",
    { lease: authority },
    "terminal-authority",
    authority.epoch,
  );
  events.push(acquired);
  state = applyRunEvent(state, acquired);
  const cancelled = next(
    state,
    "run.cancelled",
    { reason: "explicit cancellation" },
    "terminal-cancel",
    authority.epoch,
  );
  events.push(cancelled);
  state = applyRunEvent(state, cancelled);
  const released = next(
    state,
    "lease.released",
    { ownerRunId: runId, epoch: authority.epoch },
    "terminal-release",
    authority.epoch,
  );
  events.push(released);
  state = applyRunEvent(state, released);
  assert.equal(state.status, "cancelled");
  assert.equal(state.lease, undefined);

  let treeBody: unknown;
  let blobCounter = 0;
  const transport = new MockTransport((request) => {
    if (request.method === "GET" && request.path.endsWith("/git/commits/tip-1"))
      return response(200, { sha: "tip-1", tree: { sha: "base-tree" } });
    if (request.method === "POST" && request.path.endsWith("/git/blobs"))
      return response(201, { sha: `blob-${++blobCounter}` });
    if (request.method === "POST" && request.path.endsWith("/git/trees")) {
      treeBody = request.body;
      return response(201, { sha: "tree-terminal" });
    }
    if (request.method === "POST" && request.path.endsWith("/git/commits"))
      return response(201, { sha: "commit-terminal" });
    if (request.method === "PATCH" && request.path.includes("/git/refs/heads/"))
      return response(200, { object: { sha: "commit-terminal" } });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const store = new GitHubStateBranchStore(transport, repository);
  await store.commitRunState({
    expectedTip: "tip-1",
    events,
    state,
    runScopedAuthority: true,
    message: "Release terminal run authority",
  });
  const entries = (treeBody as {
    tree: Array<{ path: string; sha: string | null }>;
  }).tree;
  assert.equal(
    entries.some((entry) => entry.path === ".forgedock/locks/repository.json"),
    false,
  );
});

test("non-fast-forward state update becomes a CAS conflict", async () => {
  const { events, state, lease } = journal();
  let blobCounter = 0;
  const transport = new MockTransport((request) => {
    if (request.method === "GET")
      return response(200, { sha: "tip-1", tree: { sha: "base-tree" } });
    if (request.path.endsWith("/git/blobs"))
      return response(201, { sha: `blob-${++blobCounter}` });
    if (request.path.endsWith("/git/trees"))
      return response(201, { sha: "tree-2" });
    if (request.path.endsWith("/git/commits"))
      return response(201, { sha: "commit-2" });
    if (request.method === "PATCH")
      return response(422, { message: "Update is not a fast forward" });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const store = new GitHubStateBranchStore(transport, repository);
  await assert.rejects(
    store.commitRunState({
      expectedTip: "tip-1",
      events,
      state,
      lease,
      message: "Checkpoint run-1",
    }),
    StateBranchConflictError,
  );
});

test("run replay trusts the journal and detects a stale snapshot", async () => {
  const { events, state, lease } = journal();
  const blobs: Record<string, string> = {
    events: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    snapshot: `${JSON.stringify({ ...state, sequence: 1 })}\n`,
    lease: `${JSON.stringify(lease)}\n`,
  };
  const transport = new MockTransport((request) => {
    if (request.path.includes("/git/ref/heads/"))
      return response(200, { object: { sha: "tip-1" } });
    if (request.path.endsWith("/git/commits/tip-1"))
      return response(200, { sha: "tip-1", tree: { sha: "tree-1" } });
    if (request.path.includes("/git/trees/tree-1"))
      return response(200, {
        sha: "tree-1",
        tree: [
          {
            path: ".forgedock/runs/run-1/events.ndjson",
            type: "blob",
            sha: "events",
          },
          {
            path: ".forgedock/runs/run-1/snapshot.json",
            type: "blob",
            sha: "snapshot",
          },
          {
            path: ".forgedock/locks/repository.json",
            type: "blob",
            sha: "lease",
          },
        ],
      });
    const blobName = request.path.split("/").at(-1) ?? "";
    if (blobName in blobs)
      return response(200, {
        sha: blobName,
        encoding: "base64",
        content: Buffer.from(blobs[blobName] ?? "").toString("base64"),
      });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const store = new GitHubStateBranchStore(transport, repository);
  const result = await store.readRun(runId);
  assert.equal(result.state?.sequence, 2);
  assert.equal(result.snapshotMatchesJournal, false);
  assert.equal(result.lease?.epoch, 1);
});
