import assert from "node:assert/strict";
import test from "node:test";

import { checkCurrentReviewAuditTrail } from "../../src/core/artifact-protocol.ts";
import {
  chooseNextExecutableNode,
  chooseReadyReviewerNodes,
  reviewJoinReady,
  type WorkflowNodeRecord,
} from "../../src/core/dispatcher.ts";

const headSha = "abcdef1234567890";

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

test("summary becomes eligible only after both current-head comments are durable", () => {
  const records = [
    ...throughPreparedPr(),
    completed("review-correctness", { publishedCommentId: 101 }),
    completed("review-security", { publishedCommentId: 102 }),
  ];
  assert.equal(reviewJoinReady(records, headSha), true);
  assert.equal(chooseNextExecutableNode({ nodes: records })?.node, "review-join");
});
