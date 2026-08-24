import assert from "node:assert/strict";
import test from "node:test";

import {
  checkpointEventType,
  checkpointPayload,
  validatePhaseReport,
} from "../../src/workflows/checkpoint-service.ts";

test("checkpoint service preserves typed phase event payloads", () => {
  assert.equal(checkpointEventType("queue"), "phase.queued");
  assert.deepEqual(
    checkpointPayload(
      {
        phase: "implement",
        attempt: 1,
        action: "start",
      },
      {
        runId: "run-1",
        issueNumber: 4,
        worktreeRoot: "/worktree",
        branch: "forge/issue-4-run-1",
        baseSha: "abcdef1234567",
      },
    ),
    {
      phase: "implement",
      attempt: 1,
      logicalNodeId: "implement-1",
      worktreePath: "/worktree",
      branch: "forge/issue-4-run-1",
      baseSha: "abcdef1234567",
    },
  );
});

test("checkpoint service enforces canonical completion report markers", () => {
  const report = [
    "<!-- FORGE:ACCEPTANCE_GATE -->",
    "## Acceptance Gate — PASSED",
    "<!-- FORGE:ACCEPTANCE_GATE:PASSED -->",
  ].join("\n");
  assert.doesNotThrow(() => validatePhaseReport("verify", report));
  assert.throws(
    () => validatePhaseReport("verify", "## Acceptance Gate — PASSED"),
    /missing canonical ForgeDock fields/,
  );
});
