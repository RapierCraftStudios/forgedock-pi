import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("reviewer publication persists structured observations inside the prepared root", async () => {
  const root = await mkdtemp("/tmp/forgedock-reviewer-tools-");
  const priorRunId = process.env.PI_SUBAGENT_RUN_ID;
  try {
    const workflowPath = join(root, "workflow.js");
    const commonPath = join(root, "review.json");
    const authorizationPath = join(root, "correctness.authorization.json");
    await writeFile(workflowPath, "const assignments = [];\n");
    const workflowSha256 = createHash("sha256").update(await readFile(workflowPath)).digest("hex");
    await writeFile(commonPath, JSON.stringify({ schema: "forgedock.candidate-review/v1", artifactRoot: root, artifactKey: "review-key", repository: "example/product", pullRequest: 7, head: "a".repeat(40), baseRef: "integration", baseSha: "b".repeat(40), publish: false, roles: ["correctness"], roleArtifactKeys: { correctness: "role-key" }, workflowPath, workflowSha256 }));
    await writeFile(authorizationPath, JSON.stringify({ schema: "forgedock.candidate-review-role/v1", artifactRoot: root, artifactKey: "role-key", role: "correctness", repository: "example/product", pullRequest: 7, head: "a".repeat(40), baseRef: "integration", baseSha: "b".repeat(40), publish: false }));
    const tools = new Map<string, any>();
    let callArgs: string[] = [];
    const fakePi = {
      registerTool(definition: any) { tools.set(definition.name, definition); },
      async exec(_name: string, args: string[]) { callArgs = args; return { code: 0, stdout: JSON.stringify({ publication: "saved" }), stderr: "" }; },
    };
    process.env.PI_SUBAGENT_RUN_ID = "child-native-run-1";
    const module = await import("../../candidate/reviewer-tools.ts");
    module.default(fakePi as never);
    const result = await tools.get("forge_publish_reviewer").execute("publish", {
      repository: "example/product", pullRequest: 7, head: "a".repeat(40), baseRef: "integration", baseSha: "b".repeat(40), role: "correctness", body: "### Scope and decisions considered\\nReviewed.\\n\\n### Evidence and findings\\nOne observation.\\n\\n### Verification limitations\\nFixture.\\n\\n### Recommendation\\nParent adjudication.", bodyPath: join(root, "correctness.body.md"), reportPath: join(root, "correctness.report.md"), reviewRoot: root, authorizationPath, artifactKey: "role-key", publish: false, observations: [{ id: "correctness:F1", kind: "code-defect", summary: "Observed behavior", affectedBehavior: "Consumer behavior", evidence: ["A focused fixture reproduces it."], trigger: "Input is malformed.", consequence: "The consumer rejects valid data.", whyThisChange: "The path is changed by this patch.", stage: "current review", proposedDisposition: "IMMEDIATE REPAIR" }],
    });
    assert.equal(result.details.publication, "saved");
    assert.equal(result.details.nativeRunId, "child-native-run-1");
    assert.ok(callArgs.includes("--observations-file"));
    const recovery = JSON.parse(await readFile(join(root, "correctness.publication-recovery.json"), "utf8"));
    assert.equal(recovery.state, "saved");
    assert.equal(recovery.roleArtifactKey, "role-key");
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
    await assert.rejects(tools.get("forge_publish_reviewer").execute("missing", { role: "correctness", body: "x".repeat(32) }), /observations array/);
    assert.match(await readFile(join(root, "correctness.observations.json"), "utf8"), /correctness:F1/);
  } finally {
    if (priorRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
    else process.env.PI_SUBAGENT_RUN_ID = priorRunId;
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate package includes a source-read-only reviewer and publication-only tool", async () => {
  const agent = await readFile("candidate/agents/forgedock-reviewer.md", "utf8");
  const tool = await readFile("candidate/reviewer-tools.ts", "utf8");
  assert.match(agent, /^tools: read, grep, find, ls, forge_publish_reviewer$/m);
  assert.match(agent, /^subagentOnlyExtensions: \.\.\/reviewer-tools\.ts$/m);
  assert.doesNotMatch(agent, /^tools:.*\b(?:bash|edit|write)\b/m);
  assert.match(tool, /name: "forge_publish_reviewer"/);
  assert.match(tool, /reviewRoot/);
  assert.match(tool, /artifactKey/);
  assert.match(tool, /assertUnderRoot/);
  assert.match(tool, /observations/);
  assert.match(tool, /pi\.exec\("node"/);
});
