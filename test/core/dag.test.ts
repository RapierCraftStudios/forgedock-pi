import assert from "node:assert/strict";
import test from "node:test";

import { buildDag, findDagCycle, getReadyQueue } from "../../src/core/dag.ts";

const nodes = [
  { id: "a", priority: 1 },
  { id: "b", priority: 5 },
  { id: "c", priority: 3 },
];

test("DAG detects cycles", () => {
  const dag = buildDag(nodes, [
    { from: "a", to: "b", kind: "explicit", reason: "b needs a" },
    { from: "b", to: "a", kind: "contract", reason: "a needs b" },
  ]);
  assert.deepEqual(findDagCycle(dag), { nodeIds: ["a", "b"] });
});

test("ready queue respects dependencies, active capacity, and priority", () => {
  const dag = buildDag(nodes, [
    { from: "a", to: "b", kind: "explicit", reason: "b needs a" },
  ]);
  assert.equal(findDagCycle(dag), undefined);
  assert.deepEqual(
    getReadyQueue(dag, {
      completed: new Set(),
      active: new Set(),
      blocked: new Set(),
      limit: 2,
    }).map((node) => node.id),
    ["c", "a"],
  );
  assert.deepEqual(
    getReadyQueue(dag, {
      completed: new Set(["a"]),
      active: new Set(["c"]),
      blocked: new Set(),
      limit: 2,
    }).map((node) => node.id),
    ["b"],
  );
});
