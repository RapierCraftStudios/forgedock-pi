/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { createWorkOrderLane } from "../../src/workflows/orchestrate.ts";

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
