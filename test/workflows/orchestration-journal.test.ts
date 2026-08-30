import assert from "node:assert/strict";
import test from "node:test";

import type {
  CommitOrchestrationStateInput,
  GitHubStateBranchStore,
  ReadOrchestrationStateResult,
} from "../../src/adapters/github-state.ts";
import { OrchestrationJournal } from "../../src/workflows/orchestration-journal.ts";

class MemoryOrchestrationStore {
  #snapshot: ReadOrchestrationStateResult = {
    tip: "tip-0",
    events: [],
    snapshotMatchesJournal: true,
  };

  async ensureBranch(): Promise<void> {}

  async readOrchestration(): Promise<ReadOrchestrationStateResult> {
    return this.#snapshot;
  }

  async commitOrchestrationState(input: CommitOrchestrationStateInput): Promise<string> {
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
