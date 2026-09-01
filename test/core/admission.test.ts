import assert from "node:assert/strict";
import test from "node:test";

// The package ships this JavaScript helper as a runtime asset without TypeScript declarations.
// @ts-expect-error -- runtime ESM helper intentionally has no declaration file.
const admission = await import("../../specs/original/bin/engine/admission.mjs");
const { planP3Batches, planP3BatchGroups, summarizeP3BatchPlan } = admission;

const p3 = ["review-finding", "priority:P3"];

function candidate(id: string, overrides: Record<string, unknown> = {}) {
  const [repo, number] = id.split(":");
  return {
    id,
    repo,
    number: Number(number),
    title: "routine maintenance",
    affectedFile: "src/shared.ts",
    labels: p3,
    ...overrides,
  };
}

test("exports the documented object-form batching API", () => {
  assert.equal(typeof planP3Batches, "function");
  assert.equal(typeof summarizeP3BatchPlan, "function");

  const plan = planP3Batches({ candidates: [], openBatches: [] });
  assert.deepEqual(plan, { create: [], extend: [], ungrouped: [] });
});

test("preserves repository-qualified IDs in create actions and summaries", () => {
  const plan = planP3Batches({
    candidates: [
      candidate("alpha:12"),
      candidate("alpha:13"),
      candidate("alpha:14", { affectedFile: "src/other.ts" }),
    ],
    openBatches: [],
  });

  assert.deepEqual(plan.create, [
    { kind: "same-file", key: "src/shared.ts", memberIds: ["alpha:12", "alpha:13"] },
  ]);
  assert.deepEqual(plan.ungrouped, [{ memberId: "alpha:14", reason: "no matching batch threshold" }]);
  assert.deepEqual(summarizeP3BatchPlan(plan), {
    clustersFormed: 1,
    membersAbsorbed: 2,
    openBatchesExtended: 0,
    ungroupedMembers: [{ memberId: "alpha:14", reason: "no matching batch threshold" }],
  });
});

test("does not combine same-file candidates across repositories", () => {
  const plan = planP3Batches({
    candidates: [candidate("alpha:12"), candidate("alpha:13"), candidate("beta:12"), candidate("beta:13")],
    openBatches: [],
  });

  assert.deepEqual(plan.create, [
    { kind: "same-file", key: "src/shared.ts", memberIds: ["alpha:12", "alpha:13"] },
    { kind: "same-file", key: "src/shared.ts", memberIds: ["beta:12", "beta:13"] },
  ]);
});

test("keeps security findings in same-class groups", () => {
  const plan = planP3Batches({
    candidates: [
      candidate("org:31", { title: "SSRF protection", affectedFile: "src/security.ts" }),
      candidate("org:32", { title: "SSRF validation", affectedFile: "src/security.ts" }),
      candidate("org:33", { title: "credential leak", affectedFile: "src/security.ts" }),
      candidate("org:34", { title: "credential handling", affectedFile: "src/security.ts" }),
    ],
    openBatches: [],
  });

  assert.deepEqual(plan.create, [
    { kind: "same-file", key: "src/security.ts", memberIds: ["org:31", "org:32"] },
    { kind: "same-file", key: "src/security.ts", memberIds: ["org:33", "org:34"] },
  ]);
});

test("caps a same-class security batch at three members", () => {
  const plan = planP3Batches({
    candidates: [1, 2, 3, 4].map((number) => candidate(`org:${number}`, { title: "SSRF validation" })),
    openBatches: [],
  });

  assert.deepEqual(plan.create, [{
    kind: "same-file",
    key: "src/shared.ts",
    memberIds: ["org:1", "org:2", "org:3"],
  }]);
  assert.deepEqual(plan.ungrouped, [{ memberId: "org:4", reason: "no matching batch threshold" }]);
});

test("applies review-finding P3 eligibility and keeps exclusions observable", () => {
  const plan = planP3Batches({
    candidates: [
      candidate("org:1", { labels: ["priority:P3"] }),
      candidate("org:2", { labels: ["review-finding", "priority:P2"] }),
      candidate("org:3", { labels: [...p3, "needs-human"] }),
      candidate("org:4", { title: "billing correction", affectedFile: "src/billing.ts" }),
      candidate("org:5", { affectedFile: "" }),
    ],
    openBatches: [],
  });

  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.ungrouped, [
    { memberId: "org:1", reason: "not a review-finding" },
    { memberId: "org:2", reason: "not priority P3" },
    { memberId: "org:3", reason: "human-gated" },
    { memberId: "org:4", reason: "domain" },
    { memberId: "org:5", reason: "missing affected file" },
  ]);
});

test("groups a stale leaf-directory singleton but retains a fresh singleton", () => {
  const now = Date.parse("2026-09-04T00:00:00Z");
  const plan = planP3Batches({
    now,
    candidates: [
      candidate("org:1", { affectedFile: "src/stale/one.ts", createdAt: "2026-08-31T23:59:59Z" }),
      candidate("org:2", { affectedFile: "src/fresh/one.ts", createdAt: "2026-09-03T23:59:59Z" }),
    ],
    openBatches: [],
  });

  assert.deepEqual(plan.create, [{ kind: "leaf-directory", key: "src/stale", memberIds: ["org:1"] }]);
  assert.deepEqual(plan.ungrouped, [{ memberId: "org:2", reason: "no matching batch threshold" }]);
});

test("returns stable IDs for open-batch extensions", () => {
  const plan = planP3Batches({
    candidates: [candidate("org:21")],
    openBatches: [{ number: 99, repo: "org", affectedFile: "src/shared.ts", memberIds: ["org:20"], memberCount: 1, safetyClass: "routine" }],
  });

  assert.deepEqual(plan.extend, [
    { batch: 99, batchId: "org:99", key: "src/shared.ts", memberIds: ["org:21"] },
  ]);
  assert.deepEqual(summarizeP3BatchPlan(plan), {
    clustersFormed: 0,
    membersAbsorbed: 1,
    openBatchesExtended: 1,
    ungroupedMembers: [],
  });
});

test("does not extend an open batch with unknown safety metadata", () => {
  const plan = planP3Batches({
    candidates: [candidate("org:22")],
    openBatches: [{ number: 99, repo: "org", affectedFile: "src/shared.ts", memberIds: ["org:20"] }],
  });

  assert.deepEqual(plan.extend, []);
  assert.deepEqual(plan.ungrouped, [{ memberId: "org:22", reason: "no matching batch threshold" }]);
});

test("does not extend an open batch across safety classes", () => {
  const plan = planP3Batches({
    candidates: [candidate("org:41", { title: "SSRF protection" })],
    openBatches: [{ number: 99, repo: "org", affectedFile: "src/shared.ts", memberIds: ["org:40"], safetyClass: "credential" }],
  });

  assert.deepEqual(plan.extend, []);
  assert.deepEqual(plan.ungrouped, [{ memberId: "org:41", reason: "no matching batch threshold" }]);
});

test("keeps the legacy array-form planner available", () => {
  const plan = planP3BatchGroups([
    { number: 1, affectedFile: "src/shared.ts", labels: ["priority:P3"] },
    { number: 2, affectedFile: "src/shared.ts", labels: ["priority:P3"] },
  ]);
  assert.deepEqual(plan.groups, [{ kind: "same-file", key: "src/shared.ts", members: [1, 2] }]);
});
