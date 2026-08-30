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
  assert.throws(() => validateGitRef("@"), /Invalid Git ref/);
  assert.throws(() => validateGitRef("refs/heads/release.lock"), /Invalid Git ref/);
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
  assert.throws(
    () => createIntegrationLane({
      ...base,
      kind: "milestone",
      stableId: "milestone-1",
      slug: "lane",
      branch: "milestone/lane",
      frozenBase: { ...base.frozenBase, branch: "release.lock" },
    }),
    /Invalid Git ref/,
  );
});

test("slug and branch helpers expose stable boundary behavior", () => {
  assert.equal(normalizeIntegrationSlug(" A___lane!!! "), "a-lane");
  assert.equal(workOrderBranchName("wo-1", "A lane"), "work-order/wo-1-a-lane");
});
