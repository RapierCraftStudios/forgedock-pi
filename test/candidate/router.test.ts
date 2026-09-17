import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FORGEDOCK_ALIASES, isStagingMutationBlocked, rewriteForgePromptAlias } from "../../candidate/extension.ts";

test("accepts only a prepared read-only staging reviewer workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-staging-router-"));
  try {
    const workflowPath = join(root, "workflow.js");
    const workflow = 'return (await runs.all([{ key: "review-correctness", agent: "forgedock-reviewer", task: "Review original acceptance: [\\"exact-head\\"]", model: "m", context: "fresh", cwd: "/tmp", worktree: false, output: false, artifacts: true, acceptance: false, maxRuntimeMs: 1 }])));\n';
    await writeFile(workflowPath, workflow);
    await writeFile(join(root, "review.json"), JSON.stringify({
      schema: "forgedock.candidate-review/v1",
      artifactRoot: root,
      workflowPath,
      workflowSha256: createHash("sha256").update(workflow).digest("hex"),
      artifactKey: "review-key",
      roles: ["correctness"],
    }));
    assert.equal(isStagingMutationBlocked("subagent", { workflowScriptPath: workflowPath }), false);
    await writeFile(workflowPath, workflow.replace("acceptance: false", "acceptance: true"));
    assert.equal(isStagingMutationBlocked("subagent", { workflowScriptPath: workflowPath }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routes only the familiar candidate commands", () => {
  assert.equal(rewriteForgePromptAlias("/work-on 42"), "/skill:forgedock-work-on 42");
  assert.equal(rewriteForgePromptAlias("/forge:orchestrate next 2"), "/skill:forgedock-orchestrate next 2");
  assert.equal(rewriteForgePromptAlias("/review-pr-staging 9"), "/skill:forgedock-review-pr-staging 9");
  assert.equal(rewriteForgePromptAlias("/quality-gate 1"), undefined);
  assert.equal(Object.keys(FORGEDOCK_ALIASES).length, 4);
  assert.equal(isStagingMutationBlocked("write", { path: "src/app.ts" }), true);
  assert.equal(isStagingMutationBlocked("bash", { command: "git push origin staging" }), true);
  assert.equal(isStagingMutationBlocked("bash", { command: "npm test" }), true);
  assert.equal(isStagingMutationBlocked("forge_run_check", { name: "test" }), false);
  assert.equal(isStagingMutationBlocked("subagent", { agent: "forgedock-owner" }), true);
  assert.equal(isStagingMutationBlocked("subagent", { agent: "forgedock-reviewer" }), true);
  assert.equal(isStagingMutationBlocked("subagent", { workflowScript: 'return runs.run("review", { agent: "forgedock-reviewer" })' }), true);
  assert.equal(isStagingMutationBlocked("unknown", {}), true);
});
