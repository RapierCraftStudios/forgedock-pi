import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalReviewerName,
  directRunRecoveryAction,
  finalReviewDecisionMarker,
  findingPriority,
  isTransientProviderFailure,
  lineWithinTolerance,
  parentNodeFromId,
  parseAsyncCompletion,
  reconcileLaunchState,
  reviewFindingMarker,
  reviewInstanceMarker,
  reviewSummaryInstanceMarker,
  reviewSupersessionMarker,
  shouldBufferLaunchCompletion,
  similarFindingTitle,
  workflowLabelForNode,
  workflowStageForNodeTransition,
} from "../../src/workflows/work-on.ts";

test("short reviewer aliases normalize to configured agent names", () => {
  assert.equal(canonicalReviewerName("security"), "forge-review-security");
  assert.equal(
    canonicalReviewerName("forge-review-correctness"),
    "forge-review-correctness",
  );
});

test("restart recovery recognizes every parent-owned durable node", () => {
  for (const node of ["review-join", "ci", "decision", "merge", "close", "cleanup"] as const)
    assert.equal(parentNodeFromId(`${node}-2`), node);
  assert.equal(parentNodeFromId("implement-1"), undefined);
});

test("direct restart selects terminal cleanup and authority release windows", () => {
  const state = (
    status: "active" | "completed" | "blocked",
    completedPhases: readonly string[] = [],
  ) =>
    ({
      status,
      phases: Object.fromEntries(
        completedPhases.map((phase) => [
          phase,
          { attempts: [{ status: "completed" }] },
        ]),
      ),
    }) as unknown as import("../../src/core/state.ts").RunState;

  assert.equal(
    directRunRecoveryAction(state("active", ["merge", "close"]), true),
    "terminal-cleanup",
  );
  assert.equal(
    directRunRecoveryAction(state("completed", ["cleanup"]), true),
    "release-authority",
  );
  assert.equal(
    directRunRecoveryAction(state("active", ["verify"]), true),
    "resume-work",
  );
  assert.equal(
    directRunRecoveryAction(state("active", ["merge", "close"]), false),
    "none",
  );
  assert.equal(
    directRunRecoveryAction(state("blocked", ["merge", "close"]), true),
    "none",
  );
});

test("provider completion is buffered until its launch receipt is durably bound", () => {
  assert.equal(shouldBufferLaunchCompletion(true, true), true);
  assert.equal(shouldBufferLaunchCompletion(false, false), true);
  assert.equal(shouldBufferLaunchCompletion(false, true), false);
});

test("workflow transitions cover the complete canonical label lifecycle", () => {
  assert.equal(
    workflowStageForNodeTransition("resolve", "started"),
    "investigation",
  );
  assert.equal(
    workflowStageForNodeTransition("investigate", "completed", "confirmed"),
    "readyToBuild",
  );
  for (const node of [
    "plan",
    "prepare-worktree",
    "implement",
    "verify",
  ] as const)
    assert.equal(workflowStageForNodeTransition(node, "started"), "build");
  for (const node of [
    "prepare-pr",
    "review-correctness",
    "review-security",
    "review-join",
    "ci",
  ] as const)
    assert.equal(workflowStageForNodeTransition(node, "started"), "review");
  assert.equal(
    workflowLabelForNode("decision", "awaiting-merge"),
    "workflow:awaiting-merge",
  );
  assert.equal(
    workflowLabelForNode("decision", "remediation-required"),
    "workflow:building",
  );
  assert.equal(workflowLabelForNode("merge", "merged"), "workflow:merged");
  assert.equal(
    workflowLabelForNode("investigate", "invalid"),
    "workflow:invalid",
  );
  assert.equal(
    workflowLabelForNode("close", "closed", "invalid"),
    "workflow:invalid",
  );
  assert.equal(
    workflowLabelForNode("cleanup", "closed", "decomposed"),
    "workflow:decomposed",
  );
});

test("normal matching provider receipts are inspected instead of escalated", () => {
  assert.equal(
    reconcileLaunchState({
      durableStatus: "running",
      durableRunId: "child-1",
      activeRunId: "child-1",
      resultArtifactPresent: false,
    }),
    "inspect-active",
  );
  assert.equal(
    reconcileLaunchState({
      durableStatus: "running",
      durableRunId: "launch:resolve-1:nonce",
      activeRunId: "launch:resolve-1:nonce",
      resultArtifactPresent: false,
    }),
    "needs-human",
  );
  assert.equal(
    reconcileLaunchState({
      durableStatus: "queued",
      activeRunId: "launch:resolve-1:nonce",
      resultArtifactPresent: false,
    }),
    "needs-human",
  );
});

test("final review decisions have one run-round-head identity", () => {
  assert.equal(
    finalReviewDecisionMarker("run-1", 2, "abcdef1234567890"),
    "<!-- FORGE:FINAL-REVIEW-DECISION run=run-1 round=2 head=abcdef1234567890 -->",
  );
});

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

test("review instance markers bind run, domain, round, and full head", () => {
  assert.equal(
    reviewInstanceMarker("run-1", "security", 2, "abcdef1234567890"),
    "<!-- FORGE:REVIEW-INSTANCE run=run-1 domain=security round=2 head=abcdef1234567890 -->",
  );
});

test("joined review summary identity is round and head specific", () => {
  assert.equal(
    reviewSummaryInstanceMarker("run-1", 2, "abcdef1234567890"),
    "<!-- FORGE:REVIEW-SUMMARY-INSTANCE run=run-1 round=2 head=abcdef1234567890 -->",
  );
});

test("new review rounds have explicit supersession identities", () => {
  assert.equal(
    reviewSupersessionMarker("run-1", "security", 2, "new-head"),
    "<!-- FORGE:REVIEW-SUPERSESSION run=run-1 domain=security round=2 head=new-head -->",
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
