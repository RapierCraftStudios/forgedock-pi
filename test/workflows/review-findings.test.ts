import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubWorkflowAdapter } from "../../src/adapters/github-workflow.ts";
import type { ForgeWorkOnResult } from "../../src/agents/contracts.ts";
import {
  publishReviewFindingIssues,
  type ActiveRunLink,
} from "../../src/workflows/work-on.ts";

class FindingGitHubFake {
  readonly issues: Array<{
    number: number;
    title: string;
    body: string;
    state: "open" | "closed";
    labels: readonly string[];
    htmlUrl?: string;
  }> = [];
  readonly pullArtifacts: Array<{ marker: string; body: string }> = [];

  async listIssuesByLabel() {
    return this.issues;
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: readonly string[];
  }) {
    const issue = {
      number: this.issues.length + 100,
      title: input.title,
      body: input.body,
      state: "open" as const,
      labels: input.labels,
      htmlUrl: `https://example.test/issues/${this.issues.length + 100}`,
    };
    this.issues.push(issue);
    return issue;
  }

  async postPullArtifact(input: { marker: string; body: string }) {
    this.pullArtifacts.push({ marker: input.marker, body: input.body });
    return this.pullArtifacts.length;
  }
}

const link: ActiveRunLink = {
  forgeRunId: "run-1",
  subagentRunId: "child-1",
  issueNumber: 42,
  repository: "owner/repo",
  stateBranch: "forgedock/state/v1",
  resultPath: "/tmp/result.json",
  prepared: {
    repositoryRoot: "/tmp/repo",
    worktreePath: "/tmp/repo/.forge/worktrees/run-1",
    branch: "forge/issue-42-run-1",
    baseBranch: "staging",
    baseSha: "base-sha",
  },
  status: "finalizing",
  leaseOwnerRunId: "run-1",
  leaseEpoch: 1,
  reviewBaseSha: "base-sha",
  refreshes: 0,
  providerRetries: 0,
  remediationAttempts: 0,
  findingIssueMap: {},
  activeNodes: {},
};

const result: ForgeWorkOnResult = {
  schema: "forgedock.work-on-result/v1",
  runId: "run-1",
  issueNumber: 42,
  status: "ready-for-merge",
  branch: link.prepared.branch,
  baseSha: "base-sha",
  headSha: "head-sha",
  changedFiles: ["src/example.ts"],
  verification: [],
  review: {
    headSha: "head-sha",
    rounds: 1,
    completedReviewers: ["forge-review-security"],
    reviewerResults: [],
    findings: [
      {
        id: "SEC-001",
        reviewer: "forge-review-security",
        runId: "run-1",
        headSha: "head-sha",
        confidence: "likely",
        severity: "high",
        category: "security",
        file: "src/example.ts",
        line: 50,
        summary: "Unsafe trust-boundary validation permits stale input",
        evidence: ["The boundary accepts stale input."],
      },
    ],
  },
  residualRisks: [],
};

test("every structured finding creates one deduplicated standalone issue", async () => {
  const fake = new FindingGitHubFake();
  const github = fake as unknown as GitHubWorkflowAdapter;
  const first = await publishReviewFindingIssues({
    github,
    pullNumber: 7,
    link,
    result,
  });
  const second = await publishReviewFindingIssues({
    github,
    pullNumber: 7,
    link,
    result,
  });

  assert.deepEqual(first, { "SEC-001": 100 });
  assert.deepEqual(second, first);
  assert.equal(fake.issues.length, 1);
  assert.deepEqual(fake.issues[0]?.labels, [
    "review-finding",
    "needs-validation",
    "priority:P1",
  ]);
  assert.match(fake.issues[0]?.body ?? "", /Source PR\*\*: #7/);
  assert.match(fake.issues[0]?.body ?? "", /Finding ID\*\*: `SEC-001`/);
  assert.equal(fake.pullArtifacts.length, 2);
  assert.match(fake.pullArtifacts[0]?.body ?? "", /#100/);
});
