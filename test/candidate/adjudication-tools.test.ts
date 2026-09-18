import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { isStagingMutationBlocked } from "../../candidate/extension.ts";
import registerCandidateTools from "../../candidate/tools.ts";

function toolsFor(exec: (...args: any[]) => Promise<any>) {
  const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<any> }>();
  registerCandidateTools({ registerTool(definition: any) { tools.set(definition.name, definition); }, exec } as never);
  return tools;
}

test("parent-only adjudication tools expose bounded review and tracking operations", async () => {
  const root = await mkdtemp("/tmp/forgedock-adjudication-tools-");
  try {
    const review = {
      schema: "forgedock.candidate-review/v1",
      artifactRoot: root,
      artifactKey: "attempt-1",
      repository: "example/product",
      pullRequest: 7,
      head: "a".repeat(40),
      baseRef: "integration",
      baseSha: "b".repeat(40),
      sourceRoot: root,
      configRoot: root,
      publish: false,
      roles: ["correctness"],
    };
    await writeFile(join(root, "review.json"), JSON.stringify(review));
    const calls: string[][] = [];
    const tools = toolsFor(async (_name: string, args: string[] = []) => {
      calls.push(args);
      if (args.includes("discover")) return { code: 0, stdout: JSON.stringify({ records: [] }), stderr: "" };
      if (args.includes("review-issues")) return { code: 0, stdout: JSON.stringify({ matches: [] }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ schema: "forgedock.candidate-adjudication/v1", decisionPath: join(root, "adjudication.json"), panelUrl: null, gate: "PASS", verdict: "APPROVE", trackingPublication: "complete", gateBody: "FORGE:STAGING_GATE:PASS\n## REVIEW-PANEL" }), stderr: "" };
    });
    const common = { repository: "example/product", pullRequest: 7, head: review.head, baseRef: "integration", baseSha: review.baseSha, reviewRoot: root, artifactKey: review.artifactKey };
    const discovered = await tools.get("forge_discover_review_records")!.execute("discover", { repository: "example/product", pullRequest: 7, cwd: root });
    assert.match(discovered.content[0].text, /records/);
    const searched = await tools.get("forge_resolve_review_tracking")!.execute("search", { ...common, concernId: "correctness:F1", draft: { title: "Follow up", problem: "A missing proof", rootCause: "No receipt", affectedFiles: ["docs/proof.md"], expectedBehavior: "A receipt exists", acceptanceCriteria: ["Publish it"], evidence: ["Report"], stage: "before promotion" } });
    assert.match(searched.content[0].text, /matches/);
    const adjudicated = await tools.get("forge_publish_adjudication")!.execute("adjudicate", { ...common, mode: "standard", verdict: "APPROVE", gate: "PASS", decisions: [], checks: [], nextAction: "No action.", allowIssueWrites: false, publish: false });
    assert.match(adjudicated.content[0].text, /REVIEW-PANEL/);
    assert.ok(calls.some((args) => args.includes("adjudication")));
    assert.equal(isStagingMutationBlocked("forge_publish_adjudication", {}), false);
    assert.equal(isStagingMutationBlocked("forge_resolve_review_tracking", {}), false);
    assert.equal(isStagingMutationBlocked("bash", {}), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
