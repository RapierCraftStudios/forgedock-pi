import assert from "node:assert/strict";
import test from "node:test";

import type {
  CommitRunStateInput,
  GitHubStateBranchStore,
  ReadRunStateResult,
} from "../../src/adapters/github-state.ts";
import { takeoverLease } from "../../src/core/lease.ts";
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

test("operator takeover re-arms an expired run for adoption", async () => {
  const store = new MemoryRunStore();
  const journal = new RunJournal(store as unknown as GitHubStateBranchStore);
  await journal.initialize({
    runId: "orphan-run",
    repository: "owner/repo",
    issueNumber: 1,
    integrationBranch: "staging",
    protectedBranch: "main",
    sessionId: "dead-session",
    leaseSeconds: 30,
    now: new Date("2020-01-01T00:00:00.000Z"),
  });
  // Real now is far past the 30s TTL: the run reads as orphaned.
  const current = await store.readRun();
  const expiredLease = current.state?.lease;
  assert.ok(expiredLease, "initialized run must carry a scoped lease");

  const newLease = takeoverLease(expiredLease, {
    repository: "owner/repo",
    owner: { runId: "orphan-run", sessionId: "adopter-session" },
    now: new Date(),
    ttlSeconds: 3_600,
    authorizedBy: "operator-directed adoption via session adopter-session",
  });
  await journal.append({
    runId: "orphan-run",
    type: "lease.taken-over",
    payload: { lease: newLease },
    actorLeaseEpoch: newLease.epoch,
    actorKind: "human",
    idempotencyKey: "lease:takeover:2",
    sessionId: "adopter-session",
    message: "Adopt orphaned ForgeDock run orphan-run",
  });

  // Post-takeover work under the re-armed authority succeeds.
  const after = await journal.append({
    runId: "orphan-run",
    type: "phase.queued",
    payload: { phase: "resolve", attempt: 1, restartAction: "resume" },
    idempotencyKey: "resume-queue",
    sessionId: "adopter-session",
    message: "Resume adopted run",
  });
  assert.equal(after.state.phases.resolve?.attempts.at(-1)?.status, "queued");
  assert.equal(after.state.lease?.epoch, 2);
});
