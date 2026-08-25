import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubWorkflowAdapter } from "../../src/adapters/github-workflow.ts";
import type { ForgeWorkOnResult } from "../../src/agents/contracts.ts";
import {
  classifyRemediationFindings,
  closeAddressedReviewFindingIssues,
  isRemediationCandidate,
  loadAuthoritativeReviewFindingIssues,
  parseAuthoritativeReviewFindingIssue,
  publishReviewFindingIssues,
  readRemediationMarkerState,
  remediationFindingClosedMarker,
  remediationStartMarker,
  type ActiveRunLink,
  type AuthoritativeReviewFinding,
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
  readonly comments = new Map<number, string[]>();

  async listIssuesByLabel() {
    return this.issues;
  }

  async getIssue(issueNumber: number) {
    const issue = this.issues.find((entry) => entry.number === issueNumber);
    if (!issue) throw new Error(`Missing issue #${issueNumber}`);
    return issue;
  }

  async getComments(issueNumber: number) {
    return this.comments.get(issueNumber) ?? [];
  }

  async commentOnIssue(issueNumber: number, body: string) {
    const comments = this.comments.get(issueNumber) ?? [];
    comments.push(body);
    this.comments.set(issueNumber, comments);
    return comments.length;
  }

  async closeIssue(issueNumber: number) {
    const issue = await this.getIssue(issueNumber);
    issue.state = "closed";
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
    this.comments.set(issue.number, []);
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

test("authoritative finding inputs are scoped to the PR and deduplicated by finding ID", async () => {
  const fake = new FindingGitHubFake();
  const github = fake as unknown as GitHubWorkflowAdapter;
  await publishReviewFindingIssues({ github, pullNumber: 7, link, result });
  const first = fake.issues[0];
  assert.ok(first);
  fake.issues.push({ ...first, number: 101 });
  fake.issues.push({
    ...first,
    number: 102,
    body: first.body.replace("Source PR**: #7", "Source PR**: #8"),
  });
  const findings = await loadAuthoritativeReviewFindingIssues({
    github,
    pullNumber: 7,
  });
  assert.deepEqual(findings.map((entry) => entry.issueNumber), [100]);
  assert.equal(findings[0]?.finding.id, "SEC-001");
});

test("classification separates contract-safe fixes from policy escalation", () => {
  const parsed = parseAuthoritativeReviewFindingIssue({
    number: 100,
    body: fakeFindingBody(),
  });
  assert.ok(parsed);
  const policy: AuthoritativeReviewFinding = {
    ...parsed,
    issueNumber: 101,
    finding: {
      ...parsed.finding,
      id: "POLICY-001",
      category: "production-safety",
      summary: "Changing the release policy requires product approval",
    },
  };
  const classification = classifyRemediationFindings([parsed, policy]);
  assert.deepEqual(
    classification.fixable.map((entry) => entry.finding.id),
    ["SEC-001"],
  );
  assert.deepEqual(
    classification.escalated.map((entry) => entry.finding.id),
    ["POLICY-001"],
  );
  assert.equal(
    isRemediationCandidate(
      { ...result, status: "blocked", blocker: "review findings" },
      classification.fixable,
    ),
    true,
  );
  assert.equal(
    isRemediationCandidate(
      { ...result, status: "needs-human", blocker: "main branch is protected" },
      classification.fixable,
    ),
    false,
  );
});

test("partial remediation markers recover the existing bounded attempt", () => {
  const marker = remediationStartMarker("run-1", 1);
  const state = readRemediationMarkerState(
    [marker + "\n**Reviewed head**: `old-head`\n**Review rounds**: 1"],
    "run-1",
  );
  assert.deepEqual(state.startedAttempts, [1]);
  assert.deepEqual(state.completedAttempts, []);
  assert.equal(state.sourceHeads[1], "old-head");
  assert.equal(state.sourceReviewRounds[1], 1);
});

test("addressed finding closure is commit-bearing and idempotent", async () => {
  const fake = new FindingGitHubFake();
  fake.issues.push({
    number: 200,
    title: "finding",
    body: fakeFindingBody(),
    state: "open",
    labels: ["review-finding"],
  });
  fake.comments.set(200, []);
  const github = fake as unknown as GitHubWorkflowAdapter;
  await closeAddressedReviewFindingIssues({
    github,
    pullNumber: 7,
    priorFindingIssueMap: { "SEC-001": 200 },
    activeFindingIds: new Set(),
    remediationCommitSha: "new-head",
    runId: "run-1",
  });
  assert.equal(
    fake.issues.find((issue) => issue.number === 200)?.state,
    "closed",
  );
  assert.ok(
    fake.comments.get(200)?.some((comment) =>
      comment.includes(
        remediationFindingClosedMarker("run-1", "SEC-001", "new-head"),
      ),
    ),
  );
  const commentCount = fake.comments.get(200)?.length;
  await closeAddressedReviewFindingIssues({
    github,
    pullNumber: 7,
    priorFindingIssueMap: { "SEC-001": 200 },
    activeFindingIds: new Set(),
    remediationCommitSha: "new-head",
    runId: "run-1",
  });
  assert.equal(fake.comments.get(200)?.length, commentCount);
});

function fakeFindingBody(): string {
  return [
    "<!-- FORGE:REVIEW_FINDING source-pr=7 finding=SEC-001 head=head-sha -->",
    "## Review Finding",
    "",
    "**Source PR**: #7",
    "**Source issue**: #42",
    "**Forge run**: `run-1`",
    "**Reviewed head**: `head-sha`",
    "**Reviewer**: `forge-review-security`",
    "**Finding ID**: `SEC-001`",
    "**Confidence**: LIKELY",
    "**Severity**: HIGH",
    "**Category**: security",
    "**File**: `src/example.ts`",
    "**Line**: 50",
    "",
    "### Problem",
    "",
    "Unsafe trust-boundary validation permits stale input",
    "",
    "### Evidence",
    "",
    "- The boundary accepts stale input.",
    "",
    "### Acceptance Criteria",
    "",
    "- [ ] Re-review",
  ].join("\n");
}
