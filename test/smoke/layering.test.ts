import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent runtime no longer imports workflow-layer authority", async () => {
  const childRuntime = await readFile("src/agents/child-runtime.ts", "utf8");
  assert.doesNotMatch(childRuntime, /from ["']\.\.\/workflows\//);
  assert.match(childRuntime, /from "\.\.\/adapters\/run-journal\.ts"/);
});

test("session shutdown detaches active runs instead of cancelling durable work", async () => {
  const entrypoint = await readFile("src/index.ts", "utf8");
  assert.match(entrypoint, /pi\.on\("session_shutdown"/);
  assert.doesNotMatch(entrypoint, /shutdownStandalone/);
  assert.doesNotMatch(entrypoint, /orchestrator\.shutdown/);
  assert.match(entrypoint, /controller\.dispose\(\)/);
  assert.match(entrypoint, /orchestrator\.dispose\(\)/);
  const workOn = await readFile("src/workflows/work-on.ts", "utf8");
  assert.match(workOn, /sendUserMessage\(\s*directRunResumeTask/);
  assert.match(workOn, /#recoverDirectTerminal\(/);
  assert.match(workOn, /directRunRecoveryAction/);
  const terminalRecovery = workOn.slice(
    workOn.indexOf("async #recoverDirectTerminal"),
    workOn.indexOf("async #finalize"),
  );
  assert.ok(
    terminalRecovery.indexOf('if (action === "release-authority")') <
      terminalRecovery.indexOf("const evidence = directTerminalEvidence"),
    "completed authority release must not require PR or merge evidence",
  );
  assert.match(workOn, /Do not create another run, worktree, branch, commit, or PR/);
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
