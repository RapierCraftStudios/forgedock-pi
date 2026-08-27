import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubWorkflowAdapter } from "../../src/adapters/github-workflow.ts";
import type { ForgeWorkOnResult } from "../../src/agents/contracts.ts";
import { createBuilderPathContract } from "../../src/core/builder-contract.ts";
import {
  classifyRemediationFindings,
  closeAddressedReviewFindingIssues,
  isRemediationCandidate,
  loadAuthoritativeReviewFindingIssues,
  parseAuthoritativeReviewFindingIssue,
  readRemediationMarkerState,
  remediationCompleteMarker,
  remediationFindingClosedMarker,
  remediationStartMarker,
} from "../../src/workflows/remediation.ts";

class RemediationGitHubFake {
  readonly issues = [
    {
      number: 100,
      title: "finding",
      body: findingBody(7, "SEC-001", "security"),
      state: "open" as "open" | "closed",
      labels: ["review-finding"],
    },
    {
      number: 101,
      title: "duplicate",
      body: findingBody(7, "SEC-001", "security"),
      state: "open" as "open" | "closed",
      labels: ["review-finding"],
    },
    {
      number: 102,
      title: "other pull",
      body: findingBody(8, "SEC-002", "security"),
      state: "open" as "open" | "closed",
      labels: ["review-finding"],
    },
  ];
  readonly comments = new Map<number, string[]>();

  async listIssuesByLabel() {
    return this.issues;
  }

  async getIssue(number: number) {
    const issue = this.issues.find((candidate) => candidate.number === number);
    if (!issue) throw new Error(`Missing issue ${number}`);
    return issue;
  }

  async getComments(number: number) {
    return this.comments.get(number) ?? [];
  }

  async commentOnIssue(number: number, body: string) {
    const comments = this.comments.get(number) ?? [];
    comments.push(body);
    this.comments.set(number, comments);
    return comments.length;
  }

  async closeIssue(number: number) {
    (await this.getIssue(number)).state = "closed";
  }
}

const blockedResult = {
  schema: "forgedock.work-on-result/v1",
  runId: "run-1",
  issueNumber: 42,
  status: "blocked",
  branch: "forge/issue-42",
  baseSha: "base-sha",
  headSha: "head-sha",
  changedFiles: ["src/example.ts"],
  verification: [],
  review: {
    headSha: "head-sha",
    rounds: 1,
    completedReviewers: [],
    reviewerResults: [],
    findings: [],
  },
  residualRisks: [],
  blocker: "review findings",
} satisfies ForgeWorkOnResult;

test("open review-finding issues are authoritative and deduplicated per PR", async () => {
  const fake = new RemediationGitHubFake();
  const findings = await loadAuthoritativeReviewFindingIssues({
    github: fake as unknown as GitHubWorkflowAdapter,
    pullNumber: 7,
  });
  assert.deepEqual(findings.map((finding) => finding.issueNumber), [100]);
  assert.equal(findings[0]?.finding.id, "SEC-001");
});

test("remediation classification fixes in-contract blockers and escalates true authority decisions", () => {
  const fixable = parseAuthoritativeReviewFindingIssue({
    number: 100,
    body: findingBody(7, "SEC-001", "security"),
  });
  const escalated = parseAuthoritativeReviewFindingIssue({
    number: 101,
    body: findingBody(7, "POLICY-001", "production-safety"),
  });
  assert.ok(fixable && escalated);
  const classification = classifyRemediationFindings([fixable, escalated]);
  assert.deepEqual(classification.fixable.map((item) => item.finding.id), [
    "SEC-001",
    "POLICY-001",
  ]);
  assert.deepEqual(classification.escalated, []);
  const authorityFinding = parseAuthoritativeReviewFindingIssue({
    number: 102,
    body: findingBody(7, "AUTHORITY-001", "security").replace(
      "Unsafe trust-boundary validation permits stale input",
      "Product policy and release authority decision required",
    ),
  });
  assert.ok(authorityFinding);
  assert.deepEqual(
    classifyRemediationFindings([authorityFinding]).escalated.map(
      (item) => item.finding.id,
    ),
    ["AUTHORITY-001"],
  );
  assert.equal(
    isRemediationCandidate(blockedResult, classification.fixable),
    true,
  );
  const outsideContract = classifyRemediationFindings(
    [fixable],
    createBuilderPathContract(["test/**"]),
  );
  assert.deepEqual(
    outsideContract.escalated.map((item) => item.finding.id),
    ["SEC-001"],
  );
  assert.equal(
    isRemediationCandidate(
      { ...blockedResult, blocker: "main protected branch policy" },
      classification.fixable,
    ),
    false,
  );
});

test("durable remediation markers distinguish partial and complete attempts", () => {
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

test("addressed finding closure is commit-bearing and idempotent", async () => {
  const fake = new RemediationGitHubFake();
  const github = fake as unknown as GitHubWorkflowAdapter;
  const input = {
    github,
    pullNumber: 7,
    priorFindingIssueMap: { "SEC-001": 100 },
    activeFindingIds: new Set<string>(),
    remediationCommitSha: "new-head",
    runId: "run-1",
  };
  await closeAddressedReviewFindingIssues(input);
  await closeAddressedReviewFindingIssues(input);
  assert.equal(fake.issues[0]?.state, "closed");
  assert.equal(fake.comments.get(100)?.length, 1);
  assert.match(
    fake.comments.get(100)?.[0] ?? "",
    new RegExp(remediationFindingClosedMarker("run-1", "SEC-001", "new-head")),
  );
});

test("review-finding cleanup revalidates source authority and decodes finding IDs", async () => {
  const encoded = parseAuthoritativeReviewFindingIssue({
    number: 103,
    body: findingBody(7, "SEC%2F001", "security"),
  });
  assert.equal(encoded?.finding.id, "SEC/001");

  const fake = new RemediationGitHubFake();
  await assert.rejects(
    closeAddressedReviewFindingIssues({
      github: fake as unknown as GitHubWorkflowAdapter,
      pullNumber: 7,
      priorFindingIssueMap: { "SEC-002": 102 },
      activeFindingIds: new Set<string>(),
      remediationCommitSha: "new-head",
      runId: "run-1",
    }),
    /not authorized for cleanup/i,
  );
  assert.equal(fake.issues[2]?.state, "open");
  assert.equal(fake.comments.get(102), undefined);
});

function findingBody(
  pullNumber: number,
  findingId: string,
  category: string,
): string {
  return [
    `<!-- FORGE:REVIEW_FINDING source-pr=${pullNumber} finding=${findingId} head=head-sha -->`,
    "## Review Finding",
    "",
    `**Source PR**: #${pullNumber}`,
    "**Source issue**: #42",
    "**Forge run**: `run-1`",
    "**Reviewed head**: `head-sha`",
    "**Reviewer**: `forge-review-security`",
    `**Finding ID**: \`${findingId}\``,
    "**Confidence**: CONFIRMED",
    "**Severity**: HIGH",
    `**Category**: ${category}`,
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
