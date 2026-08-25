import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalReviewerName,
  expectedHeadForNode,
  finalReviewDecisionMarker,
  findingPriority,
  isProviderSubagentRunId,
  isTransientProviderFailure,
  launchReceiptIdempotencyKey,
  lineWithinTolerance,
  parentNodeFromId,
  parseAsyncCompletion,
  pendingInitializationRecoveryAction,
  reconcileLaunchState,
  reviewFindingMarker,
  reviewInstanceMarker,
  reviewSummaryInstanceMarker,
  reviewSupersessionMarker,
  shouldBufferLaunchCompletion,
  similarFindingTitle,
  workflowLabelForNode,
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

test("legacy verify nodes derive their trusted head from implementation", () => {
  const state = {
    nodes: {
      "implement-1": {
        nodeId: "implement-1",
        node: "implement",
        attempt: 1,
        status: "completed",
        headSha: "implementation-head",
      },
    },
  } as unknown as Parameters<typeof expectedHeadForNode>[0];
  assert.equal(
    expectedHeadForNode(state, {
      node: "verify",
      attempt: 1,
    }),
    "implementation-head",
  );
});

test("provider completion is buffered until its launch receipt is durably bound", () => {
  assert.equal(shouldBufferLaunchCompletion(true, true), true);
  assert.equal(shouldBufferLaunchCompletion(false, false), true);
  assert.equal(shouldBufferLaunchCompletion(false, true), false);
});

test("bounded parent nodes project every terminal workflow label", () => {
  assert.equal(workflowLabelForNode("decision", "awaiting-merge"), "workflow:awaiting-merge");
  assert.equal(workflowLabelForNode("decision", "remediation-required"), "workflow:in-review");
  assert.equal(workflowLabelForNode("merge", "merged"), "workflow:merged");
  assert.equal(workflowLabelForNode("close", "closed", "invalid"), "workflow:invalid");
  assert.equal(workflowLabelForNode("cleanup", "closed", "decomposed"), "workflow:decomposed");
});

test("internal sentinels are never eligible for provider RPCs", () => {
  assert.equal(isProviderSubagentRunId("child-1"), true);
  assert.equal(isProviderSubagentRunId("pending:forge-run-1"), false);
  assert.equal(isProviderSubagentRunId("launch:resolve-1:nonce"), false);
  assert.equal(isProviderSubagentRunId(""), false);
});

test("only the empty pre-resolve pending window is redispatched", () => {
  const recoverable = {
    forgeRunId: "forge-run-1",
    subagentRunId: "pending:forge-run-1",
    currentNodeId: "resolve-1",
    activeNodeCount: 0,
    durableNodeIds: [] as string[],
  };
  assert.equal(
    pendingInitializationRecoveryAction(recoverable),
    "dispatch-resolve",
  );
  assert.equal(
    pendingInitializationRecoveryAction({
      ...recoverable,
      durableNodeIds: ["resolve-1"],
    }),
    "needs-human",
  );
  assert.equal(
    pendingInitializationRecoveryAction({
      ...recoverable,
      currentNodeId: "plan-1",
    }),
    "needs-human",
  );
});

test("all receipt bind paths share one provider receipt identity", () => {
  const receipt = {
    nodeId: "resolve-1",
    attempt: 1,
    launchNonce: "nonce-1",
    providerRunId: "child-1",
  };
  const key = launchReceiptIdempotencyKey(receipt);
  assert.equal(launchReceiptIdempotencyKey({ ...receipt }), key);
  assert.notEqual(
    launchReceiptIdempotencyKey({ ...receipt, providerRunId: "child-2" }),
    key,
  );
  assert.throws(
    () =>
      launchReceiptIdempotencyKey({
        ...receipt,
        providerRunId: "launch:resolve-1:nonce-1",
      }),
    /provider run ID/,
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
