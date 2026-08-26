import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOrchestrationEvent,
  createOrchestrationEvent,
  type OrchestrationEventType,
  type OrchestrationState,
} from "../../src/core/orchestration.ts";
import {
  cancelChildrenBeforeParent,
  isOwnedActiveChildRun,
  isPublishableLaneReceipt,
  lifecycleMatchesForgeRun,
  shouldBindQueuedLifecycle,
} from "../../src/workflows/orchestrate.ts";

import type { RunState } from "../../src/core/state.ts";

const orchestrationId = "orchestration-1";
const repository = "owner/repo";

function next(
  state: OrchestrationState | undefined,
  type: OrchestrationEventType,
  payload: Record<string, unknown>,
  idempotencyKey: string,
) {
  return createOrchestrationEvent({
    orchestrationId,
    repository,
    sequence: (state?.sequence ?? 0) + 1,
    previousEventHash: state?.lastEventHash ?? null,
    type,
    payload,
    idempotencyKey,
    occurredAt: "2026-08-24T00:00:00.000Z",
  });
}

function initialized(): OrchestrationState {
  return applyOrchestrationEvent(
    undefined,
    next(
      undefined,
      "orchestration.created",
      {
        issueNumbers: [2],
        integrationBranch: "staging",
        maxConcurrent: 2,
        leaseEpoch: 1,
      },
      "create",
    ),
  );
}

test("cancellation revokes children before releasing the parent lease", async () => {
  const order: string[] = [];
  const result = await cancelChildrenBeforeParent({
    cancelChildren: async () => {
      order.push("children-cancelled");
    },
    cancelParent: async () => {
      order.push("parent-cancelled");
      return "cancelled";
    },
  });
  assert.equal(result, "cancelled");
  assert.deepEqual(order, ["children-cancelled", "parent-cancelled"]);

  let parentCalled = false;
  await assert.rejects(
    cancelChildrenBeforeParent({
      cancelChildren: async () => {
        throw new Error("child revocation failed");
      },
      cancelParent: async () => {
        parentCalled = true;
      },
    }),
    /child revocation failed/,
  );
  assert.equal(parentCalled, false);
});

test("lanes publish only real provider receipts", () => {
  assert.equal(isPublishableLaneReceipt("child-resolve-1"), true);
  assert.equal(isPublishableLaneReceipt("pending:forge-run-1"), false);
  assert.equal(isPublishableLaneReceipt("launch:resolve-1:nonce"), false);
});

test("durable cancellation discovers sentinel children outside lane receipts", () => {
  const orchestration = initialized();
  const orphan = {
    runId: "forge-run-orphan",
    status: "active",
    leaseBinding: { ownerRunId: orchestrationId, epoch: 1 },
  } as RunState;
  assert.equal(isOwnedActiveChildRun(orphan, orchestration), true);
  assert.equal(
    isOwnedActiveChildRun(
      {
        ...orphan,
        leaseBinding: { ownerRunId: "other-orchestration", epoch: 1 },
      },
      orchestration,
    ),
    false,
  );
  assert.equal(
    isOwnedActiveChildRun({ ...orphan, status: "cancelled" }, orchestration),
    false,
  );
});

test("an early lifecycle event durably binds its queued lane first", () => {
  assert.equal(
    shouldBindQueuedLifecycle(
      { status: "queued" },
      { forgeRunId: "forge-run-1", subagentRunId: "provider-run-1" },
    ),
    true,
  );
  assert.equal(
    shouldBindQueuedLifecycle(
      { status: "queued" },
      {
        forgeRunId: "forge-run-1",
        subagentRunId: "launch:resolve-1:nonce",
      },
    ),
    false,
  );
});

test("lane lifecycle follows the stable Forge run instead of rotating child receipts", () => {
  assert.equal(
    lifecycleMatchesForgeRun(
      { forgeRunId: "forge-run-1" },
      { forgeRunId: "forge-run-1" },
    ),
    true,
  );
  assert.equal(
    lifecycleMatchesForgeRun(
      { forgeRunId: "forge-run-1" },
      { forgeRunId: "different-forge-run" },
    ),
    false,
  );
});

test("a falsely failed lane can rebind to its still-active child", () => {
  let state = initialized();
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.started",
      {
        issueNumber: 2,
        forgeRunId: "forge-run-2",
        subagentRunId: "workflow-2",
      },
      "start",
    ),
  );
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.failed",
      {
        issueNumber: 2,
        reason: "Completed work-on subagent did not return a schema-valid Forge result artifact.",
      },
      "false-failure",
    ),
  );
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.recovered",
      {
        issueNumber: 2,
        forgeRunId: "forge-run-2",
        subagentRunId: "workflow-2",
      },
      "recover",
    ),
  );
  assert.equal(state.lanes[0]?.status, "running");
  assert.equal(state.lanes[0]?.reason, undefined);
});
