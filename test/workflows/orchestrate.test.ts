/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkOrderLane,
  evaluateWorkOrderPromotion,
  selectPromotionQueueHead,
  workOrderPromotionReceipt,
} from "../../src/workflows/orchestrate.ts";

test("work-order lane derives deterministic identity from a frozen main SHA", () => {
  const input = {
    slug: "Release / Work Order",
    repository: "owner/repo",
    issueNumbers: [299, 300],
    frozenBaseSha: "a".repeat(40),
    now: "2026-08-30T00:00:00.000Z",
  };
  const first = createWorkOrderLane(input);
  const second = createWorkOrderLane(input);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "work-order");
  assert.equal(first.stableId, "wo-release-work-order");
  assert.equal(first.branch, "work-order/wo-release-work-order-release-work-order");
  assert.deepEqual(first.frozenBase, { branch: "main", sha: "a".repeat(40) });
  assert.deepEqual(first.membership, [
    { issueNumber: 299, ordinal: 0 },
    { issueNumber: 300, ordinal: 1 },
  ]);
});

test("work-order lane rejects malformed frozen bases through the shared validator", () => {
  assert.throws(
    () =>
      createWorkOrderLane({
        slug: "demo",
        repository: "owner/repo",
        issueNumbers: [1],
        frozenBaseSha: "not-a-sha",
      }),
    /frozen base/i,
  );
});

test("queue-authorized shipping merge requires the durable queue head", () => {
  const first = createWorkOrderLane({ slug: "first", repository: "owner/repo", issueNumbers: [1], frozenBaseSha: "a".repeat(40) });
  const second = createWorkOrderLane({ slug: "second", repository: "owner/repo", issueNumbers: [2], frozenBaseSha: "a".repeat(40) });
  const staging = { branch: "staging", sha: "b".repeat(40), baselineSha: "b".repeat(40), idle: true, checkedAt: "2026-08-30T00:00:01.000Z" };
  const queuedSecond = { ...second, status: "ready" as const, promotion: { queuePosition: 1, queueLease: { ownerId: "owner", epoch: 1, acquiredAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T00:01:00.000Z" } } };
  assert.equal(evaluateWorkOrderPromotion({ lane: queuedSecond, ownerId: "owner", now: staging.checkedAt, sourceHeadSha: "c".repeat(40), mergeBaseSha: staging.sha, staging, reviewPassed: true, verificationPassed: true, mergeable: true, authorityValid: true, mergeCommit: true, queueHeadLaneId: first.stableId }).allowed, false);
});

test("promotion gates reject failed review before merge authorization", () => {
  const lane = createWorkOrderLane({ slug: "gated", repository: "owner/repo", issueNumbers: [1], frozenBaseSha: "a".repeat(40), now: "2026-08-30T00:00:00.000Z" });
  const staging = { branch: "staging", sha: "b".repeat(40), baselineSha: "b".repeat(40), idle: true, checkedAt: "2026-08-30T00:00:01.000Z" };
  const result = evaluateWorkOrderPromotion({
    lane: { ...lane, status: "ready" as const, promotion: { queuePosition: 0, queueLease: { ownerId: "owner", epoch: 1, acquiredAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T00:01:00.000Z" } } },
    ownerId: "owner",
    now: staging.checkedAt,
    sourceHeadSha: "c".repeat(40),
    mergeBaseSha: staging.sha,
    staging,
    reviewPassed: false,
    verificationPassed: true,
    mergeable: true,
    authorityValid: true,
    mergeCommit: true,
  });
  assert.deepEqual(result, { allowed: false, reason: "Promotion review, verification, or mergeability gate failed." });
});

test("promotion queue selects one head and returns a durable gate result", () => {
  const first = createWorkOrderLane({ slug: "first", repository: "owner/repo", issueNumbers: [1], frozenBaseSha: "a".repeat(40) });
  const second = createWorkOrderLane({ slug: "second", repository: "owner/repo", issueNumbers: [2], frozenBaseSha: "a".repeat(40) });
  const queued = [
    { ...first, status: "ready" as const, promotion: { queuePosition: 0, queueLease: { ownerId: "owner", epoch: 1, acquiredAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T00:01:00.000Z" } } },
    { ...second, status: "ready" as const, promotion: { queuePosition: 1 } },
  ];
  assert.equal(selectPromotionQueueHead(queued)?.stableId, first.stableId);
  const staging = { branch: "staging", sha: "b".repeat(40), baselineSha: "b".repeat(40), idle: true, checkedAt: "2026-08-30T00:00:01.000Z" };
  const receipt = workOrderPromotionReceipt({ shippingPullNumber: 12, sourceHeadSha: "c".repeat(40), stagingBaseSha: staging.sha, mergeBaseSha: staging.sha, mergeCommitSha: "d".repeat(40), reviewedAt: staging.checkedAt });
  assert.deepEqual(evaluateWorkOrderPromotion({ lane: queued[0]!, ownerId: "owner", now: staging.checkedAt, sourceHeadSha: receipt.sourceHeadSha, mergeBaseSha: receipt.mergeBaseSha, staging, reviewPassed: true, verificationPassed: true, mergeable: true, authorityValid: true, mergeCommit: true }), { allowed: true, laneId: first.stableId });
  assert.equal(evaluateWorkOrderPromotion({ lane: queued[1]!, ownerId: "owner", now: staging.checkedAt, sourceHeadSha: receipt.sourceHeadSha, mergeBaseSha: receipt.mergeBaseSha, staging, reviewPassed: true, verificationPassed: true, mergeable: true, authorityValid: true, mergeCommit: true }).allowed, false);
});
