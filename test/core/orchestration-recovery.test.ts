import assert from "node:assert/strict";
import test from "node:test";

import {
  createIntegrationLane,
} from "../../src/core/integration-lane.ts";
import {
  classifyOrchestrationLane,
  createOrchestrationBatchState,
  orchestrationChildKey,
  planOrchestrationReload,
} from "../../src/core/orchestration-recovery.ts";
import type { OrchestrationState } from "../../src/core/orchestration.ts";

function state(): Pick<OrchestrationState, "orchestrationId" | "leaseEpoch" | "lanes" | "dependencies" | "maxConcurrent"> {
  return {
    orchestrationId: "batch-1",
    leaseEpoch: 3,
    maxConcurrent: 2,
    lanes: [
      { issueNumber: 1, ordinal: 0, status: "queued", refreshes: 0 },
      { issueNumber: 2, ordinal: 1, status: "queued", refreshes: 0 },
      { issueNumber: 3, ordinal: 2, status: "queued", refreshes: 0 },
    ],
    dependencies: [
      { fromIssue: 1, toIssue: 2, kind: "explicit", reason: "#2 needs #1" },
    ],
  };
}

test("reload batch persists child keys, predecessors, ready and deferred lanes", () => {
  const batch = createOrchestrationBatchState(state());
  assert.equal(batch.schema, "forgedock.orchestration-recovery/v1");
  assert.equal(batch.leaseEpoch, 3);
  assert.equal(batch.childKeys["1"], orchestrationChildKey("batch-1", 1));
  assert.deepEqual(batch.predecessors["2"], [1]);
  assert.deepEqual(batch.ready, [1, 3]);
  assert.deepEqual(batch.deferred, [2]);
});

test("reload drains three lanes at most once and reconciles retained children", () => {
  const plan = planOrchestrationReload({
    state: state(),
    retainedChildren: [
      { childKey: orchestrationChildKey("batch-1", 1), issueNumber: 1, status: "running", forgeRunId: "child-1" },
    ],
  });
  assert.equal(plan.paused, false);
  assert.deepEqual(plan.reconcile, [1]);
  assert.deepEqual(plan.resume, [3]);
  assert.deepEqual(plan.classifications, { 1: "IN_PROGRESS", 2: "IN_PROGRESS", 3: "IN_PROGRESS" });
});

test("unsafe retained child identity pauses reload instead of launching", () => {
  const plan = planOrchestrationReload({
    state: state(),
    retainedChildren: [
      { childKey: "wrong-child", issueNumber: 1, status: "running" },
    ],
  });
  assert.equal(plan.paused, true);
  assert.deepEqual(plan.resume, []);
  assert.match(plan.reason ?? "", /Paused orchestration reload/);
});

test("typed lane reload rejects stale receipts and retains queue identity", () => {
  const lane = createIntegrationLane({
    kind: "work-order",
    stableId: "wo-1",
    slug: "queue",
    repository: "owner/repo",
    frozenBase: { branch: "main", sha: "0123456789abcdef0123456789abcdef01234567" },
    membership: [
      { issueNumber: 1, ordinal: 0 },
      { issueNumber: 2, ordinal: 1 },
      { issueNumber: 3, ordinal: 2 },
    ],
    sourceQuery: "issues",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    status: "active",
  });
  const plan = planOrchestrationReload({
    state: { ...state(), integrationLane: lane },
    retainedChildren: [{
      childKey: orchestrationChildKey("batch-1", 1),
      issueNumber: 1,
      status: "running",
      laneId: "wo-1",
      baseSha: "stale-base",
      leaseEpoch: 2,
    }],
  });
  assert.equal(plan.paused, true);
  assert.match(plan.reason ?? "", /stale frozen base|stale lease epoch/);
  const batch = createOrchestrationBatchState({ ...state(), integrationLane: lane });
  assert.equal(batch.laneId, "wo-1");
  assert.deepEqual(batch.queue?.map((entry) => entry.position), [0, 1, 2]);
});

test("filtered typed queues renumber positions after a leading lane closes", () => {
  const lane = createIntegrationLane({
    kind: "work-order",
    stableId: "wo-1",
    slug: "queue",
    repository: "owner/repo",
    frozenBase: { branch: "main", sha: "0123456789abcdef0123456789abcdef01234567" },
    membership: [
      { issueNumber: 1, ordinal: 0 },
      { issueNumber: 2, ordinal: 1 },
      { issueNumber: 3, ordinal: 2 },
    ],
    sourceQuery: "issues",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    status: "active",
  });
  const batch = createOrchestrationBatchState({
    ...state(),
    lanes: [
      { issueNumber: 1, ordinal: 0, status: "closed", refreshes: 0 },
      { issueNumber: 2, ordinal: 1, status: "queued", refreshes: 0 },
      { issueNumber: 3, ordinal: 2, status: "queued", refreshes: 0 },
    ],
    integrationLane: lane,
  });
  assert.deepEqual(batch.queue?.map((entry) => entry.position), [0, 1]);
  const plan = planOrchestrationReload({
    state: {
      ...state(),
      lanes: [
        { issueNumber: 1, ordinal: 0, status: "closed", refreshes: 0 },
        { issueNumber: 2, ordinal: 1, status: "queued", refreshes: 0 },
        { issueNumber: 3, ordinal: 2, status: "queued", refreshes: 0 },
      ],
      integrationLane: lane,
    },
    retainedChildren: [],
  });
  assert.equal(plan.paused, false);
});

test("legacy retained children without typed receipt metadata remain reloadable", () => {
  const lane = createIntegrationLane({
    kind: "milestone",
    stableId: "legacy-1",
    slug: "fast-lane",
    branch: "staging",
    repository: "owner/repo",
    frozenBase: { branch: "staging", sha: "0000000" },
    membership: [
      { issueNumber: 1, ordinal: 0 },
      { issueNumber: 2, ordinal: 1 },
      { issueNumber: 3, ordinal: 2 },
    ],
    sourceQuery: "legacy-fast-lane",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    status: "active",
    legacy: true,
  });
  const plan = planOrchestrationReload({
    state: { ...state(), integrationLane: lane },
    retainedChildren: [{
      childKey: orchestrationChildKey("batch-1", 1),
      issueNumber: 1,
      status: "running",
      forgeRunId: "child-1",
    }],
  });
  assert.equal(plan.paused, false);
  assert.deepEqual(plan.reconcile, [1]);
});

test("malformed lane membership pauses reload without throwing", () => {
  const lane = createIntegrationLane({
    kind: "work-order",
    stableId: "wo-1",
    slug: "queue",
    repository: "owner/repo",
    frozenBase: { branch: "main", sha: "0123456789abcdef0123456789abcdef01234567" },
    membership: [{ issueNumber: 1, ordinal: 0 }],
    sourceQuery: "issues",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    status: "active",
  });
  const plan = planOrchestrationReload({
    state: {
      ...state(),
      integrationLane: { ...lane, membership: null } as unknown as typeof lane,
    },
    retainedChildren: [],
  });
  assert.equal(plan.paused, true);
  assert.match(plan.reason ?? "", /membership|invalid/i);
});

test("orchestration classifications are exact and stable", () => {
  assert.equal(classifyOrchestrationLane({ status: "merged" }), "DONE");
  assert.equal(classifyOrchestrationLane({ status: "needs-human" }), "GATED");
  assert.equal(classifyOrchestrationLane({ status: "failed" }), "FAILED");
  assert.equal(classifyOrchestrationLane({ status: "running" }), "IN_PROGRESS");
});
