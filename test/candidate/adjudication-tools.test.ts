import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { isStagingMutationBlocked } from "../../candidate/extension.ts";
import registerCandidateTools from "../../candidate/tools.ts";

const execFileAsync = promisify(execFile);

type RegisteredTool = { execute: (id: string, params: unknown) => Promise<any>; description?: string; parameters?: unknown };

function toolsFor(exec: (...args: any[]) => Promise<any>) {
  const tools = new Map<string, RegisteredTool>();
  registerCandidateTools({ registerTool(definition: any) { tools.set(definition.name, definition); }, exec } as never);
  return tools;
}

async function writeRecoverySidecar(root: string, review: Record<string, any>, role: string, body: string): Promise<void> {
  const observations: unknown[] = [];
  const bodyBytes = `${body.trim()}\n`;
  const observationsBytes = `${JSON.stringify(observations, null, 2)}\n`;
  const bodyPath = join(root, `${role}.body.md`);
  const observationsPath = join(root, `${role}.observations.json`);
  await writeFile(bodyPath, bodyBytes);
  await writeFile(observationsPath, observationsBytes);
  await writeFile(join(root, `${role}.authorization.json`), JSON.stringify({ schema: "forgedock.candidate-review-role/v1", artifactRoot: root, artifactKey: review.roleArtifactKeys[role], role, repository: review.repository, pullRequest: review.pullRequest, head: review.head, baseRef: review.baseRef, baseSha: review.baseSha, publish: review.publish }));
  await writeFile(join(root, `${role}.publication-recovery.json`), JSON.stringify({
    schema: "forgedock.candidate-review-publication-recovery/v1",
    state: "saved",
    recoveryAttempts: 0,
    nativeRunId: "native-correctness-run-1",
    reviewArtifactKey: review.artifactKey,
    roleArtifactKey: review.roleArtifactKeys[role],
    suppliedArtifactKey: review.roleArtifactKeys[role],
    repository: review.repository,
    pullRequest: review.pullRequest,
    head: review.head,
    baseRef: review.baseRef,
    baseSha: review.baseSha,
    role,
    publish: review.publish,
    bodyPath,
    reportPath: join(root, `${role}.report.md`),
    observationsPath,
    body: body.trim(),
    observations,
    bodySha256: createHash("sha256").update(bodyBytes).digest("hex"),
    observationsSha256: createHash("sha256").update(observationsBytes).digest("hex"),
  }));
  const roleResults = (review.roles as string[]).map((selectedRole) => ({ role: selectedRole, nativeRunId: "native-correctness-run-1", nativeStatus: "completed", reportPath: join(root, `${selectedRole}.report.md`), recoveryPath: join(root, `${selectedRole}.publication-recovery.json`), exitCode: 0 }));
  await writeFile(join(root, "panel-launch.claim"), JSON.stringify({ schema: "forgedock.candidate-review-panel-launch/v1", artifactKey: review.artifactKey, workflowSha256: review.workflowSha256, toolCallId: "test-reviewer-tool-call", claimedAt: new Date().toISOString() }));
  await writeFile(join(root, "reviewer-execution.json"), JSON.stringify({ schema: "forgedock.candidate-review-execution/v1", repository: review.repository, pullRequest: review.pullRequest, head: review.head, baseRef: review.baseRef, baseSha: review.baseSha, artifactKey: review.artifactKey, mode: review.mode, workflowPath: review.workflowPath, workflowSha256: review.workflowSha256, toolCallId: "test-reviewer-tool-call", workflowRunId: "test-workflow-run", completedAt: new Date().toISOString(), roleResults }));
}

test("parent-only adjudication tools expose bounded review and tracking operations", async () => {
  const root = await mkdtemp("/tmp/forgedock-adjudication-tools-");
  try {
    const workflowPath = join(root, "workflow.js");
    const workflowText = "const assignments = [];\nreturn assignments;\n";
    await writeFile(workflowPath, workflowText);
    const workflowSha256 = createHash("sha256").update(workflowText).digest("hex");
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
      roleArtifactKeys: { correctness: "correctness-attempt" },
      workflowPath,
      workflowSha256,
      mode: "standard",
    };
    await writeFile(join(root, "review.json"), JSON.stringify(review));
    await writeFile(join(root, "correctness.report.md"), `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ repository: review.repository, pullRequest: review.pullRequest, head: review.head, baseRef: review.baseRef, baseSha: review.baseSha, role: "correctness", reportId: review.roleArtifactKeys.correctness })} -->\n<!-- FORGE:REVIEW_OBSERVATIONS [] -->\n## ForgeDock review\n`);
    await writeRecoverySidecar(root, review, "correctness", "## ForgeDock review\n\nClean report.");
    const calls: string[][] = [];
    let largeHistory = false;
    const tools = toolsFor(async (_name: string, args: string[] = []) => {
      calls.push(args);
      if (args.includes("discover")) {
        const outIndex = args.indexOf("--out");
        const makeRecord = (index: number, large: boolean) => {
          const panel = index % 3 === 0;
          const reviewer = index % 3 === 1;
          const metadata = panel
            ? { v: 1, source_head: `head-${index}`, supersedes: index ? `https://example.invalid/${index}` : null, review_attempt: `attempt-${index}`, review: { base_ref: "main", base_sha: `base-${index}`, mode: "staging" } }
            : reviewer
              ? { v: 1, head: `head-${index}`, baseRef: "staging", baseSha: `base-${index}`, reportId: `report-${index}`, role: "correctness" }
              : { v: 1, head: `head-${index}`, baseRef: "main", baseSha: `base-${index}`, gate: "FAIL" };
          return { id: index + 1, url: `https://github.com/example/product/pull/${large ? 8 : 7}#issuecomment-${index + 1}`, createdAt: "now", kind: panel ? "REVIEW-PANEL" : reviewer ? "REVIEW" : "STAGING_GATE", metadata, body: `FULL SELECTED RECORD ${index}` };
        };
        const records = Array.from({ length: largeHistory ? 120 : 3 }, (_, index) => makeRecord(index, largeHistory));
        const discovery = { commentCount: records.length, recordCount: records.length, unclassifiedComments: [], records };
        if (outIndex >= 0) await writeFile(args[outIndex + 1]!, JSON.stringify(discovery));
        return { code: 0, stdout: JSON.stringify(discovery), stderr: "" };
      }
      if (args.includes("review-issues")) return { code: 0, stdout: JSON.stringify({ matches: [] }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ schema: "forgedock.candidate-adjudication/v1", decisionPath: join(root, "adjudication.json"), panelUrl: null, gate: "PASS", verdict: "APPROVE", trackingPublication: "complete", gateBody: "FORGE:STAGING_GATE:PASS\n## REVIEW-PANEL" }), stderr: "" };
    });
    const common = { repository: "example/product", pullRequest: 7, head: review.head, baseRef: "integration", baseSha: review.baseSha, reviewRoot: root, artifactKey: review.artifactKey };
    const discovered = await tools.get("forge_discover_review_records")!.execute("discover", { repository: "example/product", pullRequest: 7, cwd: root, reviewRoot: root, artifactKey: review.artifactKey });
    assert.match(discovered.content[0].text, /historyIndexPath|records/);
    const discoveredSummary = JSON.parse(discovered.content[0].text);
    const historyIndexPath = discoveredSummary.historyIndexPath;
    assert.equal(typeof historyIndexPath, "string");
    const historyIndex = JSON.parse(await readFile(historyIndexPath as string, "utf8"));
    assert.equal(historyIndex.records.length, 3);
    assert.equal(await readFile(historyIndex.records[0].bodyPath, "utf8"), "FULL SELECTED RECORD 0");
    assert.equal(historyIndex.records[0].record.sourceHead, "head-0");
    assert.equal(historyIndex.records[1].record.sourceHead, "head-1");
    assert.equal(historyIndex.records[1].record.baseRef, "staging");
    assert.equal(historyIndex.records[2].record.baseRef, "main");
    largeHistory = true;
    const large = await tools.get("forge_discover_review_records")!.execute("discover-large", { repository: "example/product", pullRequest: 8, cwd: root, reviewRoot: root, artifactKey: review.artifactKey });
    const compact = JSON.parse(large.content[0].text);
    assert.equal(compact.completeness.totalRecords, 120);
    assert.equal(compact.completeness.displayedRecords, 24);
    assert.ok(compact.historyIndexPath);
    const fullIndex = JSON.parse(await readFile(compact.historyIndexPath, "utf8"));
    assert.equal(fullIndex.records.length, 120);
    const selected = fullIndex.records.find((record: any) => record.id === 1);
    assert.ok(selected);
    assert.match(await readFile(selected.bodyPath, "utf8"), /FULL SELECTED RECORD 0/);
    assert.equal(selected.record.sourceHead, "head-0");
    assert.equal(selected.record.reviewAttempt, "attempt-0");
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

test("registered parent contract preserves failed prose input and requires structured history", async () => {
  const root = await mkdtemp("/tmp/forgedock-adjudication-contract-");
  try {
    await writeFile(join(root, "forge.yaml"), "project:\n  owner: example\n  repo: product\nbranches:\n  default: main\n  staging: integration\nagents:\n  subagent_model: provider/model\n");
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
    await writeFile(join(root, "gh"), "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });
    await writeFile(join(root, "README.md"), "base\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const livePull = JSON.stringify({ headRefOid: head, baseRefName: "integration" });
    await writeFile(join(root, "gh"), `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === "pr" && args[1] === "view") process.stdout.write(${JSON.stringify(livePull)});\nelse process.stdout.write("[]");\n`, { mode: 0o755 });
    const workflowPath = join(root, "workflow.js");
    const workflowText = "const assignments = [];\nreturn assignments;\n";
    await writeFile(workflowPath, workflowText);
    const workflowSha256 = createHash("sha256").update(workflowText).digest("hex");
    const review = {
      schema: "forgedock.candidate-review/v1",
      artifactRoot: root,
      artifactKey: "attempt-contract",
      repository: "example/product",
      pullRequest: 7,
      head,
      baseRef: "integration",
      baseSha: head,
      sourceRoot: root,
      configRoot: root,
      publish: false,
      roles: ["correctness"],
      roleArtifactKeys: { correctness: "contract-report" },
      workflowPath,
      workflowSha256,
      mode: "standard",
    };
    await writeFile(join(root, "review.json"), JSON.stringify(review));
    await writeRecoverySidecar(root, review, "correctness", "## ForgeDock review\n\nClean report.");
    const calls: string[][] = [];
    const tools = toolsFor(async (name: string, args: string[]) => {
      calls.push(args);
      const result = await execFileAsync(name, args, { cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    });
    const parent = tools.get("forge_publish_adjudication")!;
    assert.match(parent.description ?? "", /decisions.*current reviewer observations.*historicalDecisions.*only model-facing representation/s);
    const common = { repository: "example/product", pullRequest: 7, head: review.head, baseRef: "integration", baseSha: review.baseSha, mode: "standard", reviewRoot: root, artifactKey: review.artifactKey, verdict: "APPROVE", gate: "PASS", decisions: [], checks: [], nextAction: "No action.", allowIssueWrites: false, publish: false };
    await assert.rejects(parent.execute("legacy", { ...common, historicalDecisions: [], priorConcerns: ["legacy allegation"] } as any), /Legacy priorConcerns prose.*historicalDecisions.*sourceReference/);
    const failedInputPath = calls.at(-1)![calls.at(-1)!.indexOf("--input") + 1]!;
    const failedInput = JSON.parse(await readFile(failedInputPath, "utf8"));
    assert.deepEqual(failedInput.priorConcerns, ["legacy allegation"]);
    const rejected = { id: "prior-rejected", sourceReference: "https://example.invalid/prior", disposition: "REJECTED/NOT APPLICABLE", resolution: "resolved-by-evidence", summary: "Prior allegation is disproven", rationale: "Current primary evidence preserves the artifact.", evidence: ["The exact-head report is clean."], stage: "current review", blocksCurrentStage: false, tracking: { status: "none" } };
    const recovered = await parent.execute("recovered", { ...common, revision: 1, historicalDecisions: [rejected] });
    const recoveredArtifact = JSON.parse(await readFile(recovered.details.decisionPath, "utf8"));
    assert.ok(recoveredArtifact.decisions.some((decision: any) => decision.id === "prior-rejected"));
    assert.equal(recoveredArtifact.tracking["prior-rejected"].attempted, false);
    assert.equal(recoveredArtifact.tracking["prior-rejected"].issue, undefined);
    const recoveredInputPath = calls.at(-1)![calls.at(-1)!.indexOf("--input") + 1]!;
    assert.notEqual(failedInputPath, recoveredInputPath);
    const accepted = { id: "prior-follow-up", sourceReference: "https://example.invalid/follow-up", disposition: "NON-BLOCKING FOLLOW-UP", resolution: "confirmed", summary: "Historical follow-up remains applicable", rationale: "The same actionable work remains useful.", evidence: ["The prior report remains applicable."], stage: "later validation", blocksCurrentStage: false, tracking: { status: "pending", draft: { title: "Follow up", problem: "Historical work remains", rootCause: "Prior work was not completed", affectedFiles: ["docs/review.md"], expectedBehavior: "The follow-up is completed", acceptanceCriteria: ["Publish evidence"], evidence: ["Prior report"], stage: "later validation" } } };
    const acceptedResult = await parent.execute("accepted", { ...common, revision: 2, verdict: "APPROVE_WITH_FOLLOW_UP", historicalDecisions: [accepted] });
    const acceptedArtifact = JSON.parse(await readFile(acceptedResult.details.decisionPath, "utf8"));
    assert.equal(acceptedArtifact.tracking["prior-follow-up"].status, "pending");
    const emptyResult = await parent.execute("empty", { ...common, revision: 3, historicalDecisions: [] });
    const emptyArtifact = JSON.parse(await readFile(emptyResult.details.decisionPath, "utf8"));
    assert.deepEqual(emptyArtifact.decisions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
