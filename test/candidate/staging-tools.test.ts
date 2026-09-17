import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import registerCandidateTools from "../../candidate/tools.ts";

test("staging publication requires prepared reviewer and check evidence", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-staging-tools-");
  try {
    const head = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const key = "prepared-key";
    await writeFile(join(root, "review.json"), JSON.stringify({
      schema: "forgedock.candidate-review/v1",
      artifactRoot: root,
      artifactKey: key,
      repository: "example/product",
      pullRequest: 7,
      head,
      baseRef: "main",
      baseSha,
      sourceRoot: "/tmp/example/source",
      publish: false,
      roles: ["correctness"],
      configPath: "/tmp/example/forge.yaml",
      configSha256: "c".repeat(64),
      config: { verificationCommands: { test: "npm test" } },
    }));
    await writeFile(join(root, "correctness.report.md"), `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ repository: "example/product", pullRequest: 7, head, baseRef: "main", baseSha, role: "correctness" })} -->\nclean report\n`);
    await mkdir(join(root, "checks"));
    await writeFile(join(root, "checks", "test.json"), JSON.stringify({ schema: "forgedock.candidate-check/v1", name: "test", status: "passed", head, sourceRoot: "/tmp/example/source", configPath: "/tmp/example/forge.yaml", configSha256: "c".repeat(64) }));

    const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
    const fakePi = {
      registerTool(definition: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) { tools.set(definition.name, definition); },
      async exec() { return { code: 0, stdout: "saved", stderr: "", killed: false }; },
    };
    registerCandidateTools(fakePi as never);
    const tool = tools.get("forge_publish_record");
    assert.ok(tool);
    const result = await tool.execute("call", {
      repository: "example/product",
      pullRequest: 7,
      kind: "STAGING_GATE",
      head,
      baseRef: "main",
      baseSha,
      gate: "PASS",
      checks: ["test"],
      reviewRoot: root,
      artifactKey: key,
      body: "FORGE:STAGING_GATE:PASS\nAll prepared evidence is complete.",
      publish: false,
      policy: {
        schema: "forgedock.candidate-pr-policy/v1",
        repository: "example/product",
        pullRequest: 7,
        identity: { head, baseRef: "main", baseSha },
        policy: { evaluatedRequiredChecks: { status: "available", exitCode: 0, data: [{ name: "CI", state: "SUCCESS", bucket: "pass" }] } },
      },
    });
    assert.ok(result);
    await assert.rejects(
      tool.execute("missing-local", {
        repository: "example/product",
        pullRequest: 7,
        kind: "STAGING_GATE",
        head,
        baseRef: "main",
        baseSha,
        gate: "PASS",
        checks: [],
        reviewRoot: root,
        artifactKey: key,
        body: "FORGE:STAGING_GATE:PASS\nMissing local receipt must remain unsatisfied.",
        publish: false,
        policy: {
          schema: "forgedock.candidate-pr-policy/v1",
          repository: "example/product",
          pullRequest: 7,
          identity: { head, baseRef: "main", baseSha },
          policy: { evaluatedRequiredChecks: { status: "available", exitCode: 0, data: [{ name: "CI", state: "SUCCESS", bucket: "pass" }] } },
        },
      }),
      /local verification receipts are missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
