import assert from "node:assert/strict";
import test from "node:test";

import {
  createRunEvent,
  RUN_PHASES,
  type RunEvent,
  type RunEventType,
  type RunEventPayload,
} from "../../src/core/events.ts";
import { acquireLease, takeoverLease } from "../../src/core/lease.ts";
import { hashBuilderContract } from "../../src/core/builder-contract.ts";
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

test("terminal runs release their repository lease", () => {
  const builderContract = {
    schema: "forgedock.builder-contract/v1" as const,
    revision: 1,
    allowedPaths: [{ kind: "exact" as const, path: "src/core/state.ts" }],
  };
  const contractHash = hashBuilderContract(builderContract);
  let state = initializedState();
  for (const phase of RUN_PHASES) {
    const contractBinding =
      phase === "implement" || phase === "verify" || phase === "review"
        ? { contractHash, contractRevision: 1 }
        : {};
    state = applyRunEvent(
      state,
      nextEvent(
        state,
        "phase.queued",
        {
          phase,
          attempt: 1,
          restartAction: `retry ${phase}`,
          ...contractBinding,
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
          ...contractBinding,
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
          ...contractBinding,
          ...(phase === "plan"
            ? { builderContract, contractHash, contractRevision: 1 }
            : {}),
        },
        `${phase}:complete`,
      ),
    );
  }
  state = applyRunEvent(
    state,
    nextEvent(state, "run.completed", { outcome: "merged" }, "run:complete"),
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

test("accepted builder contracts bind implementation and review checkpoints", () => {
  const builderContract = {
    schema: "forgedock.builder-contract/v1" as const,
    revision: 1,
    allowedPaths: [{ kind: "exact" as const, path: "src/core/state.ts" }],
  };
  const contractHash = hashBuilderContract(builderContract);
  let state = completeResolve(initializedState());
  for (const phase of ["investigate", "plan"] as const) {
    state = applyRunEvent(
      state,
      nextEvent(
        state,
        "phase.queued",
        { phase, attempt: 1, restartAction: `run ${phase}` },
        `${phase}:queue`,
      ),
    );
    state = applyRunEvent(
      state,
      nextEvent(
        state,
        "phase.started",
        { phase, attempt: 1, logicalNodeId: `${phase}-1` },
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
          ...(phase === "plan"
            ? {
                contractHash,
                contractRevision: 1,
                builderContract,
              }
            : {}),
        },
        `${phase}:complete`,
      ),
    );
  }
  assert.equal(state.builderContract?.contractHash, contractHash);
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "phase.queued",
      {
        phase: "prepare-worktree",
        attempt: 1,
        restartAction: "prepare",
      },
      "prepare:queue",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "phase.started",
      { phase: "prepare-worktree", attempt: 1, logicalNodeId: "prepare-1" },
      "prepare:start",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "phase.completed",
      { phase: "prepare-worktree", attempt: 1, evidence: [] },
      "prepare:complete",
    ),
  );
  assert.throws(
    () =>
      applyRunEvent(
        state,
        nextEvent(
          state,
          "phase.queued",
          { phase: "implement", attempt: 1, restartAction: "implement" },
          "implement:queue",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError &&
      error.code === "contract-hash-mismatch",
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "phase.queued",
      {
        phase: "implement",
        attempt: 1,
        restartAction: "implement",
        contractHash,
        contractRevision: 1,
      },
      "implement:queue",
    ),
  );
  state = applyRunEvent(
    state,
    nextEvent(
      state,
      "phase.started",
      {
        phase: "implement",
        attempt: 1,
        logicalNodeId: "implement-1",
        contractHash,
        contractRevision: 1,
      },
      "implement:start",
    ),
  );
  assert.throws(
    () =>
      applyRunEvent(
        state,
        nextEvent(
          state,
          "phase.completed",
          {
            phase: "implement",
            attempt: 1,
            evidence: [],
            contractHash: "sha256:wrong",
            contractRevision: 1,
          },
          "implement:complete",
        ),
      ),
    (error) =>
      error instanceof StateTransitionError &&
      error.code === "contract-hash-mismatch",
  );
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
