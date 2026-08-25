import assert from "node:assert/strict";
import test from "node:test";

import {
  checkpointEventType,
  checkpointPayload,
  validatePhaseReport,
  workflowLabelForCheckpoint,
} from "../../src/adapters/checkpoint-service.ts";

test("checkpoint service preserves typed event payloads and workflow labels", () => {
  assert.equal(checkpointEventType("queue"), "phase.queued");
  assert.equal(checkpointEventType("complete"), "phase.completed");
  assert.deepEqual(
    checkpointPayload(
      {
        phase: "implement",
        attempt: 1,
        action: "start",
        logicalNodeId: "builder-1",
      },
      {
        runId: "run-checkpoint",
        issueNumber: 4,
        worktreeRoot: "/repo/worktree",
        branch: "forge/issue-4-run-checkpoint",
        baseSha: "base-sha-123456",
      },
    ),
    {
      phase: "implement",
      attempt: 1,
      logicalNodeId: "builder-1",
      worktreePath: "/repo/worktree",
      branch: "forge/issue-4-run-checkpoint",
      baseSha: "base-sha-123456",
    },
  );
  assert.equal(
    workflowLabelForCheckpoint({ phase: "investigate", action: "start" }),
    "workflow:investigating",
  );
  assert.equal(
    workflowLabelForCheckpoint({
      phase: "investigate",
      action: "complete",
      report: "**Verdict**: INVALID",
    }),
    "workflow:invalid",
  );
});

test("checkpoint report validation remains fail-closed for missing markers", () => {
  assert.throws(
    () => validatePhaseReport("verify", "<!-- FORGE:ACCEPTANCE_GATE -->\n<!-- FORGE:ACCEPTANCE_GATE:PASSED -->"),
    /Acceptance Gate — PASSED/,
  );
  assert.doesNotThrow(() =>
    validatePhaseReport(
      "verify",
      "<!-- FORGE:ACCEPTANCE_GATE -->\n## Acceptance Gate — PASSED\n<!-- FORGE:ACCEPTANCE_GATE:PASSED -->",
    ),
  );
});
