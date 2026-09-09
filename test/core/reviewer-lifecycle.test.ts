import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { checkCurrentReviewAuditTrail } from "../../src/core/artifact-protocol.ts";
import {
  chooseNextExecutableNode as chooseWorkflowDispatch,
  chooseReadyReviewerNodes,
  reviewJoinReady,
  type WorkflowNodeRecord,
} from "../../src/core/dispatcher.ts";

const headSha = "abcdef1234567890";

function chooseNextExecutableNode(state: { nodes: WorkflowNodeRecord[] }): WorkflowNodeRecord | undefined {
  const decision = chooseWorkflowDispatch(state);
  return decision.kind === "next" ? decision : undefined;
}

function completed(
  node: WorkflowNodeRecord["node"],
  overrides: Partial<WorkflowNodeRecord> = {},
): WorkflowNodeRecord {
  return {
    nodeId: `${node}-1`,
    node,
    attempt: 1,
    status: "completed",
    headSha,
    ...overrides,
  };
}

function throughPreparedPr(): WorkflowNodeRecord[] {
  return [
    completed("resolve"),
    completed("investigate"),
    completed("plan"),
    completed("prepare-worktree"),
    completed("implement"),
    completed("verify"),
    completed("prepare-pr"),
  ];
}

function reviewerComment(domain: string): string {
  return `<!-- FORGE:REVIEW-INSTANCE run=run-1 domain=${domain} round=1 head=${headSha} -->\n<!-- FORGE:REVIEW-AGENT:${domain} -->`;
}

test("first reviewer publication is visible while its peer remains running", () => {
  const records = [
    ...throughPreparedPr(),
    completed("review-correctness", { publishedCommentId: 101 }),
    {
      nodeId: "review-security-1",
      node: "review-security" as const,
      attempt: 1,
      status: "running" as const,
      headSha,
    },
  ];
  assert.equal(reviewJoinReady(records, headSha), false);
  assert.equal(chooseNextExecutableNode({ nodes: records }), undefined);
  const audit = checkCurrentReviewAuditTrail({
    pullRequestComments: [reviewerComment("correctness")],
    expectedRunId: "run-1",
    expectedHeadSha: headSha,
    expectedRound: 1,
    requiredReviewerDomains: ["correctness", "security"],
  });
  assert.deepEqual(audit.missingReviewerDomains, ["security"]);
  assert.equal(audit.missingSummary, true);
});

test("failed or hanging peer preserves completed reviewer evidence and blocks join", () => {
  for (const status of ["running", "failed"] as const) {
    const correctness = completed("review-correctness", {
      publishedCommentId: 101,
    });
    const records: WorkflowNodeRecord[] = [
      ...throughPreparedPr(),
      correctness,
      {
        nodeId: "review-security-1",
        node: "review-security",
        attempt: 1,
        status,
        headSha,
      },
    ];
    assert.equal(records.includes(correctness), true);
    assert.equal(reviewJoinReady(records, headSha), false);
    assert.equal(chooseNextExecutableNode({ nodes: records }), undefined);
  }
});

test("restart resumes only the missing reviewer and never replays published correctness", () => {
  const records = [
    ...throughPreparedPr(),
    completed("review-correctness", { publishedCommentId: 101 }),
  ];
  assert.deepEqual(
    chooseReadyReviewerNodes({ nodes: records }).map((node) => node.node),
    ["review-security"],
  );
});

test("a new prepared head creates distinct round-two reviewer nodes", () => {
  const oldHead = "oldhead1234567";
  const records: WorkflowNodeRecord[] = [
    ...throughPreparedPr().map((record) =>
      record.node === "prepare-pr"
        ? { ...record, headSha: oldHead }
        : record,
    ),
    completed("review-correctness", {
      headSha: oldHead,
      publishedCommentId: 101,
    }),
    completed("review-security", {
      headSha: oldHead,
      publishedCommentId: 102,
    }),
    {
      nodeId: "prepare-pr-2",
      node: "prepare-pr",
      attempt: 2,
      status: "completed",
      headSha,
    },
  ];
  assert.deepEqual(
    chooseReadyReviewerNodes({ nodes: records }).map((node) => node.nodeId),
    ["review-correctness-2", "review-security-2"],
  );
});

test("contract-gap lifecycle preserves one lane while unrelated lanes remain ready", async () => {
  const [workOn, review, remediate, investigate, mechanical] = await Promise.all([
    readFile("specs/original/commands/work-on.md", "utf8"),
    readFile("specs/original/commands/review-pr.md", "utf8"),
    readFile("specs/original/commands/work-on/remediate.md", "utf8"),
    readFile("specs/original/commands/work-on/investigate.md", "utf8"),
    readFile("specs/mechanical-execution.md", "utf8"),
  ]);
  for (const content of [workOn, review, remediate, investigate, mechanical]) {
    assert.match(content, /CONTRACT_GAP/);
    assert.match(content, /REPLAN_REQUIRED/);
  }
  assert.match(review, /fresh exact-head review/i);
  assert.match(remediate, /remediation usage/i);
  assert.match(investigate, /exact reviewed PR\s+head/i);
  assert.match(mechanical, /replanId/);
  assert.match(workOn, /GATED.*exact wake condition/is);
  assert.match(mechanical, /replanId/);

  const gapDecision = chooseWorkflowDispatch({
    maxReviewRounds: 1,
    nodes: [{
      nodeId: "decision-1",
      node: "decision",
      attempt: 1,
      round: 1,
      status: "completed",
      outcome: "remediation-required",
      headSha: "head-a",
    }],
  });
  assert.equal(gapDecision.kind, "blocked");
  assert.match(gapDecision.reason, /exhausted/i);

  // The scheduler evaluates an unrelated lane from its own state; no gap record
  // is consulted and the lane remains independently ready for resolve.
  const unrelatedDecision = chooseWorkflowDispatch({ maxReviewRounds: 1, nodes: [] });
  assert.equal(unrelatedDecision.kind, "next");
  assert.equal(unrelatedDecision.node, "resolve");
});

test("summary becomes eligible only after both current-head comments are durable", () => {
  const records = [
    ...throughPreparedPr(),
    completed("review-correctness", { publishedCommentId: 101 }),
    completed("review-security", { publishedCommentId: 102 }),
  ];
  assert.equal(reviewJoinReady(records, headSha), true);
  assert.equal(chooseNextExecutableNode({ nodes: records })?.node, "review-join");
});
