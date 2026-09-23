import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import forgedockCandidateExtension, { isStagingMutationBlocked } from "../../candidate/extension.ts";
import registerCandidateTools from "../../candidate/tools.ts";
import registerReviewerTools from "../../candidate/reviewer-tools.ts";

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
  const newline = String.fromCharCode(10);
  const lineEnd = body.indexOf(newline);
  const marker = body.slice(0, lineEnd < 0 ? body.length : lineEnd);
  state.postAttempts = [...(state.postAttempts ?? []), marker];
  const markerPrefix = "<!-- FORGE:REVIEWER_REPORT ";
  const markerSuffix = " -->";
  const markerData = marker.startsWith(markerPrefix) && marker.endsWith(markerSuffix) ? marker.slice(markerPrefix.length, -markerSuffix.length) : "";
  let role;
  try { role = JSON.parse(markerData).role; } catch {}
  const failRole = typeof role === "string" && state.failNextReviewerRole === role;
  if (failRole) state.failNextReviewerRole = null;
  writeFileSync(process.env.FAKE_STAGING_STATE, JSON.stringify(state));
  if (state.commentPostFailure || failRole) { console.error("controlled comment transport failure"); process.exit(1); }
  const id = state.nextComment ?? 77;
  state.nextComment = id + 1;
  const comment = { id, body, html_url: "https://github.com/example/product/pull/7#issuecomment-" + id };
  state.comments = [...(state.comments ?? []), comment];
  writeFileSync(process.env.FAKE_STAGING_STATE, JSON.stringify(state));
  output(comment);
}
const commentReadId = Number(endpoint?.split("/issues/comments/").at(-1));
if (Number.isSafeInteger(commentReadId) && commentReadId > 0 && endpoint?.includes("/issues/comments/")) output((state.comments ?? []).find((comment) => comment.id === commentReadId));
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

function toolMap(fakePi: { exec: (...args: any[]) => Promise<any> }, includeReviewerPublisher = false) {
  const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<any> }>();
  const registry = {
    registerTool(definition: { name: string; execute: (id: string, params: unknown) => Promise<any> }) { tools.set(definition.name, definition); },
    exec: fakePi.exec,
  };
  registerCandidateTools(registry as never);
  if (includeReviewerPublisher) registerReviewerTools(registry as never);
  return tools;
}

function extensionEvents() {
  const handlers = new Map<string, (event: any) => any>();
  const toolNames = new Set(["subagent"]);
  forgedockCandidateExtension({
    registerTool(definition: { name: string }) { toolNames.add(definition.name); },
    registerCommand() {},
    getAllTools() { return [...toolNames].map((name) => ({ name })); },
    on(event: string, handler: (event: any) => any) { handlers.set(event, handler); },
  } as never);
  return handlers;
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
  return { content, reviewRoot, policyPath, artifactKey: review.artifactKey, adjudicationPath: join(reviewRoot, "adjudication.json"), review };
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
  const body = "clean reviewer report";
  const observations: unknown[] = [];
  const bodyBytes = `${body}\n`;
  const observationsBytes = `${JSON.stringify(observations, null, 2)}\n`;
  const reportPath = join(root, "correctness.report.md");
  const bodyPath = join(root, "correctness.body.md");
  const observationsPath = join(root, "correctness.observations.json");
  const marker = `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ repository: review.repository, pullRequest: review.pullRequest, head: review.head, baseRef: review.baseRef, baseSha: review.baseSha, role: "correctness", reportId: review.roleArtifactKeys.correctness })} -->`;
  await writeFile(reportPath, `${marker}\n<!-- FORGE:REVIEW_OBSERVATIONS [] -->\n\n## ForgeDock review\n\n${body}\n`);
  await writeFile(bodyPath, bodyBytes);
  await writeFile(observationsPath, observationsBytes);
  await writeFile(join(root, "correctness.publication-recovery.json"), JSON.stringify({
    schema: "forgedock.candidate-review-publication-recovery/v1",
    state: review.publish ? "published" : "saved",
    recoveryAttempts: 0,
    nativeRunId: "native-correctness-run-33800",
    reviewArtifactKey: review.artifactKey,
    roleArtifactKey: review.roleArtifactKeys.correctness,
    suppliedArtifactKey: review.roleArtifactKeys.correctness,
    repository: review.repository,
    pullRequest: review.pullRequest,
    head: review.head,
    baseRef: review.baseRef,
    baseSha: review.baseSha,
    role: "correctness",
    publish: review.publish,
    bodyPath,
    reportPath,
    observationsPath,
    body,
    observations,
    bodySha256: createHash("sha256").update(bodyBytes).digest("hex"),
    observationsSha256: createHash("sha256").update(observationsBytes).digest("hex"),
  }, null, 2));
}

async function writeReviewerExecutionReceipt(root: string, review: any, overrides: Record<string, { nativeRunId: string | null; nativeStatus: string; exitCode: number | null }> = {}) {
  const roleResults = review.roles.map((role: string) => {
    const value = overrides[role] ?? { nativeRunId: `native-${role}-run-33800`, nativeStatus: "completed", exitCode: 0 };
    return { role, ...value, reportPath: join(root, `${role}.report.md`), recoveryPath: join(root, `${role}.publication-recovery.json`) };
  });
  await writeFile(join(root, "panel-launch.claim"), JSON.stringify({ schema: "forgedock.candidate-review-panel-launch/v1", artifactKey: review.artifactKey, workflowSha256: review.workflowSha256, toolCallId: "fixture-reviewer-tool-call", claimedAt: new Date().toISOString() }));
  await writeFile(join(root, "reviewer-execution.json"), JSON.stringify({
    schema: "forgedock.candidate-review-execution/v1",
    repository: review.repository,
    pullRequest: review.pullRequest,
    head: review.head,
    baseRef: review.baseRef,
    baseSha: review.baseSha,
    artifactKey: review.artifactKey,
    mode: review.mode,
    workflowPath: review.workflowPath,
    workflowSha256: review.workflowSha256,
    toolCallId: "fixture-reviewer-tool-call",
    workflowRunId: "fixture-workflow-run-33800",
    completedAt: new Date().toISOString(),
    roleResults,
  }, null, 2));
}

async function stagedContext(f: Awaited<ReturnType<typeof fixture>>, publish = false) {
  const calls: Array<{ name: string; args: string[] }> = [];
  const tools = toolMap(fakeExecutor(f.env, calls));
  const prepared = await tools.get("forge_prepare_review")!.execute("prepare", { repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, sourceRoot: f.root, configRoot: f.root, roles: ["correctness"], publish });
  const artifacts = modelArtifacts(prepared);
  await reviewerReport(artifacts.reviewRoot, artifacts.review);
  await writeReviewerExecutionReceipt(artifacts.reviewRoot, artifacts.review);
  await writeFile(artifacts.adjudicationPath, JSON.stringify({ schema: "forgedock.candidate-adjudication/v1", artifactKey: artifacts.artifactKey, repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, mode: "staging", gate: "PASS", roles: ["correctness"], reports: [{ role: "correctness", reportId: artifacts.review.roleArtifactKeys.correctness }], decisions: [], verdict: "APPROVE", panelUrl: publish ? "https://github.com/example/product/pull/7#issuecomment-99" : null, trackingPublication: "complete", gateBody: "FORGE:STAGING_GATE:PASS\\n\\n## REVIEW-PANEL\\nPrepared parent decision." }));
  return { calls, tools, artifacts };
}

test("review preparation resolves one clean exact-head worktree without replacing config root", async () => {
  const f = await fixture();
  const exactSource = join(f.root, "review-source");
  try {
    await execFileAsync("git", ["worktree", "add", "--quiet", "--detach", exactSource, f.head], { cwd: f.root });
    await writeFile(join(f.root, "local-only.txt"), "canonical config checkout remains distinct\\n");
    await execFileAsync("git", ["add", "local-only.txt"], { cwd: f.root });
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "advance-config-root"], { cwd: f.root });
    const calls: Array<{ name: string; args: string[] }> = [];
    const tools = toolMap(fakeExecutor(f.env, calls));
    const prepared = await tools.get("forge_prepare_review")!.execute("prepare", {
      repository: "example/product",
      pullRequest: 7,
      head: f.head,
      baseRef: "main",
      baseSha: f.base,
      sourceRoot: f.root,
      configRoot: f.root,
      roles: ["correctness"],
      publish: false,
    });
    const artifacts = modelArtifacts(prepared);
    assert.equal(artifacts.review.sourceRoot, exactSource);
    assert.equal(artifacts.review.configRoot, f.root);
    assert.equal(artifacts.review.head, f.head);
    const policyCall = calls.find((call) => call.name === "node" && call.args.includes("inspect-pr"));
    assert.equal(policyCall?.args.at(-1), f.root);
  } finally {
    await execFileAsync("git", ["worktree", "remove", "--force", exactSource], { cwd: f.root }).catch(() => {});
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("prepared staging review separates task data from reviewer execution", async () => {
  const f = await fixture();
  let reviewRoot: string | undefined;
  let secondReviewRoot: string | undefined;
  try {
    const calls: Array<{ name: string; args: string[] }> = [];
    const tools = toolMap(fakeExecutor(f.env, calls));
    const prepared = await tools.get("forge_prepare_review")!.execute("prepare", {
      repository: "example/product",
      pullRequest: 7,
      head: f.head,
      baseRef: "main",
      baseSha: f.base,
      sourceRoot: f.root,
      configRoot: f.root,
      roles: ["correctness", "security", "specialist"],
      acceptance: ["Preserve worker cache behavior", "Keep writer output readable"],
      history: ["An earlier delegate review discussed the same boundary"],
      publish: false,
    });
    const artifacts = modelArtifacts(prepared);
    reviewRoot = artifacts.reviewRoot;
    const review = artifacts.review;
    const workflowPath = join(reviewRoot, "workflow.js");
    const reviewPath = join(reviewRoot, "review.json");
    const workflow = await readFile(workflowPath, "utf8");
    assert.match(workflow, /worker/);
    assert.match(workflow, /writer/);
    assert.match(workflow, /delegate/);
    assert.match(workflow, /nativeRunId/);
    assert.match(workflow, /publicationState: "unverified"/);
    assert.match(workflow, /recoveryPath/);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;
    const runProjection = new AsyncFunction("runs", workflow);
    const nativeResults = [
      { key: "review-correctness", ok: true, runId: "native-correctness", output: "clean", results: [{ index: 0, agent: "forgedock-reviewer", exitCode: 0 }], artifactPaths: [] },
      { key: "review-security", ok: false, runId: "native-security-timeout", timedOut: true, output: "timeout", results: [{ index: 0, agent: "forgedock-reviewer", exitCode: 1 }], artifactPaths: [] },
      { key: "review-specialist", ok: false, runId: "native-specialist-stop", stopped: true, output: "outer cancellation", results: [{ index: 0, agent: "forgedock-reviewer", exitCode: 1, stopped: true }], artifactPaths: [] },
    ];
    const projected = await runProjection({ all: async () => nativeResults });
    assert.deepEqual(projected.map((result: any) => result.nativeStatus), ["completed", "timed-out", "stopped"]);
    assert.equal(projected[1].nativeFlags.timedOut, true);
    assert.equal(projected[2].nativeFlags.stopped, true);
    const runtimeTimeout = await runProjection({ all: async () => [
      { key: "review-correctness", ok: false, runId: "runtime-timeout", terminalOutcome: { state: "partial", reason: "timeout" }, results: [{ index: 0, agent: "forgedock-reviewer", exitCode: 1, timedOut: true }], artifactPaths: [] },
      { key: "review-security", ok: false, runId: "nonterminal-child", output: "not terminal", results: [{ index: 0, agent: "forgedock-reviewer", exitCode: null }], artifactPaths: [] },
      { key: "review-specialist", ok: false, runId: "budget-limited", terminalOutcome: { state: "partial", reason: "budget_exhausted" }, results: [{ index: 0, agent: "forgedock-reviewer", exitCode: 1, toolBudgetBlocked: true }], artifactPaths: [] },
    ] });
    assert.deepEqual(runtimeTimeout.map((result: any) => result.nativeStatus), ["timed-out", "nonterminal", "execution-limit"]);
    assert.equal(runtimeTimeout[1].nativeFlags.timedOut, false);
    const childTerminalOutcomes = await runProjection({ all: async () => [
      { key: "review-correctness", ok: false, runId: "child-terminal-timeout", results: [{ index: 0, agent: "forgedock-reviewer", terminalOutcome: { state: "partial", reason: "timeout" } }], artifactPaths: [] },
      { key: "review-security", ok: false, runId: "child-terminal-budget", results: [{ index: 0, agent: "forgedock-reviewer", terminalOutcome: { state: "partial", reason: "budget_exhausted" } }], artifactPaths: [] },
      { key: "review-specialist", ok: false, runId: "child-no-terminal", results: [{ index: 0, agent: "forgedock-reviewer", exitCode: null }], artifactPaths: [] },
    ] });
    assert.deepEqual(childTerminalOutcomes.map((result: any) => result.nativeStatus), ["timed-out", "execution-limit", "nonterminal"]);
    assert.equal(childTerminalOutcomes[0].terminalOutcome.reason, "timeout");
    assert.equal(childTerminalOutcomes[1].terminalOutcome.reason, "budget_exhausted");
    const terminalCases = await runProjection({ all: async () => [
      { key: "review-correctness", ok: true, runId: "outer-success-child-failure", exitCode: 0, results: [{ index: 0, agent: "forgedock-reviewer", exitCode: 1 }], artifactPaths: [] },
      { key: "review-security", ok: true, runId: "outer-success-terminal-failure", terminalOutcome: { state: "failed" }, results: [{ index: 0, agent: "forgedock-reviewer", exitCode: null }], artifactPaths: [] },
      { key: "review-specialist", runId: "exit-zero-without-ok", results: [{ index: 0, agent: "forgedock-reviewer", exitCode: 0 }], artifactPaths: [] },
    ] });
    assert.deepEqual(terminalCases.map((result: any) => result.nativeStatus), ["failed", "failed", "completed"]);
    const outerSuccessWithoutTerminal = await runProjection({ all: async () => [{ key: "review-correctness", ok: true, runId: "outer-success-no-terminal", results: [], artifactPaths: [] }] });
    assert.equal(outerSuccessWithoutTerminal[0].nativeStatus, "nonterminal");
    const requestPath = join(reviewRoot, "request.json");
    const requestText = await readFile(requestPath, "utf8");
    const nativeRequest = JSON.parse(requestText);
    assert.equal(nativeRequest.globalConcurrencyLimit, 2);
    assert.equal(nativeRequest.maxSubagentSpawnsPerRun, 3);
    const tamperedRequests = [
      { ...nativeRequest, async: true },
      { ...nativeRequest, cwd: `${nativeRequest.cwd}/other` },
      { ...nativeRequest, timeoutMs: nativeRequest.timeoutMs + 1 },
      { ...nativeRequest, control: { ...nativeRequest.control, needsAttentionAfterMs: nativeRequest.control.needsAttentionAfterMs + 1 } },
      { ...nativeRequest, control: { ...nativeRequest.control, activeNoticeAfterMs: nativeRequest.control.activeNoticeAfterMs + 1 } },
      { ...nativeRequest, toolTimeoutMs: 1 },
    ];
    for (const tampered of tamperedRequests) {
      await writeFile(requestPath, JSON.stringify(tampered));
      assert.equal(isStagingMutationBlocked("subagent", tampered), true);
    }
    await writeFile(requestPath, requestText);
    assert.equal(isStagingMutationBlocked("subagent", nativeRequest), false);
    assert.equal(isStagingMutationBlocked("subagent", { ...nativeRequest, globalConcurrencyLimit: 3 }), true);
    const secondPrepared = await tools.get("forge_prepare_review")!.execute("prepare-second-root", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      sourceRoot: f.root, configRoot: f.root, roles: review.roles, publish: false,
    });
    const secondArtifacts = modelArtifacts(secondPrepared);
    secondReviewRoot = secondArtifacts.reviewRoot;
    const secondRequest = JSON.parse(await readFile(join(secondReviewRoot, "request.json"), "utf8"));
    assert.equal(secondArtifacts.review.head, review.head);
    const handlers = extensionEvents();
    handlers.get("tool_result")!({ toolName: "forge_prepare_review", isError: false, details: { reviewRoot, artifactKey: artifacts.artifactKey, policySummary: { baseRef: "main" } } });
    const discovery = { action: "list", capabilities: true };
    assert.equal(isStagingMutationBlocked("subagent", discovery), false);
    assert.equal(handlers.get("tool_call")!({ toolName: "subagent", input: discovery }), undefined);
    assert.equal(handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "staging-panel-call", input: nativeRequest }), undefined);
    handlers.get("tool_result")!({ toolName: "subagent", toolCallId: "staging-panel-call", input: nativeRequest, isError: false, details: { mode: "workflow", runId: "staging-workflow-run-33800", workflow: { value: projected } } });
    const executionReceipt = JSON.parse(await readFile(join(reviewRoot, "reviewer-execution.json"), "utf8"));
    assert.equal(executionReceipt.artifactKey, artifacts.artifactKey);
    assert.equal(executionReceipt.roleResults[1].nativeRunId, "native-security-timeout");
    assert.equal(isStagingMutationBlocked("subagent", nativeRequest), true);
    assert.equal(handlers.get("tool_call")!({ toolName: "subagent", input: nativeRequest }).block, true);
    assert.equal(await readFile(join(artifacts.reviewRoot, "panel-launch.claim"), "utf8").then((value) => JSON.parse(value).artifactKey), artifacts.artifactKey);
    const reprepareInput = { repository: review.repository, pullRequest: review.pullRequest, head: review.head, baseRef: review.baseRef, baseSha: review.baseSha, sourceRoot: review.sourceRoot, configRoot: review.configRoot, roles: review.roles, publish: review.publish };
    assert.equal(handlers.get("tool_call")!({ toolName: "forge_prepare_review", input: reprepareInput }).block, true);
    handlers.get("agent_settled")!({});
    handlers.get("input")!({ source: "user", text: "/review-pr 33800" });
    assert.equal(handlers.get("tool_call")!({ toolName: "forge_prepare_review", input: reprepareInput }).block, true);
    assert.equal(handlers.get("tool_call")!({ toolName: "forge_prepare_review", input: { ...reprepareInput, repository: "Example/Product" } }).block, true);
    assert.equal(handlers.get("tool_call")!({ toolName: "subagent", input: nativeRequest }).block, true);
    assert.equal(handlers.get("tool_call")!({ toolName: "forge_prepare_review", input: { ...reprepareInput, head: "c".repeat(40) } }), undefined);
    handlers.get("input")!({ source: "user", text: "/review-pr-staging 33800" });
    assert.equal(isStagingMutationBlocked("subagent", secondRequest), false);
    assert.equal(handlers.get("tool_call")!({ toolName: "subagent", input: secondRequest }).block, true);
    assert.equal(await readFile(join(secondReviewRoot!, "panel-launch.claim"), "utf8").catch(() => ""), "");
    assert.equal(handlers.get("tool_call")!({ toolName: "forge_recover_reviewer_publication", input: {} }), undefined);
    const incompleteInput = { repository: review.repository, pullRequest: review.pullRequest, head: review.head, baseRef: review.baseRef, baseSha: review.baseSha, reviewRoot, artifactKey: artifacts.artifactKey, role: "specialist", nativeRunId: "native-specialist-stop", nativeTerminal: "stopped", deliveryError: "Reviewer stopped before report delivery.", publish: review.publish };
    assert.equal(handlers.get("tool_call")!({ toolName: "forge_publish_incomplete_review", input: incompleteInput }), undefined);
    assert.equal(handlers.get("tool_call")!({ toolName: "bash", input: { command: "touch source" } }).block, true);
    assert.equal(handlers.get("tool_call")!({ toolName: "subagent", input: { ...nativeRequest, globalConcurrencyLimit: 3 } }).block, true);

    const rewriteAuthorizedWorkflow = async (updatedWorkflow: string) => {
      await writeFile(workflowPath, updatedWorkflow);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.workflowSha256 = createHash("sha256").update(updatedWorkflow).digest("hex");
      await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}${String.fromCharCode(10)}`);
    };
    await rewriteAuthorizedWorkflow(workflow.replace('agent: "forgedock-reviewer"', 'agent: "forgedock-writer"'));
    assert.equal(isStagingMutationBlocked("subagent", nativeRequest), true);
    await rewriteAuthorizedWorkflow(workflow.replace("worktree: false", "worktree: true"));
    assert.equal(isStagingMutationBlocked("subagent", nativeRequest), true);
    assert.equal(isStagingMutationBlocked("subagent", { workflowScript: "return runs.run('review', { agent: 'forgedock-reviewer' })" }), true);
    assert.equal(isStagingMutationBlocked("subagent", { ...nativeRequest, agent: "forgedock-writer" }), true);
    assert.equal(isStagingMutationBlocked("bash", { command: "touch product-file" }), true);
    assert.equal(isStagingMutationBlocked("edit", {}), true);
    assert.equal(isStagingMutationBlocked("forge_recover_reviewer_publication", {}), false);
    assert.equal(isStagingMutationBlocked("forge_publish_incomplete_review", {}), false);
  } finally {
    if (reviewRoot) await rm(reviewRoot, { recursive: true, force: true });
    if (secondReviewRoot) await rm(secondReviewRoot, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("standard-route failed reviewer results provide post-launch GATED evidence", async () => {
  const f = await fixture();
  let reviewRoot: string | undefined;
  try {
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/integration", f.base], { cwd: f.root });
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.pull.baseRefName = "integration";
    state.pull.baseRefOid = f.base;
    await writeFile(f.state, JSON.stringify(state));
    const calls: Array<{ name: string; args: string[] }> = [];
    const tools = toolMap(fakeExecutor(f.env, calls));
    const prepared = await tools.get("forge_prepare_review")!.execute("prepare-standard", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "integration", baseSha: f.base,
      sourceRoot: f.root, configRoot: f.root, roles: ["correctness"], publish: false,
    });
    const artifacts = modelArtifacts(prepared);
    reviewRoot = artifacts.reviewRoot;
    assert.equal(artifacts.review.mode, "standard");
    const request = JSON.parse(await readFile(join(reviewRoot, "request.json"), "utf8"));
    const handlers = extensionEvents();
    handlers.get("tool_result")!({ toolName: "forge_prepare_review", isError: false, details: prepared.details });
    const incompleteInput = {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "integration", baseSha: f.base,
      reviewRoot, artifactKey: artifacts.artifactKey, role: "correctness", nativeRunId: "native-standard-correctness-33800",
      nativeTerminal: "failed", deliveryError: "The reviewer exited before publishing a report.", publish: false,
    };
    assert.equal(handlers.get("tool_call")!({ toolName: "forge_publish_incomplete_review", input: incompleteInput }), undefined);
    await assert.rejects(tools.get("forge_publish_incomplete_review")!.execute("preparation-only-gated", incompleteInput), /requires a completed per-role native execution receipt or exact role-bound publication recovery input/);
    await writeFile(join(reviewRoot, "reviewer-execution.json"), JSON.stringify({
      schema: "forgedock.candidate-review-execution/v1", repository: "example/product", pullRequest: 7, head: f.head,
      baseRef: "integration", baseSha: f.base, artifactKey: artifacts.artifactKey, mode: "standard", workflowPath: artifacts.review.workflowPath,
      workflowSha256: artifacts.review.workflowSha256, toolCallId: "forged", workflowRunId: "forged", completedAt: "now",
      roleResults: [{ role: "correctness", nativeRunId: incompleteInput.nativeRunId, nativeStatus: "failed", reportPath: join(reviewRoot, "correctness.report.md"), recoveryPath: join(reviewRoot, "correctness.publication-recovery.json"), exitCode: 1 }],
    }));
    assert.equal(handlers.get("tool_call")!({ toolName: "forge_publish_incomplete_review", input: incompleteInput }), undefined);
    await assert.rejects(tools.get("forge_publish_incomplete_review")!.execute("fabricated-gated", incompleteInput), /execution receipt is present but does not match/);
    await rm(join(reviewRoot, "reviewer-execution.json"), { force: true });
    assert.equal(handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "standard-launch-call", input: request }), undefined);
    const roleResult = {
      role: "correctness",
      nativeRunId: "native-standard-correctness-33800",
      nativeStatus: "failed",
      reportPath: join(reviewRoot, "correctness.report.md"),
      recoveryPath: join(reviewRoot, "correctness.publication-recovery.json"),
      exitCode: 1,
    };
    handlers.get("tool_result")!({ toolName: "subagent", toolCallId: "standard-launch-call", input: request, isError: false, details: { mode: "workflow", runId: "standard-workflow-run-33800", workflow: { value: [roleResult] } } });
    const runReceipt = JSON.parse(await readFile(join(reviewRoot, "reviewer-execution.json"), "utf8"));
    assert.equal(runReceipt.mode, "standard");
    assert.equal(runReceipt.roleResults[0].nativeRunId, roleResult.nativeRunId);
    assert.equal(handlers.get("tool_call")!({ toolName: "forge_publish_incomplete_review", input: incompleteInput }), undefined);
    const incomplete = await tools.get("forge_publish_incomplete_review")!.execute("standard-gated", incompleteInput);
    assert.equal(incomplete.details.recordKind, "GATED");
    assert.equal(incomplete.details.nativeRunId, roleResult.nativeRunId);
  } finally {
    if (reviewRoot) await rm(reviewRoot, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("fresh extension re-entry uses durable reviewer execution for readback and honest GATED", async () => {
  const f = await fixture();
  let reviewRoot: string | undefined;
  let prepOnlyRoot: string | undefined;
  const priorRunId = process.env.PI_SUBAGENT_RUN_ID;
  const calls: Array<{ name: string; args: string[] }> = [];
  const toolsA = toolMap(fakeExecutor(f.env, calls), true);
  try {
    const prepared = await toolsA.get("forge_prepare_review")!.execute("prepare-restart", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      sourceRoot: f.root, configRoot: f.root, roles: ["correctness", "security"], publish: true,
    });
    const artifacts = modelArtifacts(prepared);
    reviewRoot = artifacts.reviewRoot;
    const review = artifacts.review;
    const request = JSON.parse(await readFile(join(reviewRoot, "request.json"), "utf8"));
    const workflow = await readFile(join(reviewRoot, "workflow.js"), "utf8");
    const nativeRunIds = {
      correctness: "native-correctness-restart-33800",
      security: "native-security-restart-33800",
    };

    const handlersA = extensionEvents();
    handlersA.get("tool_result")!({ toolName: "forge_prepare_review", isError: false, details: prepared.details });
    assert.equal(handlersA.get("tool_call")!({ toolName: "subagent", toolCallId: "restart-workflow-a", input: request }), undefined);

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runWorkflow = new AsyncFunction("runs", workflow) as (runs: { all: (assignments: any[]) => Promise<any[]> }) => Promise<any[]>;
    const projectedResults = await runWorkflow({
      all: async (assignments) => assignments.map((assignment) => {
        const role = String(assignment.key).slice("review-".length);
        return { key: assignment.key, ok: true, runId: nativeRunIds[role as keyof typeof nativeRunIds], exitCode: 0, results: [{ index: 0, agent: "forgedock-reviewer", exitCode: 0 }] };
      }),
    });

    const publishRole = async (role: "correctness" | "security") => {
      const body = [
        "### Scope and decisions considered", `Reviewed the frozen source and policy for ${role}.`,
        "### Evidence and findings", "The report is retained and role-bound for parent verification.",
        "### Verification limitations", "This test uses controlled local GitHub transport only.",
        "### Recommendation", "Verify exact report bytes before adjudication.",
      ].join("\n\n");
      const bodyPath = join(reviewRoot!, `${role}.body.md`);
      process.env.PI_SUBAGENT_RUN_ID = nativeRunIds[role];
      return toolsA.get("forge_publish_reviewer")!.execute(`publish-${role}`, {
        repository: review.repository, pullRequest: review.pullRequest, head: review.head, baseRef: review.baseRef, baseSha: review.baseSha,
        role, body, bodyPath, reportPath: join(reviewRoot!, `${role}.report.md`), reviewRoot,
        authorizationPath: join(reviewRoot!, `${role}.authorization.json`), artifactKey: review.roleArtifactKeys[role], publish: true, observations: [],
      });
    };

    assert.equal((await publishRole("correctness")).details.publication, "published");
    const stateAfterCorrectness = JSON.parse(await readFile(f.state, "utf8"));
    stateAfterCorrectness.failNextReviewerRole = "security";
    await writeFile(f.state, JSON.stringify(stateAfterCorrectness));
    await assert.rejects(publishRole("security"), /Reviewer publication failed after analysis/);

    handlersA.get("tool_result")!({
      toolName: "subagent", toolCallId: "restart-workflow-a", isError: false,
      details: { mode: "workflow", runId: "review-workflow-restart-33800", workflow: { value: projectedResults } },
    });
    const executionPath = join(reviewRoot, "reviewer-execution.json");
    const originalExecution = JSON.parse(await readFile(executionPath, "utf8"));
    assert.equal(originalExecution.roleResults[1].nativeRunId, nativeRunIds.security);
    assert.equal(originalExecution.roleResults[1].nativeStatus, "completed");

    const stateBeforeRecovery = JSON.parse(await readFile(f.state, "utf8"));
    stateBeforeRecovery.failNextReviewerRole = "security";
    await writeFile(f.state, JSON.stringify(stateBeforeRecovery));
    const baseRecovery = {
      repository: review.repository, pullRequest: review.pullRequest, head: review.head, baseRef: review.baseRef, baseSha: review.baseSha,
      reviewRoot, artifactKey: review.artifactKey, nativeTerminal: "completed",
    };
    const priorProcessFailure = await toolsA.get("forge_recover_reviewer_publication")!.execute("security-claim-a", {
      ...baseRecovery, role: "security", nativeRunId: nativeRunIds.security,
    });
    assert.equal(priorProcessFailure.details.operationState, "recovery-unresolved");
    const securityRecoveryPath = join(reviewRoot, "security.publication-recovery.json");
    const unresolvedBeforeRestart = JSON.parse(await readFile(securityRecoveryPath, "utf8"));
    assert.equal(unresolvedBeforeRestart.state, "recovery-unresolved");
    assert.equal(unresolvedBeforeRestart.recoveryAttempts, 1);

    // Simulate a fresh Pi/extension instance: do not replay either prepare or workflow tool_result.
    const handlersB = extensionEvents();
    const toolsB = toolMap(fakeExecutor(f.env, calls), true);
    handlersB.get("input")!({ text: "/review-pr-staging", source: "interactive" });
    const postAttemptsBeforeRestart = JSON.parse(await readFile(f.state, "utf8")).postAttempts.filter((marker: string) => marker.startsWith("<!-- FORGE:REVIEWER_REPORT ")).length;
    const reviewerPublishCallsBeforeRestart = calls.filter((call) => call.args.includes("record") && call.args.includes("reviewer") && call.args.includes("--publish")).length;
    const localReviewerRenderCallsBeforeRestart = calls.filter((call) => call.args.includes("record") && call.args.includes("reviewer") && !call.args.includes("--publish")).length;

    const correctRecovery = { ...baseRecovery, role: "correctness", nativeRunId: nativeRunIds.correctness };
    const securityRecovery = { ...baseRecovery, role: "security", nativeRunId: nativeRunIds.security };
    for (const invalid of [
      { ...securityRecovery, role: "specialist" },
      { ...securityRecovery, nativeRunId: "native-security-wrong-run-33800" },
      { ...securityRecovery, head: f.base },
    ]) {
      assert.equal(handlersB.get("tool_call")!({ toolName: "forge_recover_reviewer_publication", input: invalid }), undefined);
      await assert.rejects(toolsB.get("forge_recover_reviewer_publication")!.execute("reject-misbound-recovery", invalid));
    }

    assert.equal(handlersB.get("tool_call")!({ toolName: "forge_recover_reviewer_publication", input: correctRecovery }), undefined);
    const finalized = await toolsB.get("forge_recover_reviewer_publication")!.execute("readback-correctness-after-restart", correctRecovery);
    assert.equal(finalized.details.operationState, "finalized");
    assert.equal(finalized.details.publication, "published");
    assert.equal(finalized.details.repeated, true);

    assert.equal(handlersB.get("tool_call")!({ toolName: "forge_recover_reviewer_publication", input: securityRecovery }), undefined);
    const unresolvedReadback = await toolsB.get("forge_recover_reviewer_publication")!.execute("readback-security-after-restart", securityRecovery);
    assert.equal(unresolvedReadback.details.operationState, "claimed-or-active");
    assert.equal(unresolvedReadback.details.publication, "unverified");

    const incompleteInput = {
      ...securityRecovery, nativeTerminal: "completed", publish: true,
      deliveryError: "The exact security report remains unverified after its single claimed recovery attempt.",
    };
    assert.equal(handlersB.get("tool_call")!({ toolName: "forge_publish_incomplete_review", input: incompleteInput }), undefined);

    // A syntactically valid receipt bound to another native run must not authorize GATED.
    const misboundExecution = structuredClone(originalExecution);
    misboundExecution.roleResults[1].nativeRunId = "native-security-other-run-33800";
    await writeFile(executionPath, `${JSON.stringify(misboundExecution, null, 2)}\n`);
    await assert.rejects(toolsB.get("forge_publish_incomplete_review")!.execute("reject-misbound-receipt", incompleteInput), /execution and reviewer publication evidence disagree/);
    await writeFile(executionPath, `${JSON.stringify(originalExecution, null, 2)}\n`);

    const afterRestart = await toolsB.get("forge_publish_incomplete_review")!.execute("gated-after-restart", incompleteInput);
    assert.equal(afterRestart.details.recordKind, "GATED");
    assert.equal(afterRestart.details.adjudicationPublished, false);
    assert.equal(afterRestart.details.deliveryState, "unverified");
    assert.match(await readFile(afterRestart.details.bodyPath, "utf8"), /No parent adjudication, approval, gate PASS\/FAIL/);
    const unresolvedAfterRestart = JSON.parse(await readFile(securityRecoveryPath, "utf8"));
    assert.equal(unresolvedAfterRestart.state, "recovery-unresolved");
    assert.equal(unresolvedAfterRestart.recoveryAttempts, 1);
    assert.ok((await readdir(reviewRoot)).includes("security.publication-recovery.lock"));
    assert.equal(await readFile(join(reviewRoot, "panel-launch.claim"), "utf8").then(() => true), true);

    // Re-entry may record GATED, but the persisted one-shot claim still blocks another reviewer workflow.
    assert.equal(handlersB.get("tool_call")!({ toolName: "subagent", toolCallId: "must-not-relaunch", input: request })?.block, true);
    const postAttemptsAfterRestart = JSON.parse(await readFile(f.state, "utf8")).postAttempts.filter((marker: string) => marker.startsWith("<!-- FORGE:REVIEWER_REPORT ")).length;
    const reviewerPublishCallsAfterRestart = calls.filter((call) => call.args.includes("record") && call.args.includes("reviewer") && call.args.includes("--publish")).length;
    const localReviewerRenderCallsAfterRestart = calls.filter((call) => call.args.includes("record") && call.args.includes("reviewer") && !call.args.includes("--publish")).length;
    assert.equal(postAttemptsAfterRestart, postAttemptsBeforeRestart);
    assert.equal(reviewerPublishCallsAfterRestart, reviewerPublishCallsBeforeRestart);
    assert.ok(localReviewerRenderCallsAfterRestart > localReviewerRenderCallsBeforeRestart);

    // Preparation-only evidence reaches the registered validator and is still rejected there.
    const prepOnly = await toolsB.get("forge_prepare_review")!.execute("prepare-only", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      sourceRoot: f.root, configRoot: f.root, roles: ["correctness"], publish: true,
    });
    const prepOnlyArtifacts = modelArtifacts(prepOnly);
    prepOnlyRoot = prepOnlyArtifacts.reviewRoot;
    const prepOnlyInput = {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      reviewRoot: prepOnlyRoot, artifactKey: prepOnlyArtifacts.artifactKey, role: "correctness",
      nativeRunId: "native-preparation-only-33800", nativeTerminal: "completed",
      deliveryError: "No reviewer execution result exists.", publish: true,
    };
    assert.equal(handlersB.get("tool_call")!({ toolName: "forge_publish_incomplete_review", input: prepOnlyInput }), undefined);
    const gatedPostsBeforePreparationOnly = calls.filter((call) => call.args.includes("--kind") && call.args.includes("GATED")).length;
    await assert.rejects(toolsB.get("forge_publish_incomplete_review")!.execute("reject-preparation-only", prepOnlyInput), /requires a completed per-role native execution receipt or exact role-bound publication recovery input/);
    assert.equal(calls.filter((call) => call.args.includes("--kind") && call.args.includes("GATED")).length, gatedPostsBeforePreparationOnly);
  } finally {
    if (priorRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
    else process.env.PI_SUBAGENT_RUN_ID = priorRunId;
    if (prepOnlyRoot) await rm(prepOnlyRoot, { recursive: true, force: true });
    if (reviewRoot) await rm(reviewRoot, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("exact-role recovery invokes the real record helper and verifies controlled publication readback", async () => {
  const f = await fixture();
  const calls: Array<{ name: string; args: string[] }> = [];
  const baseExecutor = fakeExecutor(f.env, calls);
  const fakePi = {
    exec: (name: string, args: string[] = [], options: { cwd?: string } = {}) => baseExecutor.exec(name, args, { ...options, cwd: options.cwd ?? f.root }),
  };
  const tools = toolMap(fakePi, true);
  const priorRunId = process.env.PI_SUBAGENT_RUN_ID;
  let reviewRoot: string | undefined;
  try {
    const prepared = await tools.get("forge_prepare_review")!.execute("prepare", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      sourceRoot: f.root, configRoot: f.root, roles: ["correctness", "security", "specialist"], publish: true,
    });
    const artifacts = modelArtifacts(prepared);
    reviewRoot = artifacts.reviewRoot;
    const review = artifacts.review;
    const role = "specialist";
    const roleKey = review.roleArtifactKeys[role] as string;
    const nativeRunId = "native-specialist-run-33800";
    const body = [
      "### Scope and decisions considered", "Reviewed the exact frozen source and policy.",
      "### Evidence and findings", "The role report is preserved for parent adjudication.",
      "### Verification limitations", "A controlled fake GitHub transport is used.",
      "### Recommendation", "Read back the exact report before adjudication.",
    ].join("\n\n");
    process.env.PI_SUBAGENT_RUN_ID = nativeRunId;
    const reviewer = tools.get("forge_publish_reviewer")!;
    await assert.rejects(reviewer.execute("wrong-common-key", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      role, body, bodyPath: join(reviewRoot, `${role}.body.md`), reportPath: join(reviewRoot, `${role}.report.md`),
      reviewRoot, authorizationPath: join(reviewRoot, `${role}.authorization.json`), artifactKey: review.artifactKey,
      publish: true, observations: [],
    }), /common review key instead of the prepared specialist role key/);
    await writeReviewerExecutionReceipt(reviewRoot, review);
    assert.equal(calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer").length, 0);

    const recovered = await tools.get("forge_recover_reviewer_publication")!.execute("recover", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      reviewRoot, artifactKey: review.artifactKey, role, nativeRunId, nativeTerminal: "completed",
    });
    assert.equal(recovered.details.publication, "published");
    assert.equal(recovered.details.nativeRunId, nativeRunId);
    assert.equal(calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish")).length, 1);
    const recordCall = calls.find((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish"))!;
    assert.equal(recordCall.args[recordCall.args.indexOf("--report-id") + 1], roleKey);
    assert.equal(recordCall.args.includes(review.artifactKey), false);

    const reportPath = join(reviewRoot, `${role}.report.md`);
    const report = await readFile(reportPath, "utf8");
    assert.match(report, new RegExp(`"reportId":"${roleKey}"`));
    assert.match(report, /FORGE:REVIEW_OBSERVATIONS \[\]/);
    const adjudication = tools.get("forge_publish_adjudication")!;
    const adjudicationInput = { repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, mode: "staging", reviewRoot, artifactKey: review.artifactKey, verdict: "APPROVE", gate: "PASS", decisions: [], historicalDecisions: [], checks: [], limitations: [], nextAction: "No follow-up.", allowIssueWrites: false, publish: true };
    const alteredBody = report.replace("Reviewed the exact frozen source and policy.", "Altered reviewer conclusion not present in retained authorship.");
    await writeFile(reportPath, alteredBody);
    await assert.rejects(adjudication.execute("altered-body", adjudicationInput), /authored recovery content does not match its prepared role/);
    const alteredObservations = report.replace("FORGE:REVIEW_OBSERVATIONS []", "FORGE:REVIEW_OBSERVATIONS [{\"id\":\"specialist:F1\"}]");
    await writeFile(reportPath, alteredObservations);
    await assert.rejects(adjudication.execute("altered-observations", adjudicationInput), /authored recovery content does not match its prepared role/);
    assert.equal((await readdir(reviewRoot)).some((name) => name.startsWith("adjudication-input-r0-")), false);
    await writeFile(reportPath, report);
    const recovery = JSON.parse(await readFile(join(reviewRoot, `${role}.publication-recovery.json`), "utf8"));
    assert.equal(recovery.state, "recovered");
    assert.equal(recovery.recoveryAttempts, 1);
    const github = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(github.comments.length, 1);
    assert.equal(github.comments[0].body, report);
    assert.match(github.comments[0].body, new RegExp(`"reportId":"${roleKey}"`));
  } finally {
    if (priorRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
    else process.env.PI_SUBAGENT_RUN_ID = priorRunId;
    if (reviewRoot) await rm(reviewRoot, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("interrupted recovery re-enters through exact report readback without a second POST", async () => {
  const f = await fixture();
  const calls: Array<{ name: string; args: string[] }> = [];
  const baseExecutor = fakeExecutor(f.env, calls);
  let interruptVerify = true;
  const fakePi = {
    exec: async (name: string, args: string[] = [], options: { cwd?: string } = {}) => {
      if (interruptVerify && name === "node" && args[1] === "verify-reviewer") {
        interruptVerify = false;
        throw new Error("controlled parent interruption after publisher claim");
      }
      return baseExecutor.exec(name, args, { ...options, cwd: options.cwd ?? f.root });
    },
  };
  const tools = toolMap(fakePi, true);
  const priorRunId = process.env.PI_SUBAGENT_RUN_ID;
  let reviewRoot: string | undefined;
  try {
    const prepared = await tools.get("forge_prepare_review")!.execute("prepare", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      sourceRoot: f.root, configRoot: f.root, roles: ["correctness"], publish: true,
    });
    const artifacts = modelArtifacts(prepared);
    reviewRoot = artifacts.reviewRoot;
    const review = artifacts.review;
    const role = "correctness";
    const nativeRunId = "native-correctness-interrupted-33800";
    process.env.PI_SUBAGENT_RUN_ID = nativeRunId;
    const body = ["### Scope and decisions considered", "Reviewed the exact frozen source.", "### Evidence and findings", "No blocking observations.", "### Verification limitations", "Controlled readback interruption.", "### Recommendation", "Parent adjudication follows verified delivery."].join("\n\n");
    await assert.rejects(tools.get("forge_publish_reviewer")!.execute("wrong-common-key", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      role, body, bodyPath: join(reviewRoot, `${role}.body.md`), reportPath: join(reviewRoot, `${role}.report.md`),
      reviewRoot, authorizationPath: join(reviewRoot, `${role}.authorization.json`), artifactKey: review.artifactKey,
      publish: true, observations: [],
    }), /common review key instead of the prepared correctness role key/);
    await writeReviewerExecutionReceipt(reviewRoot, review, { correctness: { nativeRunId, nativeStatus: "completed", exitCode: 0 } });

    await assert.rejects(tools.get("forge_recover_reviewer_publication")!.execute("recover-interrupted", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      reviewRoot, artifactKey: review.artifactKey, role, nativeRunId, nativeTerminal: "completed",
    }), /controlled parent interruption after publisher claim/);
    const recoveryPath = join(reviewRoot, `${role}.publication-recovery.json`);
    const interrupted = JSON.parse(await readFile(recoveryPath, "utf8"));
    assert.equal(interrupted.state, "recovery-attempted");
    assert.equal(interrupted.recoveryAttempts, 1);
    assert.equal(await readFile(join(reviewRoot, `${role}.publication-recovery.lock`), "utf8").catch(() => "directory"), "directory");
    const afterPost = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(afterPost.comments.filter((comment: any) => comment.body.includes('"role":"correctness"')).length, 1);
    assert.equal(afterPost.postAttempts.filter((marker: string) => marker.includes('"role":"correctness"')).length, 1);

    const finalized = await tools.get("forge_recover_reviewer_publication")!.execute("readback-finalize", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      reviewRoot, artifactKey: review.artifactKey, role, nativeRunId, nativeTerminal: "completed",
    });
    assert.equal(finalized.details.publication, "published");
    assert.equal(finalized.details.deliveryVerified, true);
    assert.equal(finalized.details.repeated, true);
    const finalState = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(finalState.postAttempts.filter((marker: string) => marker.includes('"role":"correctness"')).length, 1);
    const recovered = JSON.parse(await readFile(recoveryPath, "utf8"));
    assert.equal(recovered.state, "recovered");
    assert.equal(recovered.recoveryAttempts, 1);
  } finally {
    if (priorRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
    else process.env.PI_SUBAGENT_RUN_ID = priorRunId;
    if (reviewRoot) await rm(reviewRoot, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("active recovery may be recorded GATED, then finalizes and supersedes that record without another panel", async () => {
  const f = await fixture();
  const calls: Array<{ name: string; args: string[] }> = [];
  const baseExecutor = fakeExecutor(f.env, calls);
  let signalStarted!: () => void;
  let releasePublisher!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const wait = new Promise<void>((resolve) => { releasePublisher = resolve; });
  const fakePi = {
    exec: async (name: string, args: string[] = [], options: { cwd?: string } = {}) => {
      if (name === "node" && args[1] === "record" && args[2] === "reviewer" && args.includes("--publish") && args[args.indexOf("--role") + 1] === "specialist") {
        signalStarted();
        await wait;
      }
      return baseExecutor.exec(name, args, { ...options, cwd: options.cwd ?? f.root });
    },
  };
  const tools = toolMap(fakePi, true);
  const priorRunId = process.env.PI_SUBAGENT_RUN_ID;
  let reviewRoot: string | undefined;
  try {
    const prepared = await tools.get("forge_prepare_review")!.execute("prepare", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      sourceRoot: f.root, configRoot: f.root, roles: ["correctness", "security", "specialist"], publish: true,
    });
    const artifacts = modelArtifacts(prepared);
    reviewRoot = artifacts.reviewRoot;
    const review = artifacts.review;
    const bodyFor = (role: string) => ["### Scope and decisions considered", `Reviewed the exact frozen ${role} role.`, "### Evidence and findings", "No blocking observations.", "### Verification limitations", "Controlled GitHub transport.", "### Recommendation", "Parent adjudication after verified delivery."].join("\n\n");
    for (const role of ["correctness", "security"]) {
      process.env.PI_SUBAGENT_RUN_ID = `native-${role}-run-33800`;
      const body = bodyFor(role);
      const published = await tools.get("forge_publish_reviewer")!.execute(`publish-${role}`, {
        repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
        role, body, bodyPath: join(reviewRoot, `${role}.body.md`), reportPath: join(reviewRoot, `${role}.report.md`),
        reviewRoot, authorizationPath: join(reviewRoot, `${role}.authorization.json`), artifactKey: review.roleArtifactKeys[role],
        publish: true, observations: [],
      });
      assert.equal(published.details.publication, "published");
    }
    const priorReports = await Promise.all(["correctness", "security"].map((role) => readFile(join(reviewRoot!, `${role}.report.md`), "utf8")));
    const role = "specialist";
    const nativeRunId = "native-specialist-run-33800";
    const specialistBody = bodyFor(role);
    process.env.PI_SUBAGENT_RUN_ID = nativeRunId;
    await assert.rejects(tools.get("forge_publish_reviewer")!.execute("wrong-common-key", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      role, body: specialistBody, bodyPath: join(reviewRoot, `${role}.body.md`), reportPath: join(reviewRoot, `${role}.report.md`),
      reviewRoot, authorizationPath: join(reviewRoot, `${role}.authorization.json`), artifactKey: review.artifactKey,
      publish: true, observations: [],
    }), /common review key instead of the prepared specialist role key/);
    await writeReviewerExecutionReceipt(reviewRoot, review);

    const recovery = tools.get("forge_recover_reviewer_publication")!;
    const recoveryPromise = recovery.execute("recover-specialist", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      reviewRoot, artifactKey: review.artifactKey, role, nativeRunId, nativeTerminal: "completed",
    });
    await started;
    const claimed = JSON.parse(await readFile(join(reviewRoot, `${role}.publication-recovery.json`), "utf8"));
    assert.equal(claimed.state, "recovery-attempted");
    assert.equal(claimed.recoveryAttempts, 1);
    assert.equal(await readFile(join(reviewRoot, `${role}.publication-recovery.lock`), "utf8").catch(() => "directory"), "directory");

    const incomplete = await tools.get("forge_publish_incomplete_review")!.execute("record-active-claim", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      reviewRoot, artifactKey: review.artifactKey, role, nativeRunId, nativeTerminal: "completed",
      deliveryError: "Exact-role recovery is currently reserved; status is unresolved.", publish: true,
    });
    assert.equal(incomplete.details.recordKind, "GATED");
    assert.equal(incomplete.details.recoveryState, "recovery-attempted");
    const incompleteRecord = JSON.parse(await readFile(join(reviewRoot!, `review-delivery-incomplete-${role}-${createHash("sha256").update(nativeRunId).digest("hex").slice(0, 12)}.receipt.json`), "utf8"));
    assert.match(incompleteRecord.recordUrl, /#issuecomment-/);
    assert.deepEqual(await Promise.all(["correctness", "security"].map((name) => readFile(join(reviewRoot!, `${name}.report.md`), "utf8"))), priorReports);
    const interimGithub = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(interimGithub.comments.filter((comment: any) => comment.body.includes("FORGE:REVIEWER_REPORT") && comment.body.includes('"role":"specialist"')).length, 0);

    releasePublisher();
    const recovered = await recoveryPromise;
    assert.equal(recovered.details.publication, "published");
    assert.equal(recovered.details.deliveryVerified, true);
    const finalGithub = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(finalGithub.comments.filter((comment: any) => comment.body.includes("FORGE:REVIEWER_REPORT") && comment.body.includes('"role":"specialist"')).length, 1);
    assert.equal(finalGithub.postAttempts.filter((marker: string) => marker.includes('"role":"specialist"')).length, 1);

    const adjudicated = await tools.get("forge_publish_adjudication")!.execute("finalize-panel", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      mode: "staging", reviewRoot, artifactKey: review.artifactKey, verdict: "APPROVE", gate: "PASS",
      decisions: [], historicalDecisions: [], checks: [], limitations: [], nextAction: "No follow-up.", allowIssueWrites: false, publish: true,
    });
    assert.equal(adjudicated.details.publication, "published");
    const adjudicationCall = calls.find((call) => call.args.includes("adjudication"))!;
    const panelInput = JSON.parse(await readFile(adjudicationCall.args[adjudicationCall.args.indexOf("--input") + 1]!, "utf8"));
    assert.equal(panelInput.supersedes, incomplete.details.recordUrl);
    assert.equal(finalGithub.comments.filter((comment: any) => comment.body.includes("FORGE:REVIEWER_REPORT")).length, 3);
  } finally {
    releasePublisher();
    if (priorRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
    else process.env.PI_SUBAGENT_RUN_ID = priorRunId;
    if (reviewRoot) await rm(reviewRoot, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

test("unresolved real-helper publication preserves the report and records post-review GATED delivery", async () => {
  const f = await fixture();
  const calls: Array<{ name: string; args: string[] }> = [];
  const baseExecutor = fakeExecutor(f.env, calls);
  const fakePi = {
    exec: (name: string, args: string[] = [], options: { cwd?: string } = {}) => baseExecutor.exec(name, args, { ...options, cwd: options.cwd ?? f.root }),
  };
  const tools = toolMap(fakePi, true);
  const priorRunId = process.env.PI_SUBAGENT_RUN_ID;
  let reviewRoot: string | undefined;
  try {
    const prepared = await tools.get("forge_prepare_review")!.execute("prepare", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      sourceRoot: f.root, configRoot: f.root, roles: ["correctness"], publish: true,
    });
    const artifacts = modelArtifacts(prepared);
    reviewRoot = artifacts.reviewRoot;
    const review = artifacts.review;
    const role = "correctness";
    const roleKey = review.roleArtifactKeys[role] as string;
    const nativeRunId = "native-correctness-run-33800";
    const body = ["### Scope and decisions considered", "Reviewed the exact prepared role and frozen source.", "### Evidence and findings", "Authored evidence is retained locally.", "### Verification limitations", "Controlled publication transport.", "### Recommendation", "Do not adjudicate until delivery is verified."].join("\n\n");
    process.env.PI_SUBAGENT_RUN_ID = nativeRunId;
    await assert.rejects(tools.get("forge_publish_reviewer")!.execute("wrong-common-key", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      role, body, bodyPath: join(reviewRoot, `${role}.body.md`), reportPath: join(reviewRoot, `${role}.report.md`),
      reviewRoot, authorizationPath: join(reviewRoot, `${role}.authorization.json`), artifactKey: review.artifactKey,
      publish: true, observations: [],
    }), /common review key instead of the prepared correctness role key/);
    await writeReviewerExecutionReceipt(reviewRoot, review);

    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.commentPostFailure = true;
    await writeFile(f.state, JSON.stringify(state));
    const failed = await tools.get("forge_recover_reviewer_publication")!.execute("recover", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      reviewRoot, artifactKey: review.artifactKey, role, nativeRunId, nativeTerminal: "completed",
    });
    assert.equal(failed.details.publication, "unverified");
    assert.match(failed.details.error, /controlled comment transport failure/);
    const savedReport = await readFile(join(reviewRoot, `${role}.report.md`), "utf8");
    assert.match(savedReport, new RegExp(`"reportId":"${roleKey}"`));
    const recovery = JSON.parse(await readFile(join(reviewRoot, `${role}.publication-recovery.json`), "utf8"));
    assert.equal(recovery.state, "recovery-unresolved");
    assert.equal(recovery.recoveryAttempts, 1);

    const stateAfterFailure = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(stateAfterFailure.postAttempts.filter((marker: string) => marker.includes('"role":"correctness"')).length, 1);
    stateAfterFailure.commentPostFailure = false;
    await writeFile(f.state, JSON.stringify(stateAfterFailure));
    const incomplete = await tools.get("forge_publish_incomplete_review")!.execute("delivery-gated", {
      repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base,
      reviewRoot, artifactKey: review.artifactKey, role, nativeRunId, nativeTerminal: "completed",
      deliveryError: failed.details.error, publish: true,
    });
    assert.equal(incomplete.details.recordKind, "GATED");
    assert.equal(incomplete.details.adjudicationPublished, false);
    const after = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(after.comments.length, 1);
    assert.match(after.comments[0].body, /Review report delivery incomplete \(not a verdict\)/);
    assert.match(after.comments[0].body, /canonical role-bound report saved/);
    assert.match(after.comments[0].body, /readback\/finalization only/);
    assert.doesNotMatch(after.comments[0].body, /recovery attempt is exhausted/);
    assert.equal(after.postAttempts.filter((marker: string) => marker.includes('"role":"correctness"')).length, 1);
    assert.doesNotMatch(after.comments[0].body, /\b(?:APPROVE|CHANGES_REQUESTED|STAGING_GATE:PASS)\b/);
    assert.equal(calls.filter((call) => call.args.includes("adjudication")).length, 0);
  } finally {
    if (priorRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
    else process.env.PI_SUBAGENT_RUN_ID = priorRunId;
    if (reviewRoot) await rm(reviewRoot, { recursive: true, force: true });
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

function gateInput(f: Awaited<ReturnType<typeof fixture>>, artifacts: ReturnType<typeof modelArtifacts>, publish = false) {
  return { repository: "example/product", pullRequest: 7, kind: "STAGING_GATE", head: f.head, baseRef: "main", baseSha: f.base, gate: "PASS", checks: [], reviewRoot: artifacts.reviewRoot, artifactKey: artifacts.artifactKey, adjudicationPath: artifacts.adjudicationPath, body: "placeholder body replaced by adjudication.", publish };
}

test("published staging gates supersede the latest same-head gate", async () => {
  const f = await fixture();
  try {
    const oldUrl = "https://github.com/example/product/pull/7#issuecomment-70";
    const latestUrl = "https://github.com/example/product/pull/7#issuecomment-71";
    const identity = { v: 1, kind: "STAGING_GATE", repository: "example/product", pullRequest: 7, head: f.head, baseSha: f.base, baseRef: "main", gate: "FAIL" };
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.comments = [
      { id: 70, body: `<!-- FORGE:CANDIDATE:STAGING_GATE ${JSON.stringify(identity)} -->\nold gate\n`, html_url: oldUrl },
      { id: 71, body: `<!-- FORGE:CANDIDATE:STAGING_GATE ${JSON.stringify({ ...identity, supersedes: oldUrl })} -->\nlatest gate\n`, html_url: latestUrl },
    ];
    await writeFile(f.state, JSON.stringify(state));
    const ctx = await stagedContext(f, true);
    const adjudicationPath = join(ctx.artifacts.reviewRoot, "adjudication-gate.json");
    const adjudicationArtifact = { schema: "forgedock.candidate-adjudication/v1", artifactKey: ctx.artifacts.artifactKey, repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, mode: "staging", gate: "FAIL", roles: ["correctness"], reports: [{ role: "correctness", reportId: ctx.artifacts.review.roleArtifactKeys.correctness }], decisions: [], verdict: "GATED", panelUrl: "https://github.com/example/product/pull/7#issuecomment-99", trackingPublication: "complete", gateBody: "FORGE:STAGING_GATE:FAIL\n\n## REVIEW-PANEL\nA refreshed parent decision remains blocked." };
    const gateTool = ctx.tools.get("forge_publish_record")!;
    await writeFile(adjudicationPath, JSON.stringify({ ...adjudicationArtifact, reports: [...adjudicationArtifact.reports, ...adjudicationArtifact.reports] }));
    await assert.rejects(gateTool.execute("duplicate-role-reports", { ...gateInput(f, ctx.artifacts, true), gate: "FAIL", adjudicationPath }), /completed parent panel decision with every prepared role report/);
    await writeFile(adjudicationPath, JSON.stringify(adjudicationArtifact));
    const result = await gateTool.execute("publish", {
      ...gateInput(f, ctx.artifacts),
      gate: "FAIL",
      checks: ["Shadow-Database Migration Dry Run"],
      body: "placeholder body replaced by adjudication.",
      adjudicationPath,
      publish: true,
    });
    assert.equal(result.details.publication, "published");
    const publication = JSON.parse(result.content[0].text);
    assert.equal(publication.identity.supersedes, latestUrl);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.state, { force: true });
  }
});

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
    assert.match(artifacts.content, /caller-supplied acceptance\/history\/evidence\/limitations are review context/);
    await reviewerReport(artifacts.reviewRoot, artifacts.review);
    await writeFile(artifacts.adjudicationPath, JSON.stringify({ schema: "forgedock.candidate-adjudication/v1", artifactKey: artifacts.artifactKey, repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, mode: "staging", gate: "PASS", roles: ["correctness"], reports: [{ role: "correctness", reportId: artifacts.review.roleArtifactKeys.correctness }], decisions: [], verdict: "APPROVE", panelUrl: "https://github.com/example/product/pull/7#issuecomment-99", trackingPublication: "complete", gateBody: "FORGE:STAGING_GATE:PASS\n\n## REVIEW-PANEL\nGitHub checks are complete." }));
    const result = await publish.execute("publish", {
      repository: "example/product", pullRequest: 7, kind: "STAGING_GATE", head: f.head, baseRef: "main", baseSha: f.base, gate: "PASS", checks: [],
      reviewRoot: artifacts.reviewRoot, artifactKey: artifacts.artifactKey, adjudicationPath: artifacts.adjudicationPath, body: "placeholder body.", publish: true,
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
    await writeFile(artifacts.adjudicationPath, JSON.stringify({ schema: "forgedock.candidate-adjudication/v1", artifactKey: artifacts.artifactKey, repository: "example/product", pullRequest: 7, head: f.head, baseRef: "main", baseSha: f.base, mode: "staging", gate: "PASS", roles: ["correctness"], reports: [{ role: "correctness", reportId: artifacts.review.roleArtifactKeys.correctness }], decisions: [], verdict: "APPROVE", panelUrl: null, trackingPublication: "complete", gateBody: "FORGE:STAGING_GATE:PASS\n\n## REVIEW-PANEL\nEvidence." }));
    const base = { repository: "example/product", pullRequest: 7, kind: "STAGING_GATE", head: f.head, baseRef: "main", baseSha: f.base, gate: "PASS", checks: [], reviewRoot: artifacts.reviewRoot, artifactKey: artifacts.artifactKey, adjudicationPath: artifacts.adjudicationPath, body: "placeholder body.", publish: false };
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
