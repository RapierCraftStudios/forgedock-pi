import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helper = resolve("bin/forgedock-candidate.mjs");

const forgeYaml = `
project:
  owner: example
  repo: product
paths:
  root: .
branches:
  default: main
  staging: integration
  feature_pattern: feature/{slug}
agents:
  subagent_model: provider/model
  thinking: max
orchestration:
  max_concurrent: 2
verification:
  commands:
    test: npm test
review:
  thinking: max
  reviewer_timeout_ms: 1000
  panel_timeout_ms: 4000
  publication_timeout_ms: 1000
  max_concurrent: 2
`;

test("generates bounded dispatch and review requests from ordinary JSON data", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-cli-");
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
    await writeFile(join(root, "README.md"), "fixture base\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
    await writeFile(join(root, "forge.yaml"), forgeYaml);
    await execFileAsync("git", ["add", "forge.yaml"], { cwd: root });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "fixture"], { cwd: root });
    const sourceHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const baseSha = (await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["branch", "-M", "integration"], { cwd: root });
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/integration", sourceHead], { cwd: root });
    const parsedConfig = JSON.parse((await execFileAsync("node", [helper, "config", "--cwd", root])).stdout) as { ownerModel: string; ownerThinking: string; configuredOwnerConcurrency: number; effectiveOwnerConcurrency: number; review: { reviewerThinking: string } };
    assert.equal(parsedConfig.ownerModel, "provider/model");
    assert.equal(parsedConfig.ownerThinking, "max");
    assert.equal(parsedConfig.configuredOwnerConcurrency, 2);
    assert.equal(parsedConfig.effectiveOwnerConcurrency, 2);
    assert.equal(parsedConfig.review.reviewerThinking, "max");
    const isolatedMaxConfig = JSON.parse((await execFileAsync("node", [helper, "config", "--cwd", root], { env: { ...process.env, FORGEDOCK_CANDIDATE_OWNER_MODEL: "provider/model", FORGEDOCK_CANDIDATE_OWNER_THINKING: "max", FORGEDOCK_CANDIDATE_REVIEWER_THINKING: "max" } })).stdout) as { ownerModel: string; ownerModelSource: string; ownerThinking: string; ownerThinkingSource: string; review: { reviewerThinking: string; reviewerThinkingSource: string } };
    assert.deepEqual({ ownerModel: isolatedMaxConfig.ownerModel, ownerModelSource: isolatedMaxConfig.ownerModelSource, ownerThinking: isolatedMaxConfig.ownerThinking, ownerThinkingSource: isolatedMaxConfig.ownerThinkingSource, reviewerThinking: isolatedMaxConfig.review.reviewerThinking, reviewerThinkingSource: isolatedMaxConfig.review.reviewerThinkingSource }, { ownerModel: "provider/model", ownerModelSource: "isolated-launch-override", ownerThinking: "max", ownerThinkingSource: "isolated-launch-override", reviewerThinking: "max", reviewerThinkingSource: "isolated-launch-override" });
    await assert.rejects(execFileAsync("node", [helper, "config", "--cwd", root], { env: { ...process.env, FORGEDOCK_CANDIDATE_OWNER_MODEL: "other/provider", FORGEDOCK_CANDIDATE_OWNER_THINKING: "max" } }), /must preserve forge.yaml provider\/model identity/);
    const testName = root.slice(root.lastIndexOf("/") + 1);
    const issuesFile = join(root, "..", `${testName}-issues.json`);
    await writeFile(issuesFile, JSON.stringify({ issues: [
      { number: 2, title: "dependent", body: "## Acceptance Criteria\n- [ ] Consumer works\n\nDepends on #1" },
      { number: 1, title: "base", body: "## Acceptance Criteria\r\n- [ ] Producer behavior works\r\n  It must remain compatible.\r\n\r\n- [ ] Second obligation works\r\n\r\n## Affected Files\r\n- `src/producer.ts:10`\r\n- `src/consumer.ts`\r\n\r\n## Notes\r\nThis paragraph is not another criterion." },
      { number: 3, title: "unstructured", body: "Fix the consumer timeout when the queue is empty; preserve compatibility.", dispatchEvidence: ["The configured full suite also fails at the exact seed; retain that check as a failure and do not expand the issue into unrelated files."] },
    ] }));
    const out = join(root, "..", `${testName}-dispatch`);
    const localOut = join(root, "..", `${testName}-local-replay-dispatch`);
    const ownerAuthorityPath = join(root, "..", `${testName}-owner-authority.txt`);
    const ownerAuthority = "The operator authorized simulated publication in this fixture only; no live GitHub operations.";
    await writeFile(ownerAuthorityPath, `${ownerAuthority}\n`);
    const dispatch = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--delivery-mode", "github", "--owner-authority-file", ownerAuthorityPath, "--cwd", root, "--issues-file", issuesFile, "--out", out])).stdout) as { requestPath: string; planPath: string };
    const plan = JSON.parse(await readFile(dispatch.planPath, "utf8")) as { deliveryMode: string; ownerAuthority: string | null; ownerConcurrency: { configured: number; effective: number }; launchAllowance: number; targetBase: { branch: string; headSha: string }; issues: Array<{ number: number; predecessors: string[]; acceptance: string[]; acceptanceMapping: { sourceBodySha256: string; criteria: Array<{ id: string; textHash: string; proofType: string; affectedBoundaries: string[] }> }; mutationFiles: string[]; body: string; task: string; admitted?: boolean }>; readiness: { missingAcceptance: number[]; unstructuredAcceptance: number[] } };
    assert.equal(plan.deliveryMode, "github");
    assert.equal(plan.ownerAuthority, ownerAuthority);
    assert.deepEqual((plan as any).operationAuthority, { schema: "forgedock.candidate-owner-authority/v1", scope: "", mergeTargets: [], closeIssueAfterMerge: false, closeInvalidIssue: false, createIssues: false });
    assert.deepEqual((plan.issues[0] as any)?.operationAuthority.mergeTargets, []);
    assert.match(plan.issues[0]?.task ?? "", /No listed merge target means PR-only/);
    assert.deepEqual(plan.ownerConcurrency, { configured: 2, effective: 2 });
    assert.equal(plan.launchAllowance, 17);
    assert.equal(plan.targetBase.headSha, sourceHead);
    assert.match(plan.issues[0]?.task ?? "", /Prepared base: integration/);
    assert.match(plan.issues[0]?.task ?? "", /prepare --issue 1 --cwd/);
    assert.match(plan.issues[1]?.task ?? "", /prepared SHA, effective SHA, observed target SHA/);
    assert.match(plan.issues[1]?.task ?? "", /Never fetch\/fast-forward after the first source mutation/);
    assert.equal(plan.issues[0]?.acceptanceMapping.criteria[0]?.affectedBoundaries.includes("src/producer.ts"), true);
    assert.match(plan.issues[0]?.acceptanceMapping.sourceBodySha256 ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(plan.issues[0]?.task ?? "", /Trusted dispatch deliveryMode: github/);
    assert.match(plan.issues[0]?.task ?? "", /Original parent operation-scope text/);
    assert.match(plan.issues[0]?.task ?? "", /additional task limits; the structured fields above exclusively control merge, closure, and follow-up issue creation/);
    assert.match(plan.issues[0]?.task ?? "", /no live GitHub operations/);
    assert.doesNotMatch(plan.issues[0]?.task ?? "", /authorized local replay|do not perform GitHub writes/);
    const stagingAuthorityPath = join(root, "..", `${testName}-staging-authority.json`);
    const authorizedOut = join(root, "..", `${testName}-dispatch-staging-authority`);
    await writeFile(stagingAuthorityPath, `${JSON.stringify({ schema: "forgedock.candidate-owner-authority/v1", mergeTargets: ["integration"], closeIssueAfterMerge: true, closeInvalidIssue: false })}\n`);
    const authorizedDispatch = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--delivery-mode", "github", "--owner-authority-file", stagingAuthorityPath, "--cwd", root, "--issues-file", issuesFile, "--out", authorizedOut])).stdout) as { planPath: string; workflowPath: string };
    const authorizedPlan = JSON.parse(await readFile(authorizedDispatch.planPath, "utf8")) as any;
    assert.deepEqual(authorizedPlan.operationAuthority.mergeTargets, ["integration"]);
    assert.deepEqual(authorizedPlan.issues[0].operationAuthority, { schema: "forgedock.candidate-owner-authority/v1", scope: "", repository: "example/product", issue: 1, deliveryMode: "github", target: "integration", protectedTarget: "main", mergeTargets: ["integration"], closeIssueAfterMerge: true, closeInvalidIssue: false, createIssues: false });
    assert.match(authorizedPlan.issues[0].task, /Merge only to a listed target/);
    assert.match(await readFile(authorizedDispatch.workflowPath, "utf8"), /forgedock\.candidate-owner-authority\/1/);
    const protectedAuthorityPath = join(root, "..", `${testName}-main-authority.json`);
    await writeFile(protectedAuthorityPath, `${JSON.stringify({ schema: "forgedock.candidate-owner-authority/v1", mergeTargets: ["main"], closeIssueAfterMerge: true, closeInvalidIssue: false })}\n`);
    await assert.rejects(execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1", "--delivery-mode", "github", "--owner-authority-file", protectedAuthorityPath, "--cwd", root, "--issues-file", issuesFile, "--out", join(root, "..", `${testName}-dispatch-main-authority`)]), /outside the selected issue targets/);
    const localDispatch = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--delivery-mode", "local-replay", "--cwd", root, "--issues-file", issuesFile, "--out", localOut])).stdout) as { planPath: string };
    const localPlan = JSON.parse(await readFile(localDispatch.planPath, "utf8")) as { deliveryMode: string; issues: Array<{ task: string }> };
    assert.equal(localPlan.deliveryMode, "local-replay");
    assert.match(localPlan.issues[0]?.task ?? "", /authorized local replay/);
    assert.match(localPlan.issues[0]?.task ?? "", /do not perform GitHub writes/);
    assert.deepEqual(plan.issues.map((issue) => issue.number), [1, 2, 3]);
    assert.deepEqual(plan.issues[1]?.predecessors, ["issue-1"]);
    assert.deepEqual(plan.readiness.missingAcceptance, []);
    assert.deepEqual(plan.readiness.unstructuredAcceptance, [3]);
    assert.equal(plan.issues[2]?.admitted, true);
    assert.deepEqual(plan.issues[0]?.acceptance, ["Producer behavior works\n  It must remain compatible.", "Second obligation works"]);
    assert.deepEqual(plan.issues[0]?.mutationFiles, ["src/consumer.ts", "src/producer.ts"]);
    assert.match(plan.issues[0]?.body ?? "", /This paragraph is not another criterion/);
    assert.match(plan.issues[0]?.task ?? "", /Second obligation works/);
    assert.equal(plan.issues[2]?.body, "Fix the consumer timeout when the queue is empty; preserve compatibility.");
    assert.match(plan.issues[2]?.task ?? "", /Dispatcher evidence\/context follows; independently verify it/);
    assert.match(plan.issues[2]?.task ?? "", /retain that check as a failure/);
    const request = JSON.parse(await readFile(dispatch.requestPath, "utf8")) as { workflowScriptPath: string; globalConcurrencyLimit: number; maxSubagentSpawnsPerRun: number; async: boolean };
    assert.equal(request.globalConcurrencyLimit, 2);
    assert.equal(request.async, true);
    assert.equal(request.maxSubagentSpawnsPerRun, plan.launchAllowance);
    const ownerWorkflow = await readFile(request.workflowScriptPath, "utf8");
    assert.match(ownerWorkflow, /forgedock-owner/);
    assert.match(ownerWorkflow, /nativeAcceptanceStatus/);
    assert.match(ownerWorkflow, /Reconcile the exact issue\/PR and saved Forge records first/);
    assert.doesNotMatch(ownerWorkflow, /if \(result\.ok \|\|/);
    assert.ok(ownerWorkflow.includes('const configuredModel = "provider/model:max";'));
    const intakePath = join(root, "..", `${testName}-intake.json`);
    const firstIntake = JSON.parse((await execFileAsync("node", [helper, "prepare", "--issue", "1", "--cwd", root, "--issue-file", issuesFile, "--out", intakePath])).stdout) as { outputPath: string; preparedAt: string; reused: boolean; issue: { acceptance: string[]; mutationFiles: string[] } };
    const secondIntake = JSON.parse((await execFileAsync("node", [helper, "prepare", "--issue", "1", "--cwd", root, "--issue-file", issuesFile, "--out", intakePath])).stdout) as { outputPath: string; preparedAt: string; reused: boolean };
    assert.equal(firstIntake.reused, false);
    assert.equal(secondIntake.reused, true);
    assert.equal(secondIntake.outputPath, firstIntake.outputPath);
    assert.equal(secondIntake.preparedAt, firstIntake.preparedAt);
    assert.deepEqual(firstIntake.issue.acceptance, plan.issues[0]?.acceptance);
    assert.deepEqual(firstIntake.issue.mutationFiles, plan.issues[0]?.mutationFiles);
    const changedIssues = JSON.parse(await readFile(issuesFile, "utf8")) as { issues: Array<{ number: number; body: string }> };
    changedIssues.issues[1]!.body = changedIssues.issues[1]!.body.replace("Second obligation works", "Changed obligation works");
    await writeFile(issuesFile, JSON.stringify(changedIssues));
    const changedIntake = JSON.parse((await execFileAsync("node", [helper, "prepare", "--issue", "1", "--cwd", root, "--issue-file", issuesFile, "--out", intakePath])).stdout) as { outputPath: string; reused: boolean; supersedes: string };
    assert.equal(changedIntake.reused, false);
    assert.notEqual(changedIntake.outputPath, intakePath);
    assert.equal(changedIntake.supersedes, intakePath);
    await rm(out, { recursive: true, force: true });
    await rm(localOut, { recursive: true, force: true });
    await rm(authorizedOut, { recursive: true, force: true });
    await rm(stagingAuthorityPath, { force: true });
    await rm(protectedAuthorityPath, { force: true });
    await rm(ownerAuthorityPath, { force: true });
    await rm(issuesFile, { force: true });
    await rm(firstIntake.outputPath, { force: true });
    await rm(changedIntake.outputPath, { force: true });
    const reviewInput = join(root, "..", `${root.slice(root.lastIndexOf("/") + 1)}-review.json`);
    const reviewOut = join(root, "..", `${root.slice(root.lastIndexOf("/") + 1)}-review-out`);
    await writeFile(reviewInput, JSON.stringify({ repository: "example/product", pullRequest: 3, head: sourceHead, baseRef: "integration", baseSha, sourceRoot: root, acceptance: plan.issues[0]?.acceptance }));
    const review = JSON.parse((await execFileAsync("node", [helper, "prepare-review", "--input", reviewInput, "--out", reviewOut])).stdout) as { requestPath: string; roles: string[] };
    await rm(reviewInput, { force: true });
    assert.deepEqual(review.roles, ["correctness"]);
    assert.equal(JSON.parse(await readFile(review.requestPath, "utf8")).maxSubagentSpawnsPerRun, 1);
    const workflowText = await readFile(join(reviewOut, "workflow.js"), "utf8");
    assert.match(workflowText, /forgedock-reviewer/);
    assert.ok(workflowText.includes('"model":"provider/model:max"'));
    assert.match(workflowText, /Caller-supplied review context \(not authoritative acceptance\)/);
    assert.doesNotMatch(workflowText, /Original acceptance:/);
    assert.match(workflowText, /Prepared policy summary: .*policy-summary\.json/);
    const invalidRoles = join(root, "..", `${testName}-invalid-review.json`);
    await writeFile(invalidRoles, JSON.stringify({ repository: "example/product", pullRequest: 3, head: sourceHead, baseRef: "integration", baseSha, sourceRoot: root, roles: ["security"] }));
    await assert.rejects(execFileAsync("node", [helper, "prepare-review", "--input", invalidRoles, "--out", `${reviewOut}-invalid`]), /correctness reviewer/);
    await rm(invalidRoles, { force: true });
    await rm(reviewOut, { recursive: true, force: true });
    const targetTree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
    const advancedTarget = (await execFileAsync("git", ["-c", "user.name=Candidate Test", "-c", "user.email=test@example.com", "commit-tree", targetTree, "-p", sourceHead, "-m", "remote integration advance"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/integration", advancedTarget], { cwd: root });
    const staleIssueFile = join(root, "..", `${testName}-stale-target-issues.json`);
    await writeFile(staleIssueFile, JSON.stringify({ issues: [{ number: 9, title: "stale target guard", body: "## Acceptance Criteria\n- [ ] Keep the exact prepared target." }] }));
    await assert.rejects(execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#9", "--cwd", root, "--issues-file", staleIssueFile, "--out", join(root, "..", `${testName}-stale-target-out`)]), /not the exact origin\/integration head/);
    await rm(staleIssueFile, { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue preparation invokes gh with the numeric issue contract and source-binds acceptance", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-prepare-");
  const artifacts = await mkdtemp("/tmp/forgedock-candidate-prepare-artifacts-");
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
    await writeFile(join(root, "README.md"), "fixture base\\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
    await writeFile(join(root, "forge.yaml"), forgeYaml);
    await execFileAsync("git", ["add", "forge.yaml"], { cwd: root });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "fixture"], { cwd: root });
    await execFileAsync("git", ["branch", "-M", "integration"], { cwd: root });
    const bin = join(root, "fake-bin");
    await mkdir(bin);
    const gh = join(bin, "gh");
    await writeFile(gh, "#!/bin/sh\nprintf '%s' \"$*\" > \"$FAKE_GH_ARGS_PATH\"\nprintf '%s' \"$FAKE_GH_ISSUE_JSON\"\n");
    await chmod(gh, 0o755);
    const argsPath = join(artifacts, "gh-args.txt");
    const issueBody = "## Acceptance Criteria\n- [ ] Preserve the exact source item [type:unit]\n<!-- FORGE:BODY-INTEGRITY:fixture -->\n<!-- issue-create-token:fixture -->\n";
    const out = join(artifacts, "intake.json");
    const result = JSON.parse((await execFileAsync("node", [helper, "prepare", "--issue", "42", "--cwd", root, "--out", out], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_ARGS_PATH: argsPath, FAKE_GH_ISSUE_JSON: JSON.stringify({ number: 42, title: "numeric intake", body: issueBody, url: "https://github.com/example/product/issues/42", state: "OPEN", labels: [], milestone: null }) },
    })).stdout) as { issue: { acceptance: string[]; acceptanceMapping: { sourceBodySha256: string; criteria: Array<{ proofType: string; text: string }> } } };
    assert.equal(await readFile(argsPath, "utf8"), "issue view 42 -R example/product --json number,title,body,url,state,labels,milestone");
    assert.deepEqual(result.issue.acceptance, ["Preserve the exact source item"]);
    assert.equal(result.issue.acceptanceMapping.criteria[0]?.proofType, "unit");
    assert.equal(result.issue.acceptanceMapping.sourceBodySha256, `sha256:${(await import("node:crypto")).createHash("sha256").update(issueBody).digest("hex")}`);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("review preparation defers dispatch limits while dispatch enforces them", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-cli-");
  const artifacts = await mkdtemp("/tmp/forgedock-candidate-limit-");
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
    await writeFile(join(root, "README.md"), "fixture base\\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
    const oversized = forgeYaml.replace("max_concurrent: 2", "max_concurrent: 300");
    await writeFile(join(root, "forge.yaml"), oversized);
    await execFileAsync("git", ["add", "forge.yaml"], { cwd: root });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "fixture"], { cwd: root });
    const sourceHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const baseSha = (await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd: root })).stdout.trim();
    await execFileAsync("git", ["branch", "-M", "integration"], { cwd: root });
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/integration", sourceHead], { cwd: root });
    const reviewInput = join(artifacts, "review-input.json");
    const reviewOut = join(artifacts, "review-out");
    await writeFile(reviewInput, JSON.stringify({ repository: "example/product", pullRequest: 7, head: sourceHead, baseRef: "integration", baseSha, sourceRoot: root, acceptance: ["The review is independently observable."] }));
    const review = JSON.parse((await execFileAsync("node", [helper, "prepare-review", "--input", reviewInput, "--out", reviewOut])).stdout) as { requestPath: string };
    assert.equal(JSON.parse(await readFile(review.requestPath, "utf8")).globalConcurrencyLimit, 1);
    const issuesFile = join(artifacts, "issues.json");
    await writeFile(issuesFile, JSON.stringify({ issues: [{ number: 1, title: "one", body: "## Acceptance Criteria\\n- [ ] Works" }] }));
    await assert.rejects(execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1", "--cwd", root, "--issues-file", issuesFile, "--out", join(artifacts, "dispatch-out")]), /orchestration\.max_concurrent must be an integer from 1 through 32/);
    await writeFile(join(root, "forge.yaml"), oversized.replace("reviewer_timeout_ms: 1000", "reviewer_timeout_ms: 0"));
    await execFileAsync("git", ["add", "forge.yaml"], { cwd: root });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "invalid-review-fixture"], { cwd: root });
    const invalidHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await writeFile(reviewInput, JSON.stringify({ repository: "example/product", pullRequest: 7, head: invalidHead, baseRef: "integration", baseSha, sourceRoot: root, acceptance: ["The review is independently observable."] }));
    await assert.rejects(execFileAsync("node", [helper, "prepare-review", "--input", reviewInput, "--out", join(artifacts, "invalid-review-out")]), /review\.reviewer_timeout_ms must be an integer/);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("staging gate records retain the exact gate marker", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-cli-");
  try {
    const body = join(root, "gate-body.md");
    const report = join(root, "gate.report.md");
    await writeFile(body, "The frozen promotion checks and reviewer reports are complete.");
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "--kind", "STAGING_GATE", "--repo", "example/product", "--pr", "3", "--head", "a".repeat(40), "--base-ref", "main", "--base-sha", "b".repeat(40), "--gate", "PASS", "--body-file", body, "--report-file", report])).stdout) as { publication: string };
    assert.equal(result.publication, "saved");
    assert.match(await readFile(report, "utf8"), /FORGE:STAGING_GATE:PASS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("record helper preserves a saved reviewer report without remote writes", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-cli-");
  try {
    const body = join(root, "body.md");
    const report = join(root, "report.md");
    await writeFile(body, "### Scope and decisions considered\nReviewed the frozen patch.\n\n### Evidence and findings\nNo blocking findings.\n\n### Verification limitations\nNo remote write was attempted.\n\n### Recommendation\nApprove after normal parent adjudication.\n");
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "reviewer", "--repo", "example/product", "--pr", "3", "--head", "a".repeat(40), "--base-ref", "integration", "--base-sha", "b".repeat(40), "--role", "correctness", "--body-file", body, "--report-file", report])).stdout) as { publication: string; reportFile: string };
    assert.equal(result.publication, "saved");
    assert.equal(result.reportFile, report);
    assert.match(await readFile(report, "utf8"), /^<!-- FORGE:REVIEWER_REPORT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
