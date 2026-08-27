import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOrchestrationEvent,
  blockedOrchestrationLanes,
  createOrchestrationEvent,
  isTerminalLane,
  nextIntegrationLane,
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

test("dependency graph gates dispatch and integration topologically", () => {
  let state = applyOrchestrationEvent(
    undefined,
    next(
      undefined,
      "orchestration.created",
      {
        issueNumbers: [1, 2],
        integrationBranch: "staging",
        maxConcurrent: 2,
        leaseEpoch: 1,
        dependencies: [
          { fromIssue: 1, toIssue: 2, kind: "explicit", reason: "#2 needs #1" },
        ],
      },
      "dependency-create",
    ),
  );
  assert.deepEqual(
    readyOrchestrationLanes(state).map((lane) => lane.issueNumber),
    [1],
  );
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.started",
      { issueNumber: 1, forgeRunId: "run-1", subagentRunId: "child-1" },
      "dependency-start-1",
    ),
  );
  assert.deepEqual(readyOrchestrationLanes(state), []);
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.ready",
      { issueNumber: 1, headSha: "head-1", baseSha: "base-1" },
      "dependency-ready-1",
    ),
  );
  assert.equal(nextIntegrationLane(state)?.issueNumber, 1);
  state = applyOrchestrationEvent(
    state,
    next(state, "lane.integrating", { issueNumber: 1 }, "dependency-integrating-1"),
  );
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.merged",
      { issueNumber: 1, pullNumber: 11, headSha: "head-1" },
      "dependency-merged-1",
    ),
  );
  assert.equal(nextIntegrationLane(state), undefined);
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.started",
      { issueNumber: 2, forgeRunId: "run-2", subagentRunId: "child-2" },
      "dependency-start-2",
    ),
  );
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.ready",
      { issueNumber: 2, headSha: "head-2", baseSha: "base-2" },
      "dependency-ready-2",
    ),
  );
  assert.equal(nextIntegrationLane(state)?.issueNumber, 2);
});

test("queued dependents receive deterministic blocker evidence", () => {
  let state = applyOrchestrationEvent(
    undefined,
    next(
      undefined,
      "orchestration.created",
      {
        issueNumbers: [3, 1, 2],
        integrationBranch: "staging",
        maxConcurrent: 3,
        leaseEpoch: 1,
        dependencies: [
          { fromIssue: 1, toIssue: 3, kind: "explicit", reason: "#3 needs #1" },
          { fromIssue: 2, toIssue: 3, kind: "explicit", reason: "#3 needs #2" },
        ],
      },
      "blocked-dependent-create",
    ),
  );
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.failed",
      { issueNumber: 2, reason: "implementation failed" },
      "blocked-dependent-fail",
    ),
  );
  assert.deepEqual(
    blockedOrchestrationLanes(state).map(({ lane, blockedBy, reason }) => ({
      issueNumber: lane.issueNumber,
      blockedBy: blockedBy.issueNumber,
      reason,
    })),
    [
      {
        issueNumber: 3,
        blockedBy: 2,
        reason: "Issue #3 cannot start because dependency #2 is failed: implementation failed",
      },
    ],
  );
  state = applyOrchestrationEvent(
    state,
    next(
      state,
      "lane.blocked",
      {
        issueNumber: 3,
        reason: "Issue #3 cannot start because dependency #2 is failed: implementation failed",
      },
      "blocked-dependent-block",
    ),
  );
  assert.deepEqual(blockedOrchestrationLanes(state), []);
});

test("terminal dependency propagation reaches transitive queued dependents", () => {
  let state = applyOrchestrationEvent(
    undefined,
    next(
      undefined,
      "orchestration.created",
      {
        issueNumbers: [4, 3, 2, 1],
        integrationBranch: "staging",
        maxConcurrent: 4,
        leaseEpoch: 1,
        dependencies: [
          { fromIssue: 1, toIssue: 2, kind: "explicit", reason: "#2 needs #1" },
          { fromIssue: 2, toIssue: 3, kind: "explicit", reason: "#3 needs #2" },
          { fromIssue: 3, toIssue: 4, kind: "explicit", reason: "#4 needs #3" },
        ],
      },
      "transitive-dependent-create",
    ),
  );
  state = applyOrchestrationEvent(
    state,
    next(state, "lane.failed", { issueNumber: 1, reason: "root failed" }, "transitive-fail-1"),
  );
  for (const [issueNumber, blockerIssueNumber] of [
    [2, 1],
    [3, 2],
    [4, 3],
  ] as const) {
    const blocked = blockedOrchestrationLanes(state);
    assert.deepEqual(
      blocked.map(({ lane, blockedBy }) => [lane.issueNumber, blockedBy.issueNumber]),
      [[issueNumber, blockerIssueNumber]],
    );
    state = applyOrchestrationEvent(
      state,
      next(
        state,
        "lane.blocked",
        {
          issueNumber,
          reason: blocked[0]?.reason ?? "dependency failed",
        },
        `transitive-block-${issueNumber}`,
      ),
    );
  }
  assert.equal(state.lanes.every(isTerminalLane), true);
});

test("genesis rejects cycles and binds the persisted graph hash", () => {
  const event = next(
    undefined,
    "orchestration.created",
    {
      issueNumbers: [1, 2],
      integrationBranch: "staging",
      maxConcurrent: 2,
      leaseEpoch: 1,
      dependencies: [
        { fromIssue: 1, toIssue: 2, kind: "explicit", reason: "cycle" },
        { fromIssue: 2, toIssue: 1, kind: "explicit", reason: "cycle" },
      ],
    },
    "cycle-create",
  );
  assert.throws(
    () => applyOrchestrationEvent(undefined, event),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "dependency-cycle",
  );

  let state = initialized();
  const tampered = { ...state, graphHash: "sha256:tampered" };
  assert.throws(
    () =>
      applyOrchestrationEvent(
        tampered,
        next(tampered, "lease.heartbeat", { epoch: 1 }, "tampered-heartbeat"),
      ),
    (error) =>
      error instanceof Error && "code" in error && error.code === "graph-integrity",
  );
});

test("a 25-issue objective is not truncated by the ready queue", () => {
  const state = applyOrchestrationEvent(
    undefined,
    next(
      undefined,
      "orchestration.created",
      {
        issueNumbers: Array.from({ length: 25 }, (_, index) => index + 1),
        integrationBranch: "staging",
        maxConcurrent: 16,
        leaseEpoch: 1,
      },
      "twenty-five-create",
    ),
  );
  assert.equal(readyOrchestrationLanes(state).length, 16);
  assert.equal(readyOrchestrationLanes(state)[15]?.issueNumber, 16);
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
