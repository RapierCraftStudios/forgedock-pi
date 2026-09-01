import assert from "node:assert/strict";
import test from "node:test";

// The package ships this JavaScript helper as a runtime asset without TypeScript declarations.
// @ts-expect-error -- runtime ESM helper intentionally has no declaration file.
const admission = await import("../../specs/original/bin/engine/admission.mjs");
const { planP3Batches, planP3BatchGroups, summarizeP3BatchPlan } = admission;

test("exports the documented object-form batching API", () => {
  assert.equal(typeof planP3Batches, "function");
  assert.equal(typeof summarizeP3BatchPlan, "function");

  const plan = planP3Batches({ candidates: [], openBatches: [] });
  assert.deepEqual(plan, { create: [], extend: [], ungrouped: [] });
});

test("preserves repository-qualified IDs in create actions and summaries", () => {
  const plan = planP3Batches({
    candidates: [
      { id: "alpha:12", number: 12, repo: "alpha", title: "first", affectedFile: "src/shared.ts", labels: ["priority:P3"] },
      { id: "beta:12", number: 12, repo: "beta", title: "second", affectedFile: "src/shared.ts", labels: ["priority:P3"] },
      { id: "alpha:13", number: 13, repo: "alpha", title: "singleton", affectedFile: "src/other.ts", labels: ["priority:P3"] },
    ],
    openBatches: [],
  });

  assert.deepEqual(plan.create, [
    { kind: "same-file", key: "src/shared.ts", memberIds: ["alpha:12", "beta:12"] },
  ]);
  assert.deepEqual(plan.ungrouped, [{ memberId: "alpha:13", reason: "no matching batch threshold" }]);
  assert.deepEqual(summarizeP3BatchPlan(plan), {
    clustersFormed: 1,
    membersAbsorbed: 2,
    openBatchesExtended: 0,
    ungroupedMembers: [{ memberId: "alpha:13", reason: "no matching batch threshold" }],
  });
});

test("returns stable IDs for open-batch extensions", () => {
  const plan = planP3Batches({
    candidates: [
      { id: "org:21", number: 21, repo: "org", affectedFile: "src/shared.ts", labels: ["priority:P3"] },
    ],
    openBatches: [{ number: 99, affectedFile: "src/shared.ts", memberIds: ["org:20"], memberCount: 1 }],
  });

  assert.deepEqual(plan.extend, [{ batch: 99, key: "src/shared.ts", memberIds: ["org:21"] }]);
  assert.deepEqual(summarizeP3BatchPlan(plan), {
    clustersFormed: 0,
    membersAbsorbed: 0,
    openBatchesExtended: 1,
    ungroupedMembers: [],
  });
});

test("keeps the legacy array-form planner available", () => {
  const plan = planP3BatchGroups(
    [
      { number: 1, affectedFile: "src/shared.ts", labels: ["priority:P3"] },
      { number: 2, affectedFile: "src/shared.ts", labels: ["priority:P3"] },
    ],
  );
  assert.deepEqual(plan.groups, [{ kind: "same-file", key: "src/shared.ts", members: [1, 2] }]);
});
