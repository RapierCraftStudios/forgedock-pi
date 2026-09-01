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
      { id: "alpha:13", number: 13, repo: "alpha", title: "second", affectedFile: "src/shared.ts", labels: ["priority:P3"] },
      { id: "alpha:14", number: 14, repo: "alpha", title: "singleton", affectedFile: "src/other.ts", labels: ["priority:P3"] },
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
    candidates: [
      { id: "alpha:12", number: 12, repo: "alpha", affectedFile: "src/shared.ts", labels: ["priority:P3"] },
      { id: "alpha:13", number: 13, repo: "alpha", affectedFile: "src/shared.ts", labels: ["priority:P3"] },
      { id: "beta:12", number: 12, repo: "beta", affectedFile: "src/shared.ts", labels: ["priority:P3"] },
      { id: "beta:13", number: 13, repo: "beta", affectedFile: "src/shared.ts", labels: ["priority:P3"] },
    ],
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
      { id: "org:31", number: 31, repo: "org", title: "SSRF protection", affectedFile: "src/security.ts", labels: ["priority:P3"] },
      { id: "org:32", number: 32, repo: "org", title: "SSRF validation", affectedFile: "src/security.ts", labels: ["priority:P3"] },
      { id: "org:33", number: 33, repo: "org", title: "credential leak", affectedFile: "src/security.ts", labels: ["priority:P3"] },
      { id: "org:34", number: 34, repo: "org", title: "credential handling", affectedFile: "src/security.ts", labels: ["priority:P3"] },
    ],
    openBatches: [],
  });

  assert.deepEqual(plan.create, [
    { kind: "same-file", key: "src/security.ts", memberIds: ["org:31", "org:32"] },
    { kind: "same-file", key: "src/security.ts", memberIds: ["org:33", "org:34"] },
  ]);
});

test("returns stable IDs for open-batch extensions", () => {
  const plan = planP3Batches({
    candidates: [
      { id: "org:21", number: 21, repo: "org", affectedFile: "src/shared.ts", labels: ["priority:P3"] },
    ],
    openBatches: [{ number: 99, affectedFile: "src/shared.ts", memberIds: ["org:20"], memberCount: 1, safetyClass: "routine" }],
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
    candidates: [
      { id: "org:22", number: 22, repo: "org", title: "routine maintenance", affectedFile: "src/shared.ts", labels: ["priority:P3"] },
    ],
    openBatches: [{ number: 99, repo: "org", affectedFile: "src/shared.ts", memberIds: ["org:20"] }],
  });

  assert.deepEqual(plan.extend, []);
  assert.deepEqual(plan.ungrouped, [{ memberId: "org:22", reason: "no matching batch threshold" }]);
});

test("does not extend an open batch across safety classes", () => {
  const plan = planP3Batches({
    candidates: [
      { id: "org:41", number: 41, repo: "org", title: "SSRF protection", affectedFile: "src/security.ts", labels: ["priority:P3"] },
    ],
    openBatches: [{ number: 99, repo: "org", affectedFile: "src/security.ts", memberIds: ["org:40"], safetyClass: "credential" }],
  });

  assert.deepEqual(plan.extend, []);
  assert.deepEqual(plan.ungrouped, [{ memberId: "org:41", reason: "no matching batch threshold" }]);
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
