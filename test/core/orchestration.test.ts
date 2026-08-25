import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOrchestrationEvent,
  classifyChildRunIdentity,
  createOrchestrationEvent,
  type OrchestrationEventType,
  type OrchestrationState,
} from "../../src/core/orchestration.ts";
import { lifecycleMatchesForgeRun } from "../../src/workflows/orchestrate.ts";

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

test("child identity classification distinguishes internal sentinels", () => {
  assert.equal(classifyChildRunIdentity("pending:forge-run"), "initializing");
  assert.equal(classifyChildRunIdentity("launch:resolve-1:nonce"), "launch-intent");
  assert.equal(classifyChildRunIdentity("provider-run"), "provider-receipt");
});

test("lane start and recovery reject internal child identities", () => {
  for (const subagentRunId of [
    "pending:forge-run-2",
    "launch:resolve-1:nonce",
  ]) {
    const state = initialized();
    assert.throws(
      () =>
        applyOrchestrationEvent(
          state,
          next(
            state,
            "lane.started",
            { issueNumber: 2, forgeRunId: "forge-run-2", subagentRunId },
            `start-${subagentRunId}`,
          ),
        ),
      /cannot publish internal child identity/,
    );
  }

  let failed = initialized();
  failed = applyOrchestrationEvent(
    failed,
    next(
      failed,
      "lane.failed",
      { issueNumber: 2, reason: "transient setup failure" },
      "fail-before-recovery",
    ),
  );
  assert.throws(
    () =>
      applyOrchestrationEvent(
        failed,
        next(
          failed,
          "lane.recovered",
          {
            issueNumber: 2,
            forgeRunId: "forge-run-2",
            subagentRunId: "pending:forge-run-2",
          },
          "recover-pending",
        ),
      ),
    /cannot publish internal child identity/,
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
