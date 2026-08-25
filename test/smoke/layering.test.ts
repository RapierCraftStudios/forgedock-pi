import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent runtime no longer imports workflow-layer authority", async () => {
  const childRuntime = await readFile("src/agents/child-runtime.ts", "utf8");
  assert.doesNotMatch(childRuntime, /from ["']\.\.\/workflows\//);
  assert.match(childRuntime, /from "\.\.\/adapters\/run-journal\.ts"/);
});

test("authority-sensitive seams are source-discoverable modules", async () => {
  for (const path of [
    "src/agents/child-containment.ts",
    "src/core/builder-contract.ts",
    "src/workflows/remediation.ts",
    "src/workflows/review-findings.ts",
    "src/adapters/run-journal.ts",
  ]) {
    const source = await readFile(path, "utf8");
    assert.ok(source.length > 100, `${path} should contain its extracted seam`);
  }
});
