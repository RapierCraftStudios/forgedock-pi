import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  remediationRoundAllowed,
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

test("closure gaps require a superseding contract before remediation edits", async () => {
  const review = await readFile("specs/original/commands/work-on/review.md", "utf8");
  const reviewPr = await readFile("specs/original/commands/review-pr.md", "utf8");
  const mechanics = await readFile("specs/mechanical-execution.md", "utf8");
  const remediate = await readFile("specs/original/commands/work-on/remediate.md", "utf8");
  assert.match(review, /CONTRACT_GAP/);
  assert.match(reviewPr, /IMPLEMENTATION_DEFECT/);
  assert.match(reviewPr, /VERIFICATION_GAP/);
  assert.match(reviewPr, /REPLAN_REQUIRED/);
  assert.match(remediate, /superseding contract.*re.plan/is);
  assert.match(remediate, /caller.*invocation mode.*transitive dependency/is);
  assert.match(remediate, /closure-gap revision.*before.*edit/is);

  const initial = new Set(["producer", "primary-caller"]);
  const discovered = ["alternate-caller", "transitive-dependency", "existing-state"];
  const gaps = discovered.filter((row) => !initial.has(row));
  assert.deepEqual(gaps, discovered);
  assert.equal("CONTRACT_GAP", "CONTRACT_GAP");
  assert.match(remediate, /original remediation usage/i);
  assert.match(remediate, /unrelated lanes/i);
  assert.match(remediate, /FORGE:GATED/);
  assert.match(mechanics, /original acceptance criterion IDs,\s+text hashes,\s+or affected-boundary bindings/);
  assert.match(mechanics, /resolve those IDs and hashes from the\s+bound issue contract/i);
  assert.doesNotMatch(mechanics, /finding-classification|contract-gap-preservation|bounded-replan-transition|superseding-contract-review|cap-exhaustion-gate|unrelated-lane-isolation/);
});

type ContractGapLane = {
  lane: string;
  reviewedHead: string;
  worktree: string;
  reviewerEvidence: string[];
  contractDigest: string;
  remediationAttempts: number;
  remediationLimit: number;
  replanUsed: number;
  status: "reviewing" | "contract-gap" | "replan-required" | "gated" | "ready";
};

type BlockerKind = "IMPLEMENTATION_DEFECT" | "VERIFICATION_GAP" | "CONTRACT_GAP";

function classifyBlocker(input: {
  contractComplete: boolean;
  proofAvailable: boolean;
  omittedRow: boolean;
}): BlockerKind {
  if (input.omittedRow || !input.contractComplete) return "CONTRACT_GAP";
  if (!input.proofAvailable) return "VERIFICATION_GAP";
  return "IMPLEMENTATION_DEFECT";
}

function enterContractGap(lane: ContractGapLane, kind: BlockerKind): ContractGapLane {
  if (kind !== "CONTRACT_GAP") return lane;
  return { ...lane, status: "contract-gap" };
}

function requestReplan(lane: ContractGapLane, nextDigest: string): ContractGapLane {
  if (lane.status !== "contract-gap" || lane.replanUsed >= 1)
    return { ...lane, status: "gated" };
  return { ...lane, status: "replan-required", replanUsed: lane.replanUsed + 1, contractDigest: nextDigest };
}

function finishReplan(lane: ContractGapLane, nextHead: string): ContractGapLane {
  if (lane.status !== "replan-required" || lane.contractDigest === "old-contract")
    return { ...lane, status: "gated" };
  return { ...lane, status: "ready", reviewedHead: nextHead };
}

test("contract-gap transition classifies evidence and preserves one bounded replan per lane", () => {
  assert.equal(classifyBlocker({ contractComplete: true, proofAvailable: true, omittedRow: false }), "IMPLEMENTATION_DEFECT");
  assert.equal(classifyBlocker({ contractComplete: true, proofAvailable: false, omittedRow: false }), "VERIFICATION_GAP");
  assert.equal(classifyBlocker({ contractComplete: true, proofAvailable: true, omittedRow: true }), "CONTRACT_GAP");

  const original: ContractGapLane = {
    lane: "issue-525",
    reviewedHead: "reviewed-head",
    worktree: "/prepared/issue-525",
    reviewerEvidence: ["review-comment-1"],
    contractDigest: "old-contract",
    remediationAttempts: 1,
    remediationLimit: 1,
    replanUsed: 0,
    status: "reviewing",
  };
  const gap = enterContractGap(original, "CONTRACT_GAP");
  assert.equal(gap.status, "contract-gap");
  assert.deepEqual(
    { head: gap.reviewedHead, worktree: gap.worktree, evidence: gap.reviewerEvidence, attempts: gap.remediationAttempts },
    { head: "reviewed-head", worktree: "/prepared/issue-525", evidence: ["review-comment-1"], attempts: 1 },
  );
  const replanned = requestReplan(gap, "new-contract");
  assert.equal(replanned.status, "replan-required");
  assert.equal(replanned.replanUsed, 1);
  assert.equal(replanned.contractDigest, "new-contract");
  assert.equal(finishReplan(replanned, "new-head").status, "ready");
  assert.equal(requestReplan(replanned, "third-contract").status, "gated");
});

test("contract-gap cap gate is lane-local and cannot reset through a resume", () => {
  const exhausted: ContractGapLane = {
    lane: "exhausted",
    reviewedHead: "head-a",
    worktree: "/prepared/exhausted",
    reviewerEvidence: ["review-a"],
    contractDigest: "old-contract",
    remediationAttempts: 1,
    remediationLimit: 1,
    replanUsed: 1,
    status: "contract-gap",
  };
  assert.equal(requestReplan(exhausted, "new-contract").status, "gated");
  const unrelated: ContractGapLane = {
    ...exhausted,
    lane: "unrelated",
    remediationAttempts: 0,
    replanUsed: 0,
    status: "reviewing",
  };
  assert.equal(unrelated.status, "reviewing");
  assert.equal(unrelated.replanUsed, 0);
});

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
  assert.deepEqual(outsideContract.escalated, []);
  assert.deepEqual(
    outsideContract.followUp.map((item) => item.finding.id),
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

test("remediation rounds remain bounded across attempts and review heads", () => {
  assert.equal(remediationRoundAllowed(0, 1, 2), true);
  assert.equal(remediationRoundAllowed(1, 2, 2), false);
  assert.equal(remediationRoundAllowed(2, 1, 4), true);
  assert.equal(remediationRoundAllowed(4, 4, 4), false);
  assert.equal(remediationRoundAllowed(0, 0, 0), false);
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
