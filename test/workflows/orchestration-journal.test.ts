import assert from "node:assert/strict";
import test from "node:test";

import {
  StateBranchConflictError,
  type CommitOrchestrationStateInput,
  type GitHubStateBranchStore,
  type ReadOrchestrationStateResult,
} from "../../src/adapters/github-state.ts";
import { type OrchestrationState } from "../../src/core/orchestration.ts";
import { OrchestrationJournal } from "../../src/workflows/orchestration-journal.ts";

class MemoryOrchestrationStore {
  #snapshot: ReadOrchestrationStateResult = {
    tip: "tip-0",
    events: [],
    snapshotMatchesJournal: true,
  };
  #conflictNextCommit = false;

  armConflict(): void {
    this.#conflictNextCommit = true;
  }

  async ensureBranch(): Promise<void> {}

  async readOrchestration(): Promise<ReadOrchestrationStateResult> {
    return this.#snapshot;
  }

  async listOrchestrations(): Promise<Array<{ orchestrationId: string; state?: OrchestrationState }>> {
    return this.#snapshot.state ? [{ orchestrationId: this.#snapshot.state.orchestrationId, state: this.#snapshot.state }] : [];
  }

  async getTip(): Promise<string> {
    return this.#snapshot.tip;
  }

  async commitOrchestrationState(input: CommitOrchestrationStateInput): Promise<string> {
    if (this.#conflictNextCommit) {
      this.#conflictNextCommit = false;
      throw new StateBranchConflictError(input.expectedTip);
    }
    this.#snapshot = {
      tip: `tip-${input.events.length}`,
      events: input.events,
      state: input.state,
      snapshotMatchesJournal: true,
    };
    return this.#snapshot.tip;
  }
}

function laneInput() {
  return {
    kind: "work-order" as const,
    stableId: "wo-325",
    slug: "branch binding",
    branch: "work-order/wo-325-branch-binding",
    repository: "owner/repo",
    frozenBase: { branch: "main", sha: "0123456789abcdef0123456789abcdef01234567" },
    membership: [{ issueNumber: 2, ordinal: 0 }],
    sourceQuery: "#325",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    status: "queued" as const,
  };
}

function promotionLaneInput() {
  return {
    ...laneInput(),
    branch: "work-order/wo-325-branch-binding",
    status: "active" as const,
  };
}

test("journal rejects a typed work-order lane whose branch differs from integrationBranch", async () => {
  const store = new MemoryOrchestrationStore();
  const journal = new OrchestrationJournal(store as unknown as GitHubStateBranchStore);

  await assert.rejects(
    journal.initialize({
      orchestrationId: "orchestration-325",
      repository: "owner/repo",
      issueNumbers: [2],
      integrationBranch: "staging",
      maxConcurrent: 1,
      lane: laneInput(),
      now: new Date("2026-08-24T00:00:00.000Z"),
    }),
    /branch/i,
  );
  assert.equal((await store.readOrchestration()).events.length, 0);
});

test("promotion CAS retries reacquire provider evidence instead of replaying stale state", async () => {
  const store = new MemoryOrchestrationStore();
  const journal = new OrchestrationJournal(store as unknown as GitHubStateBranchStore);
  await journal.initialize({
    orchestrationId: "orchestration-promotion",
    repository: "owner/repo",
    issueNumbers: [2],
    integrationBranch: "work-order/wo-325-branch-binding",
    maxConcurrent: 1,
    lane: promotionLaneInput(),
    now: new Date("2026-08-24T00:00:00.000Z"),
  });
  await journal.queueLane({ orchestrationId: "orchestration-promotion", laneId: "wo-325" });
  await journal.acquireLaneQueueLease({ orchestrationId: "orchestration-promotion", laneId: "wo-325", ownerId: "owner", leaseSeconds: 60 });
  const staging = { branch: "staging", sha: "a".repeat(40), baselineSha: "a".repeat(40), idle: true, checkedAt: "2026-08-24T00:00:03.000Z" };
  await journal.syncLane({ orchestrationId: "orchestration-promotion", laneId: "wo-325", ownerId: "owner", leaseEpoch: 1, staging });
  store.armConflict();
  let evidenceReads = 0;
  const promoted = await journal.promoteLane({
    orchestrationId: "orchestration-promotion",
    laneId: "wo-325",
    ownerId: "owner",
    queueHeadLaneId: "wo-325",
    leaseEpoch: 1,
    staging,
    stagingReadbackSha: "c".repeat(40),
    receipt: { shippingPullNumber: 44, sourceHeadSha: "b".repeat(40), stagingBaseSha: staging.sha, mergeBaseSha: staging.sha, mergeCommitSha: "c".repeat(40), mergeMethod: "merge", reviewedAt: staging.checkedAt },
    reviewPassed: true,
    verificationPassed: true,
    mergeable: true,
    authorityValid: true,
    mergeCommit: true,
    readPromotionEvidence: async () => {
      evidenceReads += 1;
      return { ownerId: "owner", queueHeadLaneId: "wo-325", leaseEpoch: 1, staging, stagingReadbackSha: "c".repeat(40) };
    },
  });
  assert.equal(promoted.integrationLane?.status, "promoted");
  assert.equal(evidenceReads, 2);
  const replayed = await journal.promoteLane({
    orchestrationId: "orchestration-promotion",
    laneId: "wo-325",
    ownerId: "owner",
    queueHeadLaneId: "wo-325",
    leaseEpoch: 1,
    staging,
    stagingReadbackSha: "c".repeat(40),
    receipt: { shippingPullNumber: 44, sourceHeadSha: "b".repeat(40), stagingBaseSha: staging.sha, mergeBaseSha: staging.sha, mergeCommitSha: "c".repeat(40), mergeMethod: "merge", reviewedAt: staging.checkedAt },
    reviewPassed: true,
    verificationPassed: true,
    mergeable: true,
    authorityValid: true,
    mergeCommit: true,
    readPromotionEvidence: async () => {
      throw new Error("a consumed lease must not be reacquired during idempotent replay");
    },
  });
  assert.equal(replayed.integrationLane?.status, "promoted");
});

test("fresh provider staging ownership evidence aborts stale lease epoch retry after CAS movement", async () => {
  const store = new MemoryOrchestrationStore();
  const journal = new OrchestrationJournal(store as unknown as GitHubStateBranchStore);
  await journal.initialize({ orchestrationId: "orchestration-provider", repository: "owner/repo", issueNumbers: [2], integrationBranch: "work-order/wo-325-branch-binding", maxConcurrent: 1, lane: promotionLaneInput(), now: new Date("2026-08-24T00:00:00.000Z") });
  await journal.queueLane({ orchestrationId: "orchestration-provider", laneId: "wo-325" });
  await journal.acquireLaneQueueLease({ orchestrationId: "orchestration-provider", laneId: "wo-325", ownerId: "owner", leaseSeconds: 60 });
  const staging = { branch: "staging", sha: "a".repeat(40), baselineSha: "a".repeat(40), idle: true, checkedAt: "2026-08-24T00:00:03.000Z" };
  await journal.syncLane({ orchestrationId: "orchestration-provider", laneId: "wo-325", ownerId: "owner", leaseEpoch: 1, staging });
  store.armConflict();
  let evidenceReads = 0;
  await assert.rejects(
    journal.promoteLane({
      orchestrationId: "orchestration-provider", laneId: "wo-325", ownerId: "owner", queueHeadLaneId: "wo-325", leaseEpoch: 1,
      staging, stagingReadbackSha: "c".repeat(40),
      receipt: { shippingPullNumber: 44, sourceHeadSha: "b".repeat(40), stagingBaseSha: staging.sha, mergeBaseSha: staging.sha, mergeCommitSha: "c".repeat(40), mergeMethod: "merge", reviewedAt: staging.checkedAt },
      reviewPassed: true, verificationPassed: true, mergeable: true, authorityValid: true, mergeCommit: true,
      readPromotionEvidence: async () => {
        evidenceReads += 1;
        return { ownerId: evidenceReads === 1 ? "owner" : "new-owner", queueHeadLaneId: "wo-325", leaseEpoch: evidenceReads === 1 ? 1 : 2, staging: evidenceReads === 1 ? staging : { ...staging, ownedByAnotherLane: true }, stagingReadbackSha: "c".repeat(40) };
      },
    }),
    /original queue owner, head, or lease epoch/i,
  );
  assert.equal(evidenceReads, 2);
});

test("promotion replay is idempotent after its queue lease is consumed", async () => {
  const store = new MemoryOrchestrationStore();
  const journal = new OrchestrationJournal(store as unknown as GitHubStateBranchStore);
  await journal.initialize({
    orchestrationId: "orchestration-replay",
    repository: "owner/repo",
    issueNumbers: [2],
    integrationBranch: "work-order/wo-325-branch-binding",
    maxConcurrent: 1,
    lane: promotionLaneInput(),
    now: new Date("2026-08-24T00:00:00.000Z"),
  });
  await journal.queueLane({ orchestrationId: "orchestration-replay", laneId: "wo-325" });
  await journal.acquireLaneQueueLease({ orchestrationId: "orchestration-replay", laneId: "wo-325", ownerId: "owner", leaseSeconds: 60 });
  const staging = { branch: "staging", sha: "a".repeat(40), baselineSha: "a".repeat(40), idle: true, checkedAt: "2026-08-24T00:00:03.000Z" };
  await journal.syncLane({ orchestrationId: "orchestration-replay", laneId: "wo-325", ownerId: "owner", leaseEpoch: 1, staging });
  const input = {
    orchestrationId: "orchestration-replay", laneId: "wo-325", ownerId: "owner", queueHeadLaneId: "wo-325", leaseEpoch: 1,
    staging, stagingReadbackSha: "c".repeat(40),
    receipt: { shippingPullNumber: 44, sourceHeadSha: "b".repeat(40), stagingBaseSha: staging.sha, mergeBaseSha: staging.sha, mergeCommitSha: "c".repeat(40), mergeMethod: "merge" as const, reviewedAt: staging.checkedAt },
    reviewPassed: true, verificationPassed: true, mergeable: true, authorityValid: true, mergeCommit: true,
  };
  await journal.promoteLane({ ...input, readPromotionEvidence: async () => ({ ownerId: "owner", queueHeadLaneId: "wo-325", leaseEpoch: 1, staging, stagingReadbackSha: "c".repeat(40) }) });
  const replayed = await journal.promoteLane({ ...input, readPromotionEvidence: async () => { throw new Error("must not read consumed lease"); } });
  assert.equal(replayed.integrationLane?.status, "promoted");
});
