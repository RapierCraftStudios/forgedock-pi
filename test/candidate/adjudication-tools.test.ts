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
      if (args.includes("discover")) {
        const outIndex = args.indexOf("--out");
        const discovery = { commentCount: 1, recordCount: 1, unclassifiedComments: [], records: [{ id: 9, url: "https://github.com/example/product/pull/7#issuecomment-9", createdAt: "now", kind: "REVIEW-PANEL", record: { v: 1 }, body: "FULL SELECTED RECORD" }] };
        if (outIndex >= 0) await writeFile(args[outIndex + 1]!, JSON.stringify(discovery));
        return { code: 0, stdout: JSON.stringify(discovery), stderr: "" };
      }
      if (args.includes("review-issues")) return { code: 0, stdout: JSON.stringify({ matches: [] }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ schema: "forgedock.candidate-adjudication/v1", decisionPath: join(root, "adjudication.json"), panelUrl: null, gate: "PASS", verdict: "APPROVE", trackingPublication: "complete", gateBody: "FORGE:STAGING_GATE:PASS\n## REVIEW-PANEL" }), stderr: "" };
    });
    const common = { repository: "example/product", pullRequest: 7, head: review.head, baseRef: "integration", baseSha: review.baseSha, reviewRoot: root, artifactKey: review.artifactKey };
    const discovered = await tools.get("forge_discover_review_records")!.execute("discover", { repository: "example/product", pullRequest: 7, cwd: root, reviewRoot: root, artifactKey: review.artifactKey });
    assert.match(discovered.content[0].text, /historyIndexPath|records/);
    const historyIndexPath = discovered.details.historyIndexPath;
    assert.equal(typeof historyIndexPath, "string");
    const historyIndex = JSON.parse(await readFile(historyIndexPath as string, "utf8"));
    assert.equal(historyIndex.records.length, 1);
    assert.equal(await readFile(historyIndex.records[0].bodyPath, "utf8"), "FULL SELECTED RECORD");
    const firstDraft = { title: "Follow up", problem: "A missing proof", rootCause: "No receipt", affectedFiles: ["docs/proof.md"], expectedBehavior: "A receipt exists", acceptanceCriteria: ["Publish it"], evidence: ["Report"], stage: "before promotion" };
    const searched = await tools.get("forge_resolve_review_tracking")!.execute("search", { ...common, concernId: "correctness:F1", draft: firstDraft });
    const searchedSecond = await tools.get("forge_resolve_review_tracking")!.execute("search", { ...common, concernId: "security:F1", draft: { ...firstDraft, problem: "A second proof is missing", affectedFiles: ["docs/security.md"] } });
    const searchedRetry = await tools.get("forge_resolve_review_tracking")!.execute("search", { ...common, concernId: "correctness:F1", draft: firstDraft });
    assert.match(searched.content[0].text, /matches/);
    assert.match(searchedSecond.content[0].text, /matches/);
    assert.match(searchedRetry.content[0].text, /matches/);
    const searchInputs = calls.filter((args) => args.includes("review-issues")).map((args) => args[args.indexOf("--input") + 1]);
    assert.equal(searchInputs.length, 3);
    assert.notEqual(searchInputs[0], searchInputs[1]);
    assert.equal(searchInputs[0], searchInputs[2]);
    const adjudicationInput = { ...common, mode: "standard", verdict: "APPROVE", gate: "PASS", decisions: [], checks: [], nextAction: "No action.", allowIssueWrites: false, publish: false };
    const adjudicated = await tools.get("forge_publish_adjudication")!.execute("adjudicate", adjudicationInput);
    const retried = await tools.get("forge_publish_adjudication")!.execute("adjudicate-retry", adjudicationInput);
    const corrected = await tools.get("forge_publish_adjudication")!.execute("adjudicate-corrected", { ...adjudicationInput, revision: 1, nextAction: "Corrected decision." });
    assert.match(adjudicated.content[0].text, /REVIEW-PANEL/);
    assert.match(retried.content[0].text, /REVIEW-PANEL/);
    assert.match(corrected.content[0].text, /REVIEW-PANEL/);
    const adjudicationInputs = calls.filter((args) => args.includes("adjudication") && args.includes("--input")).map((args) => args[args.indexOf("--input") + 1]);
    assert.equal(adjudicationInputs.length, 3);
    assert.equal(adjudicationInputs[0], adjudicationInputs[1]);
    assert.notEqual(adjudicationInputs[1], adjudicationInputs[2]);
    assert.equal(isStagingMutationBlocked("forge_publish_adjudication", {}), false);
    assert.equal(isStagingMutationBlocked("forge_resolve_review_tracking", {}), false);
    assert.equal(isStagingMutationBlocked("bash", {}), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
