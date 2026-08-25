import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseNextExecutableNode,
  chooseReadyReviewerNodes,
  reviewJoinReady,
  type WorkflowNodeRecord,
} from "../../src/core/dispatcher.ts";

function completed(node: WorkflowNodeRecord["node"], id = `${node}-1`, headSha = "abcdef1234567"): WorkflowNodeRecord {
  return {
    nodeId: id,
    node,
    attempt: 1,
    status: "completed",
    headSha,
    ...(node === "review-correctness" || node === "review-security"
      ? { publishedCommentId: node === "review-correctness" ? 101 : 102 }
      : {}),
  };
}

test("dispatcher selects exactly one bounded node and gates review join on same SHA", () => {
  const records: WorkflowNodeRecord[] = [
    completed("resolve"),
    completed("investigate", "investigate-1"),
    completed("plan"),
    completed("prepare-worktree"),
    completed("implement"),
    completed("verify"),
    completed("prepare-pr"),
    completed("review-correctness", "review-correctness-1", "abcdef1234567"),
  ];
  const next = chooseNextExecutableNode({ nodes: records });
  assert.equal(next?.node, "review-security");
  assert.equal(next?.nodeId, "review-security-1");
  assert.equal(
    chooseNextExecutableNode({ nodes: [...records, completed("review-security", "review-security-1", "different12345")] }),
    undefined,
  );
});

test("verify and prepare-pr use the completed predecessor head from the same round", () => {
  const prefix: WorkflowNodeRecord[] = [
    completed("resolve"),
    completed("investigate"),
    completed("plan"),
    completed("prepare-worktree"),
  ];
  const implemented = [
    ...prefix,
    completed("implement", "implement-1", "implementation123"),
  ];
  assert.equal(
    chooseNextExecutableNode({ nodes: implemented })?.headSha,
    "implementation123",
  );
  assert.throws(
    () =>
      chooseNextExecutableNode({
        nodes: [...prefix, { ...completed("implement"), headSha: undefined }],
      }),
    /requires the completed implementation head from the same round/,
  );
  const verified = [
    ...implemented,
    completed("verify", "verify-1", "verified1234567"),
  ];
  const prepare = chooseNextExecutableNode({ nodes: verified });
  assert.equal(prepare?.node, "prepare-pr");
  assert.equal(prepare?.headSha, "verified1234567");
});

test("both reviewer nodes become independently runnable at the frozen PR head", () => {
  const records: WorkflowNodeRecord[] = [
    completed("resolve"),
    completed("investigate"),
    completed("plan"),
    completed("prepare-worktree"),
    completed("implement"),
    completed("verify"),
    completed("prepare-pr", "prepare-pr-1", "frozen1234567"),
  ];
  assert.deepEqual(
    chooseReadyReviewerNodes({ nodes: records }).map((node) => ({
      nodeId: node.nodeId,
      headSha: node.headSha,
    })),
    [
      { nodeId: "review-correctness-1", headSha: "frozen1234567" },
      { nodeId: "review-security-1", headSha: "frozen1234567" },
    ],
  );
  assert.deepEqual(
    chooseReadyReviewerNodes({
      nodes: [
        ...records,
        {
          ...completed(
            "review-correctness",
            "review-correctness-1",
            "frozen1234567",
          ),
          status: "running",
        },
      ],
    }).map((node) => node.node),
    ["review-security"],
  );
});

test("review join is released only after both reviewers complete at the frozen head", () => {
  const records: WorkflowNodeRecord[] = [
    completed("resolve"),
    completed("investigate"),
    completed("plan"),
    completed("prepare-worktree"),
    completed("implement"),
    completed("verify"),
    completed("prepare-pr"),
    completed("review-correctness", "correctness-1", "abcdef1234567"),
    completed("review-security", "security-1", "abcdef1234567"),
  ];
  assert.equal(reviewJoinReady(records, "abcdef1234567"), true);
  assert.equal(reviewJoinReady(records, "different12345"), false);
  assert.equal(chooseNextExecutableNode({ nodes: records })?.node, "review-join");
});

test("review join selects explicit parent CI, decision, merge, close, cleanup nodes", () => {
  const prefix: WorkflowNodeRecord[] = ["resolve", "investigate", "plan", "prepare-worktree", "implement", "verify", "prepare-pr", "review-correctness", "review-security", "review-join"].map((node) => completed(node as WorkflowNodeRecord["node"], `${node}-1`));
  const expected = ["ci", "decision", "merge", "close", "cleanup"] as const;
  let records = prefix;
  for (const node of expected) {
    const next = chooseNextExecutableNode({ nodes: records });
    assert.equal(next?.node, node);
    records = [...records, completed(node)];
  }
  assert.equal(chooseNextExecutableNode({ nodes: records }), undefined);
});

test("investigation invalid and decomposed outcomes route to close without implementation", () => {
  for (const outcome of ["invalid", "decomposed"] as const) {
    const records: WorkflowNodeRecord[] = [
      completed("resolve"),
      { ...completed("investigate"), outcome },
    ];
    assert.equal(chooseNextExecutableNode({ nodes: records })?.node, "close");
    const closed: WorkflowNodeRecord[] = [...records, completed("close")];
    assert.equal(chooseNextExecutableNode({ nodes: closed })?.node, "cleanup");
  }
});

test("decision remediation advances one immutable fresh round and then exhausts at policy max", () => {
  const prefix: WorkflowNodeRecord[] = [
    completed("resolve"),
    completed("investigate"),
    completed("plan"),
    completed("prepare-worktree"),
    completed("implement"),
    completed("verify"),
    completed("prepare-pr"),
    completed("review-correctness"),
    completed("review-security"),
    completed("review-join"),
    completed("ci"),
    {
      ...completed("decision"),
      outcome: "remediation-required",
      round: 1,
    },
  ];
  let records = prefix;
  const remediationHead = "remediated1234567";
  for (const node of [
    "implement",
    "verify",
    "prepare-pr",
    "review-correctness",
    "review-security",
    "review-join",
    "ci",
    "decision",
  ] as const) {
    const next = chooseNextExecutableNode({ nodes: records, maxReviewRounds: 2 });
    assert.equal(next?.node, node);
    assert.equal(next?.nodeId, `${node}-2`);
    assert.equal(next?.round, 2);
    if (node === "verify" || node === "prepare-pr")
      assert.equal(next?.headSha, remediationHead);
    records = [
      ...records,
      {
        ...next!,
        status: "completed",
        ...(node === "implement" ? { headSha: remediationHead } : {}),
        ...(node === "review-correctness"
          ? { publishedCommentId: 201 }
          : node === "review-security"
            ? { publishedCommentId: 202 }
            : {}),
        ...(node === "decision" ? { outcome: "awaiting-merge" as const } : {}),
      },
    ];
  }
  assert.equal(
    chooseNextExecutableNode({ nodes: records, maxReviewRounds: 2 })?.node,
    "merge",
  );
  assert.equal(
    chooseNextExecutableNode({ nodes: prefix, maxReviewRounds: 1 }),
    undefined,
  );
});

test("remediation attempts keep immutable node identities", () => {
  const records: WorkflowNodeRecord[] = [
    completed("implement", "implement-1", "abcdef1234567"),
    completed("verify", "verify-1", "abcdef1234567"),
    completed("prepare-pr", "prepare-pr-1", "abcdef1234567"),
    completed("review-correctness", "review-correctness-1", "abcdef1234567"),
    completed("review-security", "review-security-1", "abcdef1234567"),
    completed("review-join", "review-join-1", "abcdef1234567"),
  ];
  const remediation: WorkflowNodeRecord = {
    nodeId: "implement-2",
    node: "implement",
    attempt: 2,
    status: "queued",
    headSha: "abcdef1234567",
  };
  assert.equal(records.some((record) => record.nodeId === "implement-1"), true);
  assert.equal(remediation.nodeId, "implement-2");
  assert.notEqual(remediation.nodeId, records[0]?.nodeId);
});
