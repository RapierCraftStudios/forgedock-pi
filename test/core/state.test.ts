import assert from "node:assert/strict";
import test from "node:test";

import {
  createRunEvent,
  RUN_PHASES,
  type RunEvent,
  type RunEventType,
  type RunEventPayload,
} from "../../src/core/events.ts";
import { createBuilderPathContract } from "../../src/core/builder-contract.ts";
import { acquireLease, takeoverLease } from "../../src/core/lease.ts";
import {
  applyRunEvent,
  StateTransitionError,
  type RunState,
} from "../../src/core/state.ts";

const repository = "owner/repo";
const runId = "run-1";
const sessionId = "session-1";
const occurredAt = "2026-01-01T00:00:00.000Z";

function nextEvent(
  state: RunState | undefined,
  type: RunEventType,
  payload: RunEventPayload,
  idempotencyKey: string,
  leaseEpoch = state?.lease?.epoch ?? 0,
  session = sessionId,
): RunEvent {
  return createRunEvent({
    runId,
    repository,
    sequence: (state?.sequence ?? 0) + 1,
    previousEventHash: state?.lastEventHash ?? null,
    type,
    actor: { kind: "extension", sessionId: session, leaseEpoch },
    idempotencyKey,
    payload,
    eventId: `event-${(state?.sequence ?? 0) + 1}-${idempotencyKey}`,
    occurredAt,
  });
}

function initializedState(): RunState {
  let state = applyRunEvent(
    undefined,
    nextEvent(
      undefined,
      "run.created",
      {
        issueNumber: 42,
        integrationBranch: "staging",
        protectedBranch: "main",
      },
      "run:create",
    ),
  );
  const lease = acquireLease(undefined, {
    repository,
    owner: { runId, sessionId },
    now: new Date(occurredAt),
    ttlSeconds: 60,
  });
  state = applyRunEvent(
    state,
    nextEvent(state, "lease.acquired", { lease }, "lease:1", 1),
  );
  return state;
}

function completeResolve(state: RunState): RunState {
  let next = applyRunEvent(
    state,
    nextEvent(
      state,
      "phase.queued",
      {
        phase: "resolve",
        attempt: 1,
        restartAction: "revalidate issue and policy",
      },
      "resolve:queue",
    ),
  );
  next = applyRunEvent(
    next,
    nextEvent(
      next,
      "phase.started",
      {
        phase: "resolve",
        attempt: 1,
        logicalNodeId: "resolve-1",
      },
      "resolve:start",
    ),
  );
  return applyRunEvent(
    next,
    nextEvent(
      next,
      "phase.completed",
      {
        phase: "resolve",
        attempt: 1,
        evidence: ["issue exists", "policy valid"],
      },
      "resolve:complete",
    ),
  );
}

test("completed plan nodes persist a hash-bound builder path contract", () => {
  let state = initializedState();
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.queued",
      { nodeId: "plan-1", node: "plan", attempt: 1 },
      "plan-node:queue",
      1,
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.started",
      { nodeId: "plan-1", node: "plan", attempt: 1 },
      "plan-node:start",
      1,
    ),
  );
  const contract = createBuilderPathContract(["src/**", "test/**"]);
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.completed",
      {
        nodeId: "plan-1",
        node: "plan",
        attempt: 1,
        builderContract: contract,
      },
      "plan-node:complete",
      1,
    ),
  );
  assert.deepEqual(state.nodes["plan-1"]?.builderContract, contract);

  const tampered = { ...contract, contractHash: "tampered" };
  let invalid = initializedState();
  invalid = applyRunEvent(
    invalid,
    nextEvent(
      invalid,
      "node.queued",
      { nodeId: "plan-1", node: "plan", attempt: 1 },
      "invalid-plan:queue",
      1,
    ),
  );
  invalid = applyRunEvent(
    invalid,
    nextEvent(
      invalid,
      "node.started",
      { nodeId: "plan-1", node: "plan", attempt: 1 },
      "invalid-plan:start",
      1,
    ),
  );
  assert.throws(
    () =>
      applyRunEvent(
        invalid,
        nextEvent(
          invalid,
          "node.completed",
          {
            nodeId: "plan-1",
            node: "plan",
            attempt: 1,
            builderContract: tampered,
          },
          "invalid-plan:complete",
          1,
        ),
      ),
    (error: unknown) =>
      error instanceof StateTransitionError &&
      error.code === "invalid-builder-contract",
  );
});

test("state reducer enforces ordered phase transitions", () => {
  const state = initializedState();
  assert.throws(
    () =>
      applyRunEvent(
        state,
        nextEvent(
          state,
          "phase.queued",
          {
            phase: "investigate",
            attempt: 1,
            restartAction: "restart investigation",
          },
          "investigate:queue",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError &&
      error.code === "previous-phase-incomplete",
  );
  const resolved = completeResolve(state);
  const investigating = applyRunEvent(
    resolved,
    nextEvent(
      resolved,
      "phase.queued",
      {
        phase: "investigate",
        attempt: 1,
        restartAction: "restart investigation",
      },
      "investigate:queue",
    ),
  );
  assert.equal(investigating.phases.investigate?.attempts[0]?.status, "queued");
});

test("parent-owned node events are durable and independently joinable", () => {
  let state = initializedState();
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.queued",
      {
        nodeId: "review-correctness-1",
        node: "review-correctness",
        attempt: 1,
      },
      "node:correctness:queue",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.started",
      {
        nodeId: "review-correctness-1",
        node: "review-correctness",
        attempt: 1,
        subagentRunId: "child-c",
        baseSha: "base",
      },
      "node:correctness:start",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.resumed",
      {
        nodeId: "review-correctness-1",
        node: "review-correctness",
        attempt: 1,
        previousSubagentRunId: "child-c",
        subagentRunId: "child-c-resumed",
        transportRetries: 1,
        reason: "WebSocket error",
      },
      "node:correctness:resume:1",
    ),
  );
  assert.equal(state.nodes["review-correctness-1"]?.status, "running");
  assert.equal(
    state.nodes["review-correctness-1"]?.subagentRunId,
    "child-c-resumed",
  );
  assert.equal(state.nodes["review-correctness-1"]?.transportRetries, 1);
  assert.equal(state.nodes["review-correctness-1"]?.status, "running");
  assert.equal(
    state.nodes["review-correctness-1"]?.subagentRunId,
    "child-c-resumed",
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "reviewer.artifact-published",
      {
        nodeId: "review-correctness-1",
        node: "review-correctness",
        attempt: 1,
        headSha: "head",
        publishedCommentId: 101,
      },
      "node:correctness:artifact",
    ),
  );
  assert.equal(state.nodes["review-correctness-1"]?.publishedCommentId, 101);
  assert.throws(
    () =>
      applyRunEvent(
        state,
        nextEvent(
          state,
          "node.completed",
          {
            nodeId: "review-correctness-1",
            node: "review-correctness",
            attempt: 1,
          },
          "node:correctness:duplicate",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError &&
      error.code === "illegal-node-transition",
  );
});

test("non-queue node transitions cannot rewrite node identity or attempt", () => {
  let state = initializedState();
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.queued",
      { nodeId: "verify-1", node: "verify", attempt: 1 },
      "verify:queue",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.started",
      { nodeId: "verify-1", node: "verify", attempt: 1 },
      "verify:start",
    ),
  );
  assert.throws(
    () =>
      applyRunEvent(
        state,
        nextEvent(
          state,
          "node.completed",
          { nodeId: "verify-1", node: "plan", attempt: 1 },
          "verify:wrong-node",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError && error.code === "node-mismatch",
  );
  assert.throws(
    () =>
      applyRunEvent(
        state,
        nextEvent(
          state,
          "node.completed",
          { nodeId: "verify-1", node: "verify", attempt: 2 },
          "verify:wrong-attempt",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError && error.code === "attempt-mismatch",
  );
});

test("cleanup node permits terminal completion and post-terminal mutations are rejected", () => {
  let state = initializedState();
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.queued",
      { nodeId: "cleanup-1", node: "cleanup", attempt: 1 },
      "cleanup:queue",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.started",
      { nodeId: "cleanup-1", node: "cleanup", attempt: 1 },
      "cleanup:start",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.completed",
      { nodeId: "cleanup-1", node: "cleanup", attempt: 1, outcome: "closed" },
      "cleanup:complete",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(state, "run.completed", { outcome: "closed" }, "run:complete"),
  );
  assert.equal(state.status, "completed");
  assert.throws(
    () =>
      applyRunEvent(
        state,
        nextEvent(
          state,
          "node.queued",
          { nodeId: "late-1", node: "resolve", attempt: 1 },
          "late:queue",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError && error.code === "terminal-run",
  );
  const epoch = state.lease?.epoch;
  assert.ok(epoch);
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "lease.released",
      { ownerRunId: runId, epoch },
      "lease:release",
      epoch,
    ),
  );
  assert.equal(state.lease, undefined);
});

test("merged completion requires a pull number", () => {
  let state = initializedState();
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.queued",
      { nodeId: "cleanup-1", node: "cleanup", attempt: 1 },
      "cleanup:queue",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.started",
      { nodeId: "cleanup-1", node: "cleanup", attempt: 1 },
      "cleanup:start",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.completed",
      { nodeId: "cleanup-1", node: "cleanup", attempt: 1 },
      "cleanup:complete",
    ),
  );
  assert.throws(
    () =>
      applyRunEvent(
        state,
        nextEvent(
          state,
          "run.completed",
          { outcome: "merged" },
          "run:complete",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError &&
      error.code === "missing-pull-number",
  );
});

test("the immutable final review decision is retained on its decision node", () => {
  let state = initializedState();
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.queued",
      { nodeId: "decision-1", node: "decision", attempt: 1 },
      "decision:queue",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.started",
      { nodeId: "decision-1", node: "decision", attempt: 1 },
      "decision:start",
    ),
  );
  const finalReviewDecision = {
    headSha: "head",
    baseSha: "base",
    decision: "approved" as const,
    blockingFindingIds: [],
    followUpFindingIds: [],
    checkResults: [
      { name: "github:check", required: true, status: "passed" as const },
    ],
    reasons: [],
  };
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.completed",
      {
        nodeId: "decision-1",
        node: "decision",
        attempt: 1,
        headSha: "head",
        baseSha: "base",
        outcome: "awaiting-merge",
        finalReviewDecision,
      },
      "decision:complete",
    ),
  );
  assert.deepEqual(
    state.nodes["decision-1"]?.finalReviewDecision,
    finalReviewDecision,
  );
});

test("resume intent is durable before a provider continuation receipt", () => {
  let state = initializedState();
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.queued",
      { nodeId: "verify-1", node: "verify", attempt: 1 },
      "verify:queue",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.started",
      {
        nodeId: "verify-1",
        node: "verify",
        attempt: 1,
        subagentRunId: "child-old",
      },
      "verify:start",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.resumed",
      {
        nodeId: "verify-1",
        node: "verify",
        attempt: 1,
        previousSubagentRunId: "child-old",
        subagentRunId: "launch:verify-1-resume-1:nonce",
        resultPath: "/tmp/verify-1.json",
        launchNonce: "nonce",
        launchIntent: true,
        transportRetries: 1,
      },
      "verify:resume:intent",
    ),
  );
  assert.equal(
    state.nodes["verify-1"]?.subagentRunId,
    "launch:verify-1-resume-1:nonce",
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.resumed",
      {
        nodeId: "verify-1",
        node: "verify",
        attempt: 1,
        previousSubagentRunId: "launch:verify-1-resume-1:nonce",
        subagentRunId: "child-new",
        resultPath: "/tmp/verify-1.json",
        launchNonce: "nonce",
        launchReceipt: true,
        transportRetries: 1,
      },
      "verify:resume:receipt",
    ),
  );
  assert.equal(state.nodes["verify-1"]?.subagentRunId, "child-new");
  assert.equal(state.nodes["verify-1"]?.transportRetries, 1);
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "node.resumed",
      {
        nodeId: "verify-1",
        node: "verify",
        attempt: 1,
        previousSubagentRunId: "launch:verify-1-resume-1:nonce",
        subagentRunId: "child-new",
        resultPath: "/tmp/verify-1.json",
        launchNonce: "nonce",
        launchReceipt: true,
        transportRetries: 1,
      },
      "verify:resume:receipt:duplicate-callback",
    ),
  );
  assert.equal(state.nodes["verify-1"]?.subagentRunId, "child-new");
});

test("run cancellation durably abandons every active phase and node", () => {
  let state = initializedState();
  state = applyRunEvent(
    state,
    nextEvent(state, "phase.queued", { phase: "resolve", attempt: 1, restartAction: "cancel" }, "resolve:queue"),
  );
  state = applyRunEvent(
    state,
    nextEvent(state, "phase.started", { phase: "resolve", attempt: 1, logicalNodeId: "resolve-1" }, "resolve:start"),
  );
  state = applyRunEvent(
    state,
    nextEvent(state, "node.queued", { nodeId: "resolve-1", node: "resolve", attempt: 1 }, "node:queue"),
  );
  state = applyRunEvent(
    state,
    nextEvent(state, "node.started", { nodeId: "resolve-1", node: "resolve", attempt: 1, subagentRunId: "child-1" }, "node:start"),
  );
  state = applyRunEvent(
    state,
    nextEvent(state, "run.cancelled", { reason: "operator cancelled" }, "run:cancelled"),
  );
  assert.equal(state.status, "cancelled");
  assert.equal(state.cancellationReason, "operator cancelled");
  assert.equal(state.phases.resolve?.attempts[0]?.status, "abandoned");
  assert.equal(state.phases.resolve?.attempts[0]?.reason, "operator cancelled");
  assert.equal(state.nodes["resolve-1"]?.status, "failed");
  assert.equal(state.nodes["resolve-1"]?.reason, "operator cancelled");
});

test("hash chain and idempotency conflicts fail closed", () => {
  const state = initializedState();
  const valid = nextEvent(
    state,
    "phase.queued",
    {
      phase: "resolve",
      attempt: 1,
      restartAction: "retry",
    },
    "resolve:queue",
  );
  assert.throws(
    () => applyRunEvent(state, { ...valid, previousEventHash: "sha256:wrong" }),
    (error) =>
      error instanceof StateTransitionError &&
      error.code === "hash-chain-break",
  );
  const queued = applyRunEvent(state, valid);
  assert.throws(
    () =>
      applyRunEvent(
        queued,
        nextEvent(
          queued,
          "effect.recorded",
          {
            effectType: "github-comment",
            effectId: "comment-1",
            digest: "sha256:digest",
          },
          "resolve:queue",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError &&
      error.code === "duplicate-idempotency-key",
  );
});

test("effect receipts replay idempotently and reject digest conflicts", () => {
  let state = initializedState();
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "effect.recorded",
      {
        effectType: "github-comment",
        effectId: "github-comment:owner/repo:42:event-1",
        digest: "sha256:comment-a",
      },
      "effect:comment-1",
    ),
  );
  const replayed = applyRunEvent(
    state,
    nextEvent(
      state,
      "effect.recorded",
      {
        effectType: "github-comment",
        effectId: "github-comment:owner/repo:42:event-1",
        digest: "sha256:comment-a",
      },
      "effect:comment-replay",
    ),
  );
  assert.equal(replayed.effects["github-comment:owner/repo:42:event-1"]?.digest, "sha256:comment-a");
  assert.throws(
    () =>
      applyRunEvent(
        replayed,
        nextEvent(
          replayed,
          "effect.recorded",
          {
            effectType: "github-comment",
            effectId: "github-comment:owner/repo:42:event-1",
            digest: "sha256:comment-b",
          },
          "effect:comment-conflict",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError &&
      error.code === "effect-digest-conflict",
  );
});

test("terminal runs release their repository lease", () => {
  let state = initializedState();
  for (const phase of RUN_PHASES) {
    state = applyRunEvent(
      state,
      nextEvent(
        state,
        "phase.queued",
        {
          phase,
          attempt: 1,
          restartAction: `retry ${phase}`,
        },
        `${phase}:queue`,
      ),
    );
    state = applyRunEvent(
      state,
      nextEvent(
        state,
        "phase.started",
        {
          phase,
          attempt: 1,
          logicalNodeId: `${phase}-1`,
        },
        `${phase}:start`,
      ),
    );
    state = applyRunEvent(
      state,
      nextEvent(
        state,
        "phase.completed",
        {
          phase,
          attempt: 1,
          evidence: [],
        },
        `${phase}:complete`,
      ),
    );
  }
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "run.completed",
      { outcome: "merged", pullNumber: 42 },
      "run:complete",
    ),
  );
  const epoch = state.lease?.epoch;
  assert.ok(epoch);
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "lease.released",
      { ownerRunId: runId, epoch },
      "lease:release",
      epoch,
    ),
  );
  assert.equal(state.status, "completed");
  assert.equal(state.lease, undefined);
});

test("needs-human retry requires a human-authorized newer lease epoch", () => {
  let state = initializedState();
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "phase.queued",
      {
        phase: "resolve",
        attempt: 1,
        restartAction: "retry",
      },
      "resolve:queue",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "phase.needs-human",
      {
        phase: "resolve",
        attempt: 1,
        reason: "operator decision required",
      },
      "resolve:human",
    ),
  );
  assert.throws(
    () =>
      applyRunEvent(
        state,
        nextEvent(
          state,
          "phase.queued",
          {
            phase: "resolve",
            attempt: 2,
            restartAction: "retry after decision",
          },
          "resolve:retry",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError &&
      error.code === "takeover-required",
  );

  const oldLease = state.lease;
  assert.ok(oldLease);
  const newLease = takeoverLease(oldLease, {
    repository,
    owner: { runId, sessionId: "session-2" },
    now: new Date("2026-01-01T00:02:00.000Z"),
    ttlSeconds: 60,
    authorizedBy: "operator",
  });
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "lease.taken-over",
      { lease: newLease },
      "lease:2",
      2,
      "session-2",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "phase.queued",
      {
        phase: "resolve",
        attempt: 2,
        restartAction: "retry after decision",
      },
      "resolve:retry",
      2,
      "session-2",
    ),
  );
  assert.equal(state.phases.resolve?.attempts.at(-1)?.status, "queued");
  assert.equal(state.status, "active");
});
