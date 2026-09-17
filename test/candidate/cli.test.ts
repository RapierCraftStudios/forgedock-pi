import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
orchestration:
  max_concurrent: 2
verification:
  commands:
    test: npm test
review:
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
    const testName = root.slice(root.lastIndexOf("/") + 1);
    const issuesFile = join(root, "..", `${testName}-issues.json`);
    await writeFile(issuesFile, JSON.stringify({ issues: [
      { number: 2, title: "dependent", body: "## Acceptance Criteria\n- [ ] Consumer works\n\nDepends on #1" },
      { number: 1, title: "base", body: "## Acceptance Criteria\r\n- [ ] Producer behavior works\r\n  It must remain compatible.\r\n\r\n- [ ] Second obligation works\r\n\r\n## Affected Files\r\n- `src/producer.ts:10`\r\n- `src/consumer.ts`\r\n\r\n## Notes\r\nThis paragraph is not another criterion." },
      { number: 3, title: "unstructured", body: "Fix the consumer timeout when the queue is empty; preserve compatibility." },
    ] }));
    const out = join(root, "..", `${testName}-dispatch`);
    const dispatch = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--cwd", root, "--issues-file", issuesFile, "--out", out])).stdout) as { requestPath: string; planPath: string };
    const plan = JSON.parse(await readFile(dispatch.planPath, "utf8")) as { issues: Array<{ number: number; predecessors: string[]; acceptance: string[]; mutationFiles: string[]; body: string; task: string; admitted?: boolean }>; readiness: { missingAcceptance: number[]; unstructuredAcceptance: number[] } };
    assert.deepEqual(plan.issues.map((issue) => issue.number), [1, 2, 3]);
    assert.deepEqual(plan.issues[1]?.predecessors, ["issue-1"]);
    assert.deepEqual(plan.readiness.missingAcceptance, []);
    assert.deepEqual(plan.readiness.unstructuredAcceptance, [3]);
    assert.equal(plan.issues[2]?.admitted, true);
    assert.deepEqual(plan.issues[0]?.acceptance, ["Producer behavior works\n  It must remain compatible.", "Second obligation works"]);
    assert.deepEqual(plan.issues[0]?.mutationFiles, ["src/producer.ts", "src/consumer.ts"]);
    assert.match(plan.issues[0]?.body ?? "", /This paragraph is not another criterion/);
    assert.match(plan.issues[0]?.task ?? "", /Second obligation works/);
    const request = JSON.parse(await readFile(dispatch.requestPath, "utf8")) as { workflowScriptPath: string; globalConcurrencyLimit: number };
    assert.equal(request.globalConcurrencyLimit, 2);
    assert.match(await readFile(request.workflowScriptPath, "utf8"), /forgedock-owner/);
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
    assert.match(await readFile(join(reviewOut, "workflow.js"), "utf8"), /forgedock-reviewer/);
    const invalidRoles = join(root, "..", `${testName}-invalid-review.json`);
    await writeFile(invalidRoles, JSON.stringify({ repository: "example/product", pullRequest: 3, head: sourceHead, baseRef: "integration", baseSha, sourceRoot: root, roles: ["security"] }));
    await assert.rejects(execFileAsync("node", [helper, "prepare-review", "--input", invalidRoles, "--out", `${reviewOut}-invalid`]), /correctness reviewer/);
    await rm(invalidRoles, { force: true });
    await rm(reviewOut, { recursive: true, force: true });
  } finally {
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
