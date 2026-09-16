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
    const issuesFile = join(root, "issues.json");
    await writeFile(issuesFile, JSON.stringify({ issues: [
      { number: 2, title: "dependent", body: "## Acceptance Criteria\n- [ ] Consumer works\n\nDepends on #1" },
      { number: 1, title: "base", body: "## Acceptance Criteria\n- [ ] Producer works" },
    ] }));
    const testName = root.slice(root.lastIndexOf("/") + 1);
    const out = join(root, "..", `${testName}-dispatch`);
    const dispatch = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--cwd", root, "--issues-file", issuesFile, "--out", out])).stdout) as { requestPath: string; planPath: string };
    const plan = JSON.parse(await readFile(dispatch.planPath, "utf8")) as { issues: Array<{ number: number; predecessors: string[] }>; readiness: { missingAcceptance: number[] } };
    assert.deepEqual(plan.issues.map((issue) => issue.number), [1, 2]);
    assert.deepEqual(plan.issues[1]?.predecessors, ["issue-1"]);
    assert.deepEqual(plan.readiness.missingAcceptance, []);
    const request = JSON.parse(await readFile(dispatch.requestPath, "utf8")) as { workflowScriptPath: string; globalConcurrencyLimit: number };
    assert.equal(request.globalConcurrencyLimit, 2);
    assert.match(await readFile(request.workflowScriptPath, "utf8"), /forgedock-owner/);
    await rm(out, { recursive: true, force: true });

    await rm(issuesFile, { force: true });
    const reviewInput = join(root, "..", `${root.slice(root.lastIndexOf("/") + 1)}-review.json`);
    const reviewOut = join(root, "..", `${root.slice(root.lastIndexOf("/") + 1)}-review-out`);
    await writeFile(reviewInput, JSON.stringify({ repository: "example/product", pullRequest: 3, head: sourceHead, baseRef: "integration", baseSha, sourceRoot: root }));
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
