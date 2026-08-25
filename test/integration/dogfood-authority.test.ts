import assert from "node:assert/strict";
import test from "node:test";

import {
  GitWorktreeManager,
  type CommandExecutor,
} from "../../src/adapters/git.ts";
import {
  assertBuilderContractPaths,
  createBuilderPathContract,
} from "../../src/core/builder-contract.ts";
import {
  evaluateReviewGate,
  type ReviewFinding,
} from "../../src/core/review.ts";
import {
  readRemediationMarkerState,
  remediationCompleteMarker,
  remediationStartMarker,
} from "../../src/workflows/remediation.ts";

const renameExecutor: CommandExecutor = {
  async exec() {
    return {
      stdout: "R100\0src/old.ts\0src/new.ts\0M\0test/example.test.ts\0",
      stderr: "",
      code: 0,
    };
  },
};

test("dogfood authority chain binds the full diff, verdict, and remediation recovery identity", async () => {
  const git = new GitWorktreeManager(renameExecutor);
  const changedFiles = await git.changedFiles("/worktree", "base-sha");
  assert.deepEqual(changedFiles, [
    "src/new.ts",
    "src/old.ts",
    "test/example.test.ts",
  ]);

  const contract = createBuilderPathContract([
    "src/old.ts",
    "src/new.ts",
    "test/**",
  ]);
  assert.doesNotThrow(() =>
    assertBuilderContractPaths(contract, changedFiles),
  );

  const finding: ReviewFinding = {
    id: "SEC-1",
    reviewer: "security",
    runId: "run-1",
    headSha: "head-sha",
    confidence: "likely",
    severity: "high",
    category: "security",
    file: "src/new.ts",
    line: 10,
    summary: "follow-up hardening",
    evidence: ["bounded evidence"],
  };
  const gateInput = {
    identity: {
      repository: "owner/repo",
      runId: "run-1",
      pullRequest: 7,
      headSha: "head-sha",
      baseSha: "base-sha",
      rosterVersion: "v1",
    },
    currentHeadSha: "head-sha",
    currentBaseSha: "base-sha",
    requiredReviewers: ["correctness", "security"],
    completedReviewers: ["correctness", "security"],
    findings: [finding],
    checks: [{ name: "test", required: true, status: "passed" as const }],
    mergeability: "mergeable" as const,
    leaseValid: true,
    baseBranch: "staging",
    protectedBranches: ["main"],
    autoMergeAuthorized: true,
  };
  assert.equal(
    evaluateReviewGate(gateInput).decision,
    "approved-with-follow-ups",
  );
  assert.equal(
    evaluateReviewGate({
      ...gateInput,
      findings: [{ ...finding, confidence: "confirmed" as const }],
    }).decision,
    "changes-requested",
  );

  const start = remediationStartMarker("run-1", 1);
  assert.deepEqual(readRemediationMarkerState([start], "run-1"), {
    startedAttempts: [1],
    completedAttempts: [],
  });
  const complete = remediationCompleteMarker("run-1", 1);
  assert.deepEqual(readRemediationMarkerState([start, complete], "run-1"), {
    startedAttempts: [1],
    completedAttempts: [1],
  });
});
