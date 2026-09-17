import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
if (endpoint?.endsWith("/rulesets?includes_parents=true")) output(state.rulesets ?? []);
if (endpoint?.includes("/rulesets/") && !endpoint.includes("?")) output(state.ruleDetails ?? {});
if (endpoint?.includes("/branches/") && endpoint.endsWith("/protection")) output(state.protection ?? {});
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

async function fixture() {
  const root = await mkdtemp("/tmp/forgedock-restricted-staging-");
  const bin = await mkdtemp("/tmp/forgedock-restricted-staging-bin-");
  await writeFile(join(bin, "gh"), fakeGh, { mode: 0o755 });
  await writeFile(join(root, "README.md"), "base\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
  const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await writeFile(join(root, "forge.yaml"), config);
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

test("restricted staging preparation exposes policy and PASS works with no local checks", async () => {
  const f = await fixture();
  try {
    const fakePi = { exec: (name: string, args: string[] = [], options: { cwd?: string } = {}) => execFileAsync(name, args, { cwd: options.cwd, env: f.env }).then((result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr })) };
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
    const details = prepared.details;
    assert.equal(details.policy.schema, "forgedock.candidate-pr-policy/v1");
    assert.equal(details.policy.identity.head, f.head);
    assert.equal(details.policy.policy.evaluatedRequiredChecks.data[0].name, "CI");
    await writeFile(join(details.reviewRoot, "correctness.report.md"), `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, role: "correctness" })} -->\nclean reviewer report\n`);
    const result = await publish.execute("publish", {
      repository: "example/product", pullRequest: 7, kind: "STAGING_GATE", head: f.head, baseRef: "main", baseSha: f.base, gate: "PASS", checks: [],
      reviewRoot: details.reviewRoot, artifactKey: details.artifactKey, body: "FORGE:STAGING_GATE:PASS\nGitHub checks are complete.", publish: true, policy: details.policy,
    });
    assert.equal(result.details.publication, "published");
    assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments.length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
  }
});

test("restricted PASS rejects missing or failed GitHub requirements", async () => {
  const f = await fixture();
  try {
    const fakePi = { exec: (name: string, args: string[] = [], options: { cwd?: string } = {}) => execFileAsync(name, args, { cwd: options.cwd, env: f.env }).then((result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr })) };
    const tools = toolMap(fakePi);
    const prepare = tools.get("forge_prepare_review")!;
    const publish = tools.get("forge_publish_record")!;
    const params = { repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, sourceRoot: f.root, configRoot: f.root, roles: ["correctness"], publish: false };
    const prepared = await prepare.execute("prepare", params);
    const details = prepared.details;
    await writeFile(join(details.reviewRoot, "correctness.report.md"), `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, role: "correctness" })} -->\nclean reviewer report\n`);
    const base = { repository: "example/product", pullRequest: 7, kind: "STAGING_GATE", head: f.head, baseRef: "main", baseSha: f.base, gate: "PASS", checks: [], reviewRoot: details.reviewRoot, artifactKey: details.artifactKey, body: "FORGE:STAGING_GATE:PASS\nEvidence.", publish: false };
    const missing = structuredClone(details.policy);
    missing.policy.evaluatedRequiredChecks = { status: "unavailable", exitCode: 1, data: [] };
    await assert.rejects(publish.execute("missing", { ...base, policy: missing }), /missing or empty/);
    const failed = structuredClone(details.policy);
    failed.policy.evaluatedRequiredChecks = { status: "available", exitCode: 1, data: [{ name: "CI", state: "FAILURE", bucket: "fail" }] };
    await assert.rejects(publish.execute("failed", { ...base, policy: failed }), /not all satisfied/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
  }
});
