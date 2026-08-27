import assert from "node:assert/strict";
import test from "node:test";

import {
  applyReviewEvent,
  createReviewEvent,
  hashReviewEvent,
  replayReviewEvents,
  type ReviewEvent,
  type ReviewEventType,
  type ReviewState,
} from "../../src/core/review-state.ts";

const reviewId = "review-1";
const repository = "owner/repo";
const timestamp = "2026-08-27T00:00:00.000Z";

function next(
  state: ReviewState | undefined,
  type: ReviewEventType,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): ReviewEvent {
  return createReviewEvent({
    reviewId,
    repository,
    sequence: (state?.sequence ?? 0) + 1,
    previousEventHash: state?.lastEventHash ?? null,
    type,
    payload,
    idempotencyKey,
    eventId: `event-${idempotencyKey}`,
    occurredAt: timestamp,
  });
}

function created(): ReviewState {
  return applyReviewEvent(
    undefined,
    next(
      undefined,
      "review.created",
      {
        pullNumber: 9,
        issueNumber: 7,
        mode: "staging",
        headRef: "forge/7",
        headSha: "head-sha",
        baseRef: "staging",
        baseSha: "base-sha",
        roster: { version: "roster-v1", reviewers: ["correctness", "security"] },
        route: "staging-review",
      },
      "create",
    ),
  );
}

test("standalone review replay freezes identity and roster through terminal authorization", () => {
  const events: ReviewEvent[] = [];
  let state = created();
  events.push(next(undefined, "review.created", {
    pullNumber: 9,
    issueNumber: 7,
    mode: "staging",
    headRef: "forge/7",
    headSha: "head-sha",
    baseRef: "staging",
    baseSha: "base-sha",
    roster: { version: "roster-v1", reviewers: ["correctness", "security"] },
    route: "staging-review",
  }, "create"));
  const started = next(state, "review.panel-started", { round: 1 }, "panel-start");
  events.push(started);
  state = applyReviewEvent(state, started);
  const check = next(state, "review.check-recorded", {
    round: 1,
    check: { name: "unit", required: true, status: "passed" },
  }, "check");
  events.push(check);
  state = applyReviewEvent(state, check);
  const findings = next(state, "review.findings-recorded", {
    round: 1,
    findings: [{
      id: "F-1", reviewer: "security", headSha: "head-sha", confidence: "possible",
      severity: "low", category: "security", file: "src/a.ts", line: 1,
      summary: "Consider this", evidence: ["test evidence"],
    }],
  }, "findings");
  events.push(findings);
  state = applyReviewEvent(state, findings);
  const completed = next(state, "review.panel-completed", {
    round: 1, completedReviewers: ["correctness", "security"],
  }, "panel-complete");
  events.push(completed);
  state = applyReviewEvent(state, completed);
  const verdict = next(state, "review.verdict-recorded", {
    round: 1,
    decision: "approved-with-follow-ups", headSha: "head-sha", baseSha: "base-sha",
    reasons: [], blockingFindingIds: [], followUpFindingIds: ["F-1"],
  }, "verdict");
  events.push(verdict);
  state = applyReviewEvent(state, verdict);
  const gate = next(state, "review.gate-recorded", {
    round: 1,
    decision: "approved-with-follow-ups", passed: true, headSha: "head-sha", baseSha: "base-sha", reasons: [],
  }, "gate");
  events.push(gate);
  state = applyReviewEvent(state, gate);
  const authorized = next(state, "review.merge-authorized", {
    round: 1,
    authorized: true, headSha: "head-sha", baseSha: "base-sha", authorizedBy: "controller",
  }, "authorize");
  events.push(authorized);
  state = applyReviewEvent(state, authorized);
  const completion = next(state, "review.completed", {
    round: 1,
    outcome: "merged",
  }, "complete");
  events.push(completion);
  state = applyReviewEvent(state, completion);

  assert.equal(state.status, "completed");
  assert.equal(state.pullRequest, 9);
  assert.equal(state.headRef, "forge/7");
  assert.deepEqual(state.roster.reviewers, ["correctness", "security"]);
  assert.deepEqual(replayReviewEvents(events), state);
  assert.match(hashReviewEvent(authorized), /^sha256:[0-9a-f]{64}$/);
});

test("review-only completion is terminal without merge authorization", () => {
  let state = created();
  state = applyReviewEvent(
    state,
    next(state, "review.panel-started", { round: 1 }, "review-only-start"),
  );
  state = applyReviewEvent(
    state,
    next(
      state,
      "review.findings-recorded",
      { round: 1, findings: [] },
      "review-only-findings",
    ),
  );
  state = applyReviewEvent(
    state,
    next(
      state,
      "review.panel-completed",
      { round: 1, completedReviewers: ["correctness", "security"] },
      "review-only-panel",
    ),
  );
  state = applyReviewEvent(
    state,
    next(
      state,
      "review.verdict-recorded",
      {
        round: 1,
        decision: "approved",
        headSha: "head-sha",
        baseSha: "base-sha",
        reasons: [],
        blockingFindingIds: [],
        followUpFindingIds: [],
      },
      "review-only-verdict",
    ),
  );
  state = applyReviewEvent(
    state,
    next(
      state,
      "review.gate-recorded",
      {
        round: 1,
        decision: "approved",
        passed: true,
        headSha: "head-sha",
        baseSha: "base-sha",
        reasons: [],
      },
      "review-only-gate",
    ),
  );
  state = applyReviewEvent(
    state,
    next(
      state,
      "review.completed",
      { round: 1, outcome: "reviewed" },
      "review-only-complete",
    ),
  );

  assert.equal(state.status, "completed");
  assert.equal(state.mergeAuthorization, undefined);
  assert.equal(state.completion?.outcome, "reviewed");
});

test("review rounds reject stale and late evidence", () => {
  let state = created();
  state = applyReviewEvent(
    state,
    next(state, "review.panel-started", { round: 1 }, "round-1-start"),
  );
  state = applyReviewEvent(
    state,
    next(
      state,
      "review.findings-recorded",
      { round: 1, findings: [] },
      "round-1-findings",
    ),
  );
  state = applyReviewEvent(
    state,
    next(
      state,
      "review.panel-completed",
      { round: 1, completedReviewers: ["correctness", "security"] },
      "round-1-complete",
    ),
  );
  assert.throws(
    () =>
      applyReviewEvent(
        state,
        next(
          state,
          "review.check-recorded",
          {
            round: 1,
            check: { name: "late", required: true, status: "passed" },
          },
          "late-check",
        ),
      ),
    /cannot change after panel completion/i,
  );
  state = applyReviewEvent(
    state,
    next(state, "review.panel-started", { round: 2 }, "round-2-start"),
  );
  assert.deepEqual(state.findings, []);
  assert.throws(
    () =>
      applyReviewEvent(
        state,
        next(
          state,
          "review.check-recorded",
          {
            round: 1,
            check: { name: "stale", required: true, status: "passed" },
          },
          "stale-check",
        ),
      ),
    /panel round 2/i,
  );
});

test("review cancellation is terminal", () => {
  let state = created();
  state = applyReviewEvent(
    state,
    next(
      state,
      "review.cancelled",
      { reason: "operator cancelled" },
      "cancel",
    ),
  );
  assert.equal(state.status, "cancelled");
  assert.throws(
    () =>
      applyReviewEvent(
        state,
        next(state, "review.panel-started", { round: 1 }, "after-cancel"),
      ),
    /cancelled review/i,
  );
});

test("review replay rejects stale evidence, broken hash chains, and duplicate idempotency", () => {
  const initial = created();
  const started = next(initial, "review.panel-started", { round: 1 }, "panel-start");
  const state = applyReviewEvent(initial, started);
  assert.throws(() => applyReviewEvent(state, {
    ...next(state, "review.check-recorded", { round: 1, check: { name: "unit", required: true, status: "passed" } }, "check"),
    payload: { round: 1, check: { name: "unit", required: true, status: "passed" } },
    previousEventHash: "sha256:wrong",
  }), /hash chain/i);
  assert.throws(() => applyReviewEvent(state, next(state, "review.findings-recorded", {
    round: 1,
    findings: [{ id: "F", reviewer: "security", headSha: "other", confidence: "possible", severity: "low", category: "security", file: "a", line: 1, summary: "x", evidence: [] }],
  }, "bad-findings")), /frozen review head/i);
  const duplicate = { ...started, sequence: state.sequence + 1, previousEventHash: state.lastEventHash };
  assert.throws(() => applyReviewEvent(state, duplicate), /idempotency|duplicate|already applied/i);
});
