import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helper = resolve("bin/forgedock-candidate.mjs");

const fakeGh = `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.FAKE_POLICY_STATE, "utf8"));
const args = process.argv.slice(2);
const out = (value, code = 0) => { process.stdout.write(JSON.stringify(value)); process.exit(code); };
if (args[0] === "pr" && args[1] === "view") out(state.pull);
if (args[0] === "pr" && args[1] === "checks") out(state.requiredChecks, state.requiredExit ?? 0);
if (args[0] !== "api") process.exit(2);
const endpoint = args.find((value) => value.startsWith("repos/"));
if (endpoint?.includes("/rulesets/") && !endpoint.includes("?")) {
  const id = endpoint.split("/").at(-1);
  if (state.ruleDetails?.[id]?.error) { console.error(state.ruleDetails[id].error); process.exit(1); }
  out(state.ruleDetails?.[id] ?? {});
}
if (endpoint?.endsWith("/rulesets?includes_parents=true")) {
  if (state.rulesetsError) { console.error(state.rulesetsError); process.exit(1); }
  out(state.rulesets ?? []);
}
if (endpoint?.includes("/branches/") && endpoint.endsWith("/protection")) {
  if (state.protectionError) { console.error(state.protectionError); process.exit(1); }
  out(state.protection ?? {});
}
if (endpoint?.includes("/rules/branches/")) {
  if (state.branchRulesError) { console.error(state.branchRulesError); process.exit(1); }
  out(state.branchRules ?? []);
}
if (endpoint?.includes("/check-runs")) out(state.checkRuns ?? []);
if (endpoint?.endsWith("/status")) out(state.statuses ?? { statuses: [] });
if (endpoint?.includes("/contents/.github/workflows")) out(state.workflowFiles ?? []);
process.exit(2);
`;

const config = `
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
`;

async function fixture(configText = config) {
  const root = await mkdtemp("/tmp/forgedock-candidate-policy-");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), fakeGh, { mode: 0o755 });
  await writeFile(join(root, "forge.yaml"), configText);
  await writeFile(join(root, "README.md"), "policy\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
  await execFileAsync("git", ["add", "README.md", "forge.yaml"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const state = join(root, "state.json");
  await writeFile(state, JSON.stringify({
    pull: { headRefOid: head, baseRefName: "integration", baseRefOid: "b".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", state: "OPEN", isDraft: false, url: "https://github.com/example/product/pull/7" },
    requiredChecks: [],
    requiredExit: 1,
    rulesets: [{ id: 1, name: "Promotion rules", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/main"] } }, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }] } }] }],
    ruleDetails: { "1": { id: 1, name: "Promotion rules", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/main"] } }, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }] } }] } },
    protection: { required_status_checks: { strict: false, contexts: ["CI"] } },
    branchRules: [],
    checkRuns: [{ name: "stale", status: "completed", conclusion: "success", head_sha: "c".repeat(40), app: { slug: "github-actions" } }, { name: "current", status: "completed", conclusion: "neutral", head_sha: head, app: { slug: "github-actions" } }],
    statuses: { statuses: [{ context: "external", state: "success", description: "current", target_url: "https://ci.example/status", creator: { login: "ci" } }] },
    workflowFiles: [{ name: "ci.yml", path: ".github/workflows/ci.yml", sha: "d".repeat(40), html_url: "https://github.com/example/product/blob/integration/.github/workflows/ci.yml", download_url: "https://raw.example/token=secret" }],
  }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_POLICY_STATE: state };
  return { root, state, head, env };
}

async function run(f: Awaited<ReturnType<typeof fixture>>, pr = 7) {
  return JSON.parse((await execFileAsync("node", [helper, "inspect-pr", "--repo", "example/product", "--pr", String(pr), "--cwd", f.root], { env: f.env })).stdout) as Record<string, any>;
}

test("inspect-pr ignores unrelated dispatch concurrency limits", async () => {
  const f = await fixture(config.replace("max_concurrent: 2", "max_concurrent: 300"));
  try {
    const result = await run(f);
    assert.equal(result.identity.head, f.head);
    assert.equal(result.configuration.integrationBranch, "integration");
    assert.equal(result.configuration.protectedBranch, "main");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("inspect-pr preserves route policy facts and does not infer requiredness from empty checks", async () => {
  const f = await fixture();
  try {
    const result = await run(f);
    assert.equal(result.identity.head, f.head);
    assert.equal(result.identity.baseRef, "integration");
    assert.equal(result.policy.evaluatedRequiredChecks.status, "command-failed-with-data");
    assert.equal(result.policy.evaluatedRequiredChecks.exitCode, 1);
    assert.equal(result.policy.commitCheckRuns.data.find((row: any) => row.name === "stale").headMatched, false);
    assert.equal(result.policy.commitCheckRuns.data.find((row: any) => row.name === "current").headMatched, true);
    assert.equal(result.policy.rulesets.details[0].data.conditions.ref_name.include[0], "refs/heads/main");
    assert.equal(result.policy.legacyBranchProtection.data.required_status_checks.contexts[0], "CI");
    assert.equal(result.policy.workflowFiles.data[0].download_url, undefined);
    assert.match(result.policy.interpretation, /not inferred/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("inspect-pr retains pending and failed check facts without collapsing them", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.requiredChecks = [{ name: "CI", state: "PENDING", bucket: "pending" }, { name: "optional-lint", state: "FAILURE", bucket: "fail" }];
    state.requiredExit = 8;
    await writeFile(f.state, JSON.stringify(state));
    const result = await run(f);
    assert.equal(result.policy.evaluatedRequiredChecks.status, "command-failed-with-data");
    assert.deepEqual(result.policy.evaluatedRequiredChecks.data.map((row: any) => row.name), ["CI", "optional-lint"]);
    assert.equal(result.policy.evaluatedRequiredChecks.data[0].state, "PENDING");
    assert.equal(result.policy.evaluatedRequiredChecks.data[1].bucket, "fail");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("active routes use repository-driven policy and external dispatcher artifacts", async () => {
  const workOn = await readFile("candidate/skills/forgedock-work-on/SKILL.md", "utf8");
  const review = await readFile("candidate/skills/forgedock-review-pr/SKILL.md", "utf8");
  const orchestrate = await readFile("candidate/skills/forgedock-orchestrate/SKILL.md", "utf8");
  assert.match(workOn, /inspect-pr --repo/);
  assert.match(workOn, /empty\/nonzero.*not.*requirement|nonzero.*not.*proof/i);
  assert.match(review, /requiredness.*applicable.*rules/);
  assert.match(review, /forge_prepare_review.*not.*shell helper|prepared policy.*activates the route guard/s);
  assert.match(review, /deterministic validation error.*Do not retry/s);
  assert.match(orchestrate, /outside[\s\S]*\$PWD/);
  assert.match(orchestrate, /completed GATED owner is not a failed execution/);
});

test("policy visibility failures remain explicit instead of becoming no-requirement", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.rulesetsError = "HTTP 403 Resource not accessible";
    state.protectionError = "HTTP 404 Not Found";
    await writeFile(f.state, JSON.stringify(state));
    const result = await run(f);
    assert.equal(result.policy.rulesets.listing.status, "unavailable");
    assert.equal(result.policy.legacyBranchProtection.status, "unavailable");
    assert.match(result.policy.rulesets.listing.error, /403/);
    assert.match(result.policy.legacyBranchProtection.error, /404/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
