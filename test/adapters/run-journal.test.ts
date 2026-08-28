import assert from "node:assert/strict";
import test from "node:test";

import type {
  CommitRunStateInput,
  GitHubStateBranchStore,
  ReadRunStateResult,
} from "../../src/adapters/github-state.ts";
import { RunJournal } from "../../src/adapters/run-journal.ts";

class MemoryRunStore {
  #snapshot: ReadRunStateResult = {
    tip: "tip-0",
    events: [],
    snapshotMatchesJournal: true,
  };

  async ensureBranch(): Promise<void> {}

  async readRun(): Promise<ReadRunStateResult> {
    return this.#snapshot;
  }

  async commitRunState(input: CommitRunStateInput): Promise<string> {
    this.#snapshot = {
      tip: `tip-${input.events.length}`,
      events: input.events,
      state: input.state,
      snapshotMatchesJournal: true,
      ...(input.lease ? { lease: input.lease } : {}),
    };
    return this.#snapshot.tip;
  }
}

test("run.cancelled survives run-scoped lease expiry; other appends reject", async () => {
  const store = new MemoryRunStore();
  const journal = new RunJournal(store as unknown as GitHubStateBranchStore);
  const initialized = await journal.initialize({
    runId: "expired-run",
    repository: "owner/repo",
    issueNumber: 1,
    integrationBranch: "staging",
    protectedBranch: "main",
    sessionId: "session-1",
    leaseSeconds: 30,
    now: new Date("2020-01-01T00:00:00.000Z"),
  });
  assert.equal(initialized.state.authorityMode, "run-scoped");

  // Cancellation is safety-positive and must never be blocked by expiry.
  const cancelled = await journal.append({
    runId: "expired-run",
    type: "run.cancelled",
    payload: { reason: "operator stop after expiry" },
    idempotencyKey: "cancel",
    sessionId: "session-1",
    message: "Cancel expired test run",
  });
  assert.equal(cancelled.state.status, "cancelled");

  // Ordinary mutations on an expired run still fail closed.
  await assert.rejects(
    journal.append({
      runId: "expired-run-2",
      type: "phase.queued",
      payload: { phase: "resolve", attempt: 1, restartAction: "retry" },
      idempotencyKey: "late-queue",
      sessionId: "session-1",
      message: "Late append",
    }),
    /expired|no longer owns|does not exist/i,
  );
});
