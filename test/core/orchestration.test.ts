import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOrchestrationEvent,
  createOrchestrationEvent,
  readyOrchestrationLanes,
  type OrchestrationEventType,
  type OrchestrationState,
} from "../../src/core/orchestration.ts";
import {
  childCleanupReason,
  lifecycleMatchesForgeRun,
  rateLimitedOrchestrationConcurrency,
} from "../../src/workflows/orchestrate.ts";

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

test("GitHub budget adaptively bounds lane concurrency below the configured maximum", () => {
  const state = applyOrchestrationEvent(
    undefined,
    next(
      undefined,
      "orchestration.created",
      {
        issueNumbers: [1, 2, 3, 4, 5, 6],
        integrationBranch: "staging",
        maxConcurrent: 16,
        leaseEpoch: 1,
      },
      "rate-create",
    ),
  );
  const effective = rateLimitedOrchestrationConcurrency(16, {
    limit: 5_000,
    remaining: 5_000,
    resetAt: Date.now() + 60_000,
  });
  assert.equal(effective, 5);
  assert.equal(
    rateLimitedOrchestrationConcurrency(16, {
      limit: 15_000,
      remaining: 15_000,
      resetAt: Date.now() + 60_000,
    }),
    16,
  );
  assert.deepEqual(
    readyOrchestrationLanes(state, effective).map((lane) => lane.issueNumber),
    [1, 2, 3, 4, 5],
  );
  assert.equal(
    rateLimitedOrchestrationConcurrency(16, {
      limit: 5_000,
      remaining: 1_000,
      resetAt: Date.now() + 60_000,
    }),
    0,
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
        reason:
          "Completed work-on subagent did not return a schema-valid Forge result artifact.",
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

test("terminal failed lanes require child cleanup before completion", () => {
  let state = initialized();
  assert.equal(childCleanupReason(state), undefined);
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.failed",
      { issueNumber: 2, reason: "artifact identity mismatch" },
      "fail-before-start",
    ),
  );
  assert.match(childCleanupReason(state) ?? "", /#2:failed/);
});

test("successfully closed lanes do not request cancellation cleanup", () => {
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
      "start-for-close",
    ),
  );
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.closed",
      { issueNumber: 2, reason: "invalid issue" },
      "closed",
    ),
  );
  assert.equal(childCleanupReason(state), undefined);
});
