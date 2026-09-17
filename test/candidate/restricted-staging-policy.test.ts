import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { isStagingMutationBlocked } from "../../candidate/extension.ts";
import registerCandidateTools from "../../candidate/tools.ts";

const execFileAsync = promisify(execFile);
const helper = resolve("bin/forgedock-candidate.mjs");

const fakeGh = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const state = existsSync(process.env.FAKE_STAGING_STATE) ? JSON.parse(readFileSync(process.env.FAKE_STAGING_STATE, "utf8")) : {};
const args = process.argv.slice(2);
const output = (value, code = 0) => { process.stdout.write(JSON.stringify(value)); process.exit(code); };
if (args[0] === "pr" && args[1] === "view") output(state.pull);
if (args[0] === "pr" && args[1] === "checks") output(state.requiredChecks, state.requiredExit ?? 0);
if (args[0] !== "api") process.exit(2);
const endpoint = args.find((value) => value.startsWith("repos/"));
if (endpoint?.endsWith("/rulesets?includes_parents=true")) {
  if (state.rulesetsError) { console.error(state.rulesetsError); process.exit(1); }
  output(state.rulesets ?? []);
}
if (endpoint?.includes("/rulesets/") && !endpoint.includes("?")) output(state.ruleDetails ?? {});
if (endpoint?.includes("/branches/") && endpoint.endsWith("/protection")) {
  if (state.protectionError) { console.error(state.protectionError); process.exit(1); }
  output(state.protection ?? {});
}
if (endpoint?.includes("/rules/branches/")) {
  if (state.branchRulesError) { console.error(state.branchRulesError); process.exit(1); }
  output(state.branchRules ?? []);
}
if (endpoint?.includes("/check-runs")) output([{ check_runs: state.checkRuns ?? [] }]);
if (endpoint?.endsWith("/status")) output(state.statuses ?? { statuses: [] });
if (endpoint?.includes("/contents/.github/workflows")) output([]);
if (endpoint?.includes("/issues/7/comments") && !args.includes("--method")) output([state.comments ?? []]);
if (endpoint?.includes("/issues/7/comments") && args.includes("--method")) {
  const bodyArg = args.find((value) => value.startsWith("body=@"));
  const body = readFileSync(bodyArg.slice("body=@".length), "utf8");
  const comment = { id: 77, body, html_url: "https://github.com/example/product/pull/7#issuecomment-77" };
  state.comments = [comment];
  writeFileSync(process.env.FAKE_STAGING_STATE, JSON.stringify(state));
  output(comment);
}
if (endpoint?.includes("/issues/comments/77")) output((state.comments ?? [])[0]);
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
review:
  remediation_max_rounds: 1
`;

async function fixture(withLocalCheck = false) {
  const root = await mkdtemp("/tmp/forgedock-restricted-staging-");
  const bin = await mkdtemp("/tmp/forgedock-restricted-staging-bin-");
  await writeFile(join(bin, "gh"), fakeGh, { mode: 0o755 });
  await writeFile(join(root, "README.md"), "base\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
  const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const configText = withLocalCheck ? `${config}\nverification:\n  commands:\n    test: echo configured\n` : config;
  await writeFile(join(root, "forge.yaml"), configText);
  await execFileAsync("git", ["add", "forge.yaml"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "config"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await execFileAsync("git", ["branch", "-M", "feature"], { cwd: root });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", base], { cwd: root });
  const state = join(root, "..", `forgedock-restricted-staging-state-${root.split("/").at(-1)}.json`);
  await writeFile(state, JSON.stringify({
    pull: { headRefOid: head, baseRefName: "main", baseRefOid: base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", state: "OPEN", isDraft: false, url: "https://github.com/example/product/pull/7" },
    requiredChecks: [{ name: "CI", state: "SUCCESS", bucket: "pass", workflow: "CI", link: "https://github.com/example/product/actions/runs/1" }],
    requiredExit: 0,
    rulesets: [],
    branchRules: [],
    protection: { required_status_checks: { strict: true, contexts: ["CI"] } },
    checkRuns: [{ name: "CI", head_sha: head, status: "completed", conclusion: "success" }],
    statuses: { statuses: [] },
    comments: [],
  }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STAGING_STATE: state };
  return { root, bin, state, base, head, env };
}

function toolMap(fakePi: { exec: (...args: any[]) => Promise<any> }) {
  const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<any> }>();
  registerCandidateTools({
    registerTool(definition: { name: string; execute: (id: string, params: unknown) => Promise<any> }) { tools.set(definition.name, definition); },
    exec: fakePi.exec,
  } as never);
  return tools;
}

function modelArtifacts(prepared: any) {
  const content = prepared.content[0].text as string;
  const handoff = content.indexOf(String.fromCharCode(10) + String.fromCharCode(10) + "PR policy evidence saved at ");
  assert.ok(handoff > 0);
  const preparation = JSON.parse(content.slice(0, handoff));
  const policyPath = content.slice(handoff).split("PR policy evidence saved at ")[1]?.split(". The existing")[0];
  assert.ok(policyPath);
  const reviewRoot = preparation.out as string;
  const review = JSON.parse(readFileSync(join(reviewRoot, "review.json"), "utf8"));
  return { content, reviewRoot, policyPath, artifactKey: review.artifactKey, review };
}

function fakeExecutor(env: NodeJS.ProcessEnv, calls: Array<{ name: string; args: string[] }>) {
  return {
    exec: async (name: string, args: string[] = [], options: { cwd?: string } = {}) => {
      calls.push({ name, args });
      try {
        const result = await execFileAsync(name, args, { cwd: options.cwd, env });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error: any) {
        return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) };
      }
    },
  };
}

async function reviewerReport(root: string, review: any) {
  const newline = String.fromCharCode(10);
  await writeFile(join(root, "correctness.report.md"), `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ repository: review.repository, pullRequest: review.pullRequest, head: review.head, baseRef: review.baseRef, baseSha: review.baseSha, role: "correctness" })} -->${newline}clean reviewer report${newline}`);
}

async function stagedContext(f: Awaited<ReturnType<typeof fixture>>, publish = false) {
  const calls: Array<{ name: string; args: string[] }> = [];
  const tools = toolMap(fakeExecutor(f.env, calls));
  const prepared = await tools.get("forge_prepare_review")!.execute("prepare", { repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, sourceRoot: f.root, configRoot: f.root, roles: ["correctness"], publish });
  const artifacts = modelArtifacts(prepared);
  await reviewerReport(artifacts.reviewRoot, artifacts.review);
  return { calls, tools, artifacts };
}

function gateInput(f: Awaited<ReturnType<typeof fixture>>, artifacts: ReturnType<typeof modelArtifacts>, publish = false) {
  return { repository: "example/product", pullRequest: 7, kind: "STAGING_GATE", head: f.head, baseRef: "main", baseSha: f.base, gate: "PASS", checks: [], reviewRoot: artifacts.reviewRoot, artifactKey: artifacts.artifactKey, body: "FORGE:STAGING_GATE:PASS\\nEvidence.", publish };
}

test("restricted staging preparation exposes policy in content and PASS works with no local checks", async () => {
  const f = await fixture();
  try {
    const calls: Array<{ name: string; args: string[] }> = [];
    const fakePi = fakeExecutor(f.env, calls);
    const tools = toolMap(fakePi);
    const prepare = tools.get("forge_prepare_review");
    const publish = tools.get("forge_publish_record");
    assert.ok(prepare);
    assert.ok(publish);
    const params = { repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, sourceRoot: f.root, configRoot: f.root, roles: ["correctness"], publish: true };
    assert.equal(isStagingMutationBlocked("forge_prepare_review", params), false);
    assert.equal(isStagingMutationBlocked("forge_publish_record", params), false);
    assert.equal(isStagingMutationBlocked("bash", {}), true);
    const prepared = await prepare.execute("prepare", params);
    const artifacts = modelArtifacts(prepared);
    const policyArtifact = JSON.parse(await readFile(artifacts.policyPath, "utf8"));
    assert.equal(policyArtifact.schema, "forgedock.candidate-policy/v1");
    assert.equal(policyArtifact.current.identity.head, f.head);
    assert.match(artifacts.content, /Compact summary:/);
    await reviewerReport(artifacts.reviewRoot, artifacts.review);
    const result = await publish.execute("publish", {
      repository: "example/product", pullRequest: 7, kind: "STAGING_GATE", head: f.head, baseRef: "main", baseSha: f.base, gate: "PASS", checks: [],
      reviewRoot: artifacts.reviewRoot, artifactKey: artifacts.artifactKey, body: "FORGE:STAGING_GATE:PASS\nGitHub checks are complete.", publish: true,
    });
    assert.equal(result.details.publication, "published");
    assert.equal(calls.filter((call) => call.args.includes("prepare-review")).length, 1);
    assert.equal(calls.filter((call) => call.args.includes("inspect-pr")).length, 2);
    assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments.length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("confirmed zero GitHub requirements use configured local receipts without a dummy job", async () => {
  const f = await fixture(true);
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.requiredChecks = [];
    state.requiredExit = 1;
    state.protection.required_status_checks = { strict: false, contexts: [] };
    state.checkRuns = [];
    await writeFile(f.state, JSON.stringify(state));
    const ctx = await stagedContext(f);
    const review = ctx.artifacts.review;
    await mkdir(join(ctx.artifacts.reviewRoot, "checks"));
    await writeFile(join(ctx.artifacts.reviewRoot, "checks", "test.json"), JSON.stringify({ schema: "forgedock.candidate-check/v1", name: "test", status: "passed", sourceRoot: review.sourceRoot, head: f.head, configPath: review.configPath, configSha256: review.configSha256 }));
    const result = await ctx.tools.get("forge_publish_record")!.execute("publish", { ...gateInput(f, ctx.artifacts), checks: ["test"] });
    assert.equal(result.details.publication, "saved");
    const artifact = JSON.parse(await readFile(ctx.artifacts.policyPath, "utf8"));
    assert.equal(artifact.current.policy.requirements.applicability, "confirmed-none");
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("evaluated branch rules are paginated and a missing active requirement blocks PASS", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.protection.required_status_checks.contexts = [];
    state.branchRules = [
      [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }] }, ruleset_source: "repo" }],
      [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "Shadow" }] }, ruleset_source: "parent" }],
    ];
    state.requiredChecks = [{ name: "CI", state: "SUCCESS", bucket: "pass" }];
    state.requiredExit = 0;
    await writeFile(f.state, JSON.stringify(state));
    const ctx = await stagedContext(f);
    const artifact = JSON.parse(await readFile(ctx.artifacts.policyPath, "utf8"));
    assert.equal(artifact.current.policy.requirements.applicability, "known-required-missing");
    assert.deepEqual(artifact.current.policy.requirements.missingRequiredNames, ["Shadow"]);
    await assert.rejects(ctx.tools.get("forge_publish_record")!.execute("publish", gateInput(f, ctx.artifacts)), /missing: Shadow/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("disabled and evaluate branch rules do not impose requirements", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.protection.required_status_checks.contexts = [];
    state.branchRules = [[
      { type: "required_status_checks", enforcement: "disabled", parameters: { required_status_checks: [{ context: "Disabled" }] } },
      { type: "required_status_checks", enforcement: "evaluate", parameters: { required_status_checks: [{ context: "Evaluate" }] } },
    ]];
    state.requiredChecks = [];
    state.requiredExit = 1;
    await writeFile(f.state, JSON.stringify(state));
    const ctx = await stagedContext(f);
    const result = await ctx.tools.get("forge_publish_record")!.execute("publish", gateInput(f, ctx.artifacts));
    assert.equal(result.details.publication, "saved");
    const artifact = JSON.parse(await readFile(ctx.artifacts.policyPath, "utf8"));
    assert.equal(artifact.current.policy.requirements.applicability, "confirmed-none");
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("GitHub resolves wildcard branch applicability while incomplete evaluation stays unknown", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.protection.required_status_checks.contexts = [];
    state.rulesets = [{ id: 1, conditions: { ref_name: { include: ["refs/heads/*"] } }, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "LocalWildcard" }] } }] }];
    state.ruleDetails = { "1": { id: 1, conditions: { ref_name: { include: ["refs/heads/*"] } }, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "LocalWildcard" }] } }] } };
    state.branchRules = [[{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI" }] }, ruleset_source: "github-evaluated" }]];
    state.requiredChecks = [{ name: "CI", state: "SUCCESS", bucket: "pass" }];
    state.requiredExit = 0;
    await writeFile(f.state, JSON.stringify(state));
    const ctx = await stagedContext(f);
    const result = await ctx.tools.get("forge_publish_record")!.execute("publish", gateInput(f, ctx.artifacts));
    assert.equal(result.details.publication, "saved");
    const artifact = JSON.parse(await readFile(ctx.artifacts.policyPath, "utf8"));
    assert.equal(artifact.current.policy.requirements.applicability, "known-required");
    assert.deepEqual(artifact.current.policy.requirements.requiredNames, ["CI"]);

    const incomplete = JSON.parse(await readFile(f.state, "utf8"));
    incomplete.branchRulesError = "HTTP 403 Resource not accessible";
    incomplete.requiredChecks = [{ name: "CI", state: "SUCCESS", bucket: "pass" }];
    incomplete.requiredExit = 0;
    await writeFile(f.state, JSON.stringify(incomplete));
    await assert.rejects(ctx.tools.get("forge_publish_record")!.execute("incomplete", gateInput(f, ctx.artifacts)), /unknown|missing|empty/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("completed skipped and neutral GitHub conclusions accepted by policy can pass", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.protection.required_status_checks.contexts = ["CI", "Shadow"];
    state.requiredChecks = [{ name: "CI", state: "SKIPPED", bucket: "pass" }, { name: "Shadow", state: "NEUTRAL", bucket: "pass" }];
    state.requiredExit = 0;
    await writeFile(f.state, JSON.stringify(state));
    const ctx = await stagedContext(f);
    const result = await ctx.tools.get("forge_publish_record")!.execute("publish", gateInput(f, ctx.artifacts));
    assert.equal(result.details.publication, "saved");
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("two applicable required checks with one reported remain unsatisfied", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.protection.required_status_checks.contexts = ["CI", "Shadow"];
    state.requiredChecks = [{ name: "CI", state: "SUCCESS", bucket: "pass" }];
    state.requiredExit = 0;
    await writeFile(f.state, JSON.stringify(state));
    const ctx = await stagedContext(f);
    await assert.rejects(ctx.tools.get("forge_publish_record")!.execute("publish", gateInput(f, ctx.artifacts)), /missing: Shadow/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("policy refresh observes check progress without a new review root", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.requiredChecks = [{ name: "CI", state: "PENDING", bucket: "pending" }];
    state.requiredExit = 1;
    await writeFile(f.state, JSON.stringify(state));
    const ctx = await stagedContext(f);
    const reviewRoot = ctx.artifacts.reviewRoot;
    const progressed = JSON.parse(await readFile(f.state, "utf8"));
    progressed.requiredChecks = [{ name: "CI", state: "SUCCESS", bucket: "pass" }];
    progressed.requiredExit = 0;
    await writeFile(f.state, JSON.stringify(progressed));
    const result = await ctx.tools.get("forge_publish_record")!.execute("publish", gateInput(f, ctx.artifacts));
    assert.equal(result.details.publication, "saved");
    assert.equal(ctx.artifacts.reviewRoot, reviewRoot);
    assert.equal(ctx.calls.filter((call) => call.args.includes("prepare-review")).length, 1);
    assert.equal(ctx.calls.filter((call) => call.args.includes("inspect-pr")).length, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("restricted PASS rejects missing or failed GitHub requirements", async () => {
  const f = await fixture();
  try {
    const calls: Array<{ name: string; args: string[] }> = [];
    const fakePi = fakeExecutor(f.env, calls);
    const tools = toolMap(fakePi);
    const prepare = tools.get("forge_prepare_review")!;
    const publish = tools.get("forge_publish_record")!;
    const params = { repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, sourceRoot: f.root, configRoot: f.root, roles: ["correctness"], publish: false };
    const prepared = await prepare.execute("prepare", params);
    const artifacts = modelArtifacts(prepared);
    await reviewerReport(artifacts.reviewRoot, artifacts.review);
    const base = { repository: "example/product", pullRequest: 7, kind: "STAGING_GATE", head: f.head, baseRef: "main", baseSha: f.base, gate: "PASS", checks: [], reviewRoot: artifacts.reviewRoot, artifactKey: artifacts.artifactKey, body: "FORGE:STAGING_GATE:PASS\nEvidence.", publish: false };
    const unknownState = JSON.parse(await readFile(f.state, "utf8"));
    unknownState.rulesetsError = "HTTP 403 Resource not accessible";
    unknownState.protectionError = "HTTP 404 Not Found";
    unknownState.requiredChecks = [];
    unknownState.requiredExit = 1;
    await writeFile(f.state, JSON.stringify(unknownState));
    await assert.rejects(publish.execute("unknown", base), /unknown|missing|empty/);

    const failedState = JSON.parse(await readFile(f.state, "utf8"));
    delete failedState.rulesetsError;
    delete failedState.protectionError;
    failedState.requiredChecks = [{ name: "CI", state: "FAILURE", bucket: "fail" }];
    failedState.requiredExit = 0;
    await writeFile(f.state, JSON.stringify(failedState));
    await assert.rejects(publish.execute("failed", base), /not all satisfied/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});
