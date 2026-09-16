import assert from "node:assert/strict";
import test from "node:test";

import { buildDependencyGraph, isSatisfiedOwnerResult, selectReviewRoster } from "../../src/candidate/planning.ts";

test("uses explicit and exact mutation conflicts, not domain proximity", () => {
  const graph = buildDependencyGraph([
    { number: 2, title: "same domain", mutationFiles: ["src/a.ts"] },
    { number: 3, title: "exact conflict", mutationFiles: ["src/a.ts"] },
    { number: 4, title: "same domain only", mutationFiles: ["src/b.ts"] },
    { number: 5, title: "explicit", dependsOn: [4], mutationFiles: ["src/c.ts"] },
  ]);
  assert.deepEqual(graph.map((issue) => issue.number), [2, 3, 4, 5]);
  assert.deepEqual(graph.find((issue) => issue.number === 3)?.predecessors, ["issue-2"]);
  assert.deepEqual(graph.find((issue) => issue.number === 4)?.predecessors, []);
  assert.deepEqual(graph.find((issue) => issue.number === 5)?.predecessors, ["issue-4"]);
});

test("retains explicit dependencies outside the selected set", () => {
  const graph = buildDependencyGraph([{ number: 9, dependsOn: [99] }]);
  assert.deepEqual(graph[0]?.externalDependencies, [99]);
});

test("detects cycles before dispatch", () => {
  assert.throws(
    () => buildDependencyGraph([{ number: 1, dependsOn: [2] }, { number: 2, dependsOn: [1] }]),
    /dependency cycle/,
  );
});

test("selects the smallest risk-justified roster", () => {
  assert.deepEqual(selectReviewRoster({}), {
    roles: ["correctness"],
    rationale: ["Correctness reviewer covers original acceptance, relevant interfaces, regression risk, and proof quality."],
  });
  assert.equal(selectReviewRoster({ materialSecurityBoundary: true, specialistQuestion: "API compatibility" }).roles.length, 3);
});

test("requires the exact terminal owner result for dependency release", () => {
  assert.equal(isSatisfiedOwnerResult("FORGE_WORK_ON_RESULT status=DONE issue=1 pr=2 dependency=SATISFIED"), true);
  assert.equal(isSatisfiedOwnerResult("transport completed for issue 1"), false);
  assert.equal(isSatisfiedOwnerResult("FORGE_WORK_ON_RESULT status=DONE issue=1 pr=2 dependency=UNSATISFIED"), false);
});
