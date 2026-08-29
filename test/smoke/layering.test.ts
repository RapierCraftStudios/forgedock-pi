import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent runtime no longer imports workflow-layer authority", async () => {
  const childRuntime = await readFile("src/agents/child-runtime.ts", "utf8");
  assert.doesNotMatch(childRuntime, /from ["']\.\.\/workflows\//);
  assert.match(childRuntime, /from "\.\.\/adapters\/run-journal\.ts"/);
});

test("entrypoint exposes lexical routing plus deterministic runtime safety tools", async () => {
  const entrypoint = await readFile("src/index.ts", "utf8");
  assert.match(entrypoint, /registerForgePromptRouter\(pi\)/);
  assert.match(entrypoint, /registerForgeRuntimeTools\(pi\)/);
  assert.doesNotMatch(entrypoint, /ForgeWorkOnController/);
  assert.doesNotMatch(entrypoint, /ForgeOrchestrationController/);
  assert.doesNotMatch(entrypoint, /ForgeReviewController/);
  assert.doesNotMatch(entrypoint, /registerForgeCommands/);

  const router = await readFile("src/prompt-router.ts", "utf8");
  assert.match(router, /pi\.on\("input"/);
  assert.doesNotMatch(router, /registerCommand/);
  assert.doesNotMatch(router, /registerTool/);
  assert.doesNotMatch(router, /pi\.exec/);
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
