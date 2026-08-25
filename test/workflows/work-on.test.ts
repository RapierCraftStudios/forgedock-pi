import assert from "node:assert/strict";
import test from "node:test";

import {
  findingPriority,
  isTransientProviderFailure,
  lineWithinTolerance,
  parseAsyncCompletion,
  reviewFindingMarker,
  similarFindingTitle,
} from "../../src/workflows/work-on.ts";

test("review-finding metadata follows legacy severity and dedup rules", () => {
  assert.equal(findingPriority("critical"), "priority:P0");
  assert.equal(findingPriority("high"), "priority:P1");
  assert.equal(findingPriority("medium"), "priority:P2");
  assert.equal(findingPriority("low"), "priority:P3");
  assert.equal(
    reviewFindingMarker(6, "SEC-001", "abcdef1"),
    "<!-- FORGE:REVIEW_FINDING source-pr=6 finding=SEC-001 head=abcdef1 -->",
  );
  assert.equal(lineWithinTolerance("**Line**: 105", 100), true);
  assert.equal(lineWithinTolerance("**Line**: 106", 100), false);
  assert.equal(
    similarFindingTitle(
      "fix: fail closed on truncated reviewer input",
      "forge_diff reviewer input truncation does not fail closed",
    ),
    true,
  );
});

test("paused workflow notifications are non-terminal completion events", () => {
  assert.deepEqual(
    parseAsyncCompletion({
      runId: "workflow-1",
      state: "paused",
      success: false,
      error: "Detached for supervisor coordination",
      results: [{ runId: "child-1", status: "paused" }],
    }),
    {
      runId: "workflow-1",
      state: "paused",
      error: "Detached for supervisor coordination",
    },
  );
});

test("detached workflow continuation failure remains distinguishable for durable-result recovery", () => {
  assert.deepEqual(
    parseAsyncCompletion({
      runId: "workflow-detached",
      state: "failed",
      error:
        "unsupported-continuation: detached workflow child settled, but JavaScript workflow continuation was not persisted.",
      reconciledFromDetachedChild: "child-1",
    }),
    {
      runId: "workflow-detached",
      state: "failed",
      error:
        "unsupported-continuation: detached workflow child settled, but JavaScript workflow continuation was not persisted.",
    },
  );
});

test("provider retry classification includes WebSocket failures but excludes quota", () => {
  assert.equal(isTransientProviderFailure("WebSocket error"), true);
  assert.equal(
    isTransientProviderFailure("socket connection was closed unexpectedly"),
    true,
  );
  assert.equal(isTransientProviderFailure("insufficient_quota billing"), false);
});

test("terminal workflow completion is matched only by top-level run ID", () => {
  assert.deepEqual(
    parseAsyncCompletion({
      runId: "workflow-2",
      state: "complete",
      success: true,
      results: [{ runId: "nested-child", status: "completed" }],
    }),
    { runId: "workflow-2", state: "complete" },
  );
  assert.equal(
    parseAsyncCompletion({
      state: "paused",
      results: [{ runId: "nested-child", status: "paused" }],
    }),
    undefined,
  );
});
