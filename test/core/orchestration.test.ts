import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOrchestrationEvent,
  createOrchestrationEvent,
  type OrchestrationEventType,
  type OrchestrationState,
} from "../../src/core/orchestration.ts";

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
