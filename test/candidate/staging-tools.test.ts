import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import registerCandidateTools from "../../candidate/tools.ts";

test("preparation errors keep full diagnostics outside model context", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-staging-tools-");
  const fullDiagnostic = ["orchestration.max_concurrent must be an integer from 1 through 32", "diagnostic detail ".repeat(240).trimEnd()].join("\n");
  let diagnosticPath: string | undefined;
  try {
    const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
    const fakePi = {
      registerTool(definition: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) { tools.set(definition.name, definition); },
      async exec() { return { code: 1, stdout: "", stderr: fullDiagnostic, killed: false }; },
    };
    registerCandidateTools(fakePi as never);
    const tool = tools.get("forge_prepare_review");
    assert.ok(tool);
    try {
      await tool.execute("prepare", { repository: "example/product", pullRequest: 7, head: "a".repeat(40), baseRef: "main", baseSha: "b".repeat(40), sourceRoot: root, publish: false });
      assert.fail("expected preparation to fail");
    } catch (error) {
      const message = String(error);
      const savedPath = message.split("Full diagnostic: ")[1]?.split(". Do not retry")[0];
      assert.ok(savedPath);
      diagnosticPath = savedPath;
      assert.match(message, /Do not retry the unchanged request/);
      assert.ok(!message.includes("diagnostic detail ".repeat(200)));
      assert.equal(await readFile(diagnosticPath, "utf8"), fullDiagnostic);
    }
  } finally {
    if (diagnosticPath) await rm(dirname(diagnosticPath), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

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
    const policy = { schema: "forgedock.candidate-pr-policy/v1", repository: "example/product", pullRequest: 7, identity: { head, baseRef: "main", baseSha }, configuration: { verificationCommands: { test: "npm test" } }, policy: { evaluatedRequiredChecks: { status: "available", exitCode: 0, data: [{ name: "CI", state: "SUCCESS", bucket: "pass" }] }, requirements: { applicability: "known-required", requiredNames: ["CI"], observedNames: ["CI"], missingRequiredNames: [] } } };
    await writeFile(join(root, "policy.json"), JSON.stringify({ schema: "forgedock.candidate-policy/v1", artifactKey: key, repository: "example/product", pullRequest: 7, head, baseRef: "main", baseSha, prepared: policy, current: policy, refreshedAt: null }));
    const adjudicationPath = join(root, "adjudication.json");
    await writeFile(adjudicationPath, JSON.stringify({ schema: "forgedock.candidate-adjudication/v1", artifactKey: key, repository: "example/product", pullRequest: 7, head, baseRef: "main", baseSha, gate: "PASS", roles: ["correctness"], reports: [{ role: "correctness" }], decisions: [], verdict: "APPROVE", panelUrl: null, trackingPublication: "complete", gateBody: "FORGE:STAGING_GATE:PASS\\n\\n## REVIEW-PANEL\\nAll selected reports and parent decisions are accounted for." }));

    const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
    const fakePi = {
      registerTool(definition: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) { tools.set(definition.name, definition); },
      async exec(_name: string, args: string[] = []) { return args.includes("inspect-pr") ? { code: 0, stdout: JSON.stringify(policy), stderr: "", killed: false } : { code: 0, stdout: "saved", stderr: "", killed: false }; },
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
      body: "placeholder body is replaced by the shared adjudication artifact.",
      adjudicationPath,
      publish: false,
    });
    assert.ok(result);
    await assert.rejects(
      tool.execute("missing-adjudication", {
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
        body: "placeholder body.",
        publish: false,
      }),
      /PASS requires the completed parent adjudication artifact/,
    );
    const infrastructureFailure = await tool.execute("pre-review-infrastructure", {
      repository: "example/product", pullRequest: 7, kind: "STAGING_GATE", head, baseRef: "main", baseSha,
      gate: "FAIL", checks: [], reviewRoot: root, artifactKey: key, body: "Pre-review policy collection failed before a panel could complete.", preReviewInfrastructure: true, publish: false,
    });
    assert.equal((infrastructureFailure as { details: { publication: string } }).details.publication, "saved");
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
        adjudicationPath,
        body: "placeholder body.",
        publish: false,
      }),
      /local verification receipts are missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
