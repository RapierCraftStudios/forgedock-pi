import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The packaged CLI is intentionally plain ESM without a declaration file.
import * as planner from "../../specs/original/bin/orchestrate-preflight.mjs";

const { buildPlan, classifyInput, extractAffectedFiles, findCycle } = planner;

test("compact planner accepts only an unambiguous literal issue list", () => {
  assert.deepEqual(classifyInput("#12 13 --auto"), {
    kind: "literal",
    pattern: "literal-numbers",
    tokens: ["#12", "13"],
    numbers: [12, 13],
  });
  assert.equal(classifyInput("next 3").kind, "query");
  assert.equal(classifyInput("#12 #12").kind, "invalid");
});

test("compact planner extracts scoped affected files with provenance", () => {
  const result = extractAffectedFiles(
    { body: "## Affected Files\n- `src/fallback.ts`" },
    [],
  );
  assert.deepEqual(result, {
    provenance: "body-fallback",
    files: ["src/fallback.ts"],
  });
  assert.deepEqual(
    extractAffectedFiles(
      { body: "## Affected Files\n- `src/body.ts`" },
      [{ body: "<!-- FORGE:INVESTIGATOR -->\n### Affected Files\n- `src/found.ts`\n### Evidence\n- `src/evidence.ts`" }],
    ),
    { provenance: "affected-files-section", files: ["src/found.ts"] },
  );
});

test("compact planner visibly gates dependency cycles", () => {
  assert.deepEqual(
    findCycle(["1", "2"], [
      { from: "1", to: "2" },
      { from: "2", to: "1" },
    ]),
    ["1", "2"],
  );
  const issues = [
    { number: 1, title: "one", body: "Blocked by #2", dependencies: [2], externalDependencies: [], affected: { files: [] }, eligible: true, priority: 1 },
    { number: 2, title: "two", body: "Depends on #1", dependencies: [1], externalDependencies: [], affected: { files: [] }, eligible: true, priority: 1 },
  ];
  assert.equal(buildPlan(issues, 4, "staging").cycleCheck.detected, true);
  assert.deepEqual(buildPlan(issues, 4, "staging").readyQueue, []);
});
