/// <reference path="../../node_modules/@types/node/index.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  createIntegrationLane,
  normalizeIntegrationSlug,
  validateGitRef,
  validateIntegrationLane,
  workOrderBranchName,
  type IntegrationLane,
} from "../../src/core/integration-lane.ts";

const base = {
  repository: "owner/repo",
  frozenBase: { branch: "main", sha: "0123456789abcdef0123456789abcdef01234567" },
  membership: [{ issueNumber: 7, ordinal: 0 }],
  sourceQuery: "priority:P1",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  status: "queued" as const,
};

test("work-order identity and branch normalization are deterministic and bounded", () => {
  const first = createIntegrationLane({
    ...base,
    kind: "work-order",
    stableId: "wo-297",
    slug: "Shared Integration Lane / Work Order",
  });
  const second = createIntegrationLane({
    ...base,
    kind: "work-order",
    stableId: "wo-297",
    slug: "shared-integration-lane-work-order",
  });
  assert.equal(first.branch, "work-order/wo-297-shared-integration-lane-work-order");
  assert.equal(first.branch, second.branch);
  assert.ok(first.branch.length <= 240);
  assert.equal(first.schema, "forgedock.integration-lane/v1");
});

test("milestone lanes retain their explicit branch and promotion metadata", () => {
  const lane = createIntegrationLane({
    ...base,
    kind: "milestone",
    stableId: "milestone-1",
    slug: "release one",
    branch: "milestone/release-one",
    promotion: { queuePosition: 0, stagingBranch: "staging" },
  });
  assert.equal(lane.kind, "milestone");
  assert.deepEqual(lane.promotion, { queuePosition: 0, stagingBranch: "staging" });
});

test("invalid refs and malformed lanes fail closed", () => {
  assert.throws(() => validateGitRef("work-order/../unsafe"), /Invalid Git ref/);
  assert.throws(
    () => createIntegrationLane({ ...base, kind: "work-order", stableId: "WO 297", slug: "lane" }),
    /stableId/,
  );
  assert.throws(
    () => createIntegrationLane({ ...base, kind: "work-order", stableId: "wo-297", frozenBase: { branch: "main", sha: "abcdef1" } }),
    /exact commit SHA|frozen base/i,
  );
  const malformed = {
    ...createIntegrationLane({ ...base, kind: "work-order", stableId: "wo-297", slug: "lane" }),
    branch: "work-order/other-lane",
  } as IntegrationLane;
  assert.throws(() => validateIntegrationLane(malformed), /branch/);
});

test("slug and branch helpers expose stable boundary behavior", () => {
  assert.equal(normalizeIntegrationSlug(" A___lane!!! "), "a-lane");
  assert.equal(workOrderBranchName("wo-1", "A lane"), "work-order/wo-1-a-lane");
});

test("queue lease and promotion lifecycle is guarded and requires a merge commit", async () => {
  const { canPromoteIntegrationLane, transitionIntegrationLane, validatePromotionQueue } = await import("../../src/core/integration-lane.ts");
  const lane = createIntegrationLane({ ...base, kind: "work-order", stableId: "wo-1", slug: "one" });
  const queued = transitionIntegrationLane(lane, "queue", { now: "2026-08-30T00:00:01.000Z", queuePosition: 0 });
  const leased = transitionIntegrationLane(queued, "acquire-queue-lease", { now: "2026-08-30T00:00:02.000Z", ownerId: "orchestrator-1", leaseSeconds: 60 });
  const staging = { branch: "staging", sha: "a".repeat(40), baselineSha: "a".repeat(40), idle: true, checkedAt: "2026-08-30T00:00:03.000Z" };
  const ready = transitionIntegrationLane(leased, "sync", { now: staging.checkedAt, ownerId: "orchestrator-1", leaseEpoch: 1, staging });
  validatePromotionQueue([ready]);
  assert.deepEqual(canPromoteIntegrationLane(ready, { ownerId: "wrong-owner", now: staging.checkedAt, sourceHeadSha: "b".repeat(40), mergeBaseSha: staging.sha, staging, reviewPassed: true, verificationPassed: true, mergeable: true, authorityValid: true, mergeCommit: true }), { ok: false, reason: "Queue-head lease is missing, stale, or owned by another lane." });
  const receipt = { shippingPullNumber: 44, sourceHeadSha: "b".repeat(40), stagingBaseSha: staging.sha, mergeBaseSha: staging.sha, mergeCommitSha: "c".repeat(40), mergeMethod: "merge" as const, reviewedAt: staging.checkedAt };
  const promoted = transitionIntegrationLane(ready, "promote", { now: staging.checkedAt, ownerId: "orchestrator-1", leaseEpoch: 1, queueHeadLaneId: "wo-1", staging, receipt, reviewPassed: true, verificationPassed: true, mergeable: true, authorityValid: true, mergeCommit: true });
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.promotion.receipt?.mergeMethod, "merge");
  assert.equal(transitionIntegrationLane(promoted, "close", { now: "2026-08-30T00:00:04.000Z" }).status, "closed");
  assert.throws(() => transitionIntegrationLane(ready, "promote", { now: staging.checkedAt, ownerId: "orchestrator-1", leaseEpoch: 1, queueHeadLaneId: "wo-1", staging: { ...staging, sha: "d".repeat(40) }, receipt, reviewPassed: true, verificationPassed: true, mergeable: true, authorityValid: true, mergeCommit: true }), /staging.*match/i);
  assert.throws(() => validateIntegrationLane({ ...ready, promotion: [] } as unknown as IntegrationLane), /promotion/i);
});
