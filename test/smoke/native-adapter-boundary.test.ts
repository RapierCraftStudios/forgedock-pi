import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Opt in with a pinned pi-subagents checkout that has its test dependencies installed.
// Uses the full native adapter + mock CLI, not a real model or live repository.
const source = process.env.PI_SUBAGENTS_ADAPTER_SOURCE;
const adapterSkip = source ? false : "Installed npm artifact has no pi-subagents test-support seam; set PI_SUBAGENTS_ADAPTER_SOURCE to a pinned source checkout.";
const load = (file: string) => import(pathToFileURL(resolve(source!, file)).href);

async function withAdapter(run: (h: any) => Promise<void>, options: { ownerSystemPrompt?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "forge-adapter-boundary-"));
  const repo = join(root, "repo");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PI_SUBAGENT_") || key === "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"));
  for (const key of Object.keys(inherited)) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let mock: any;
  try {
    await mkdir(repo);
    await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    await load("test/support/register-loader.mjs");
    const helpers = await load("test/support/helpers.ts");
    const { createSubagentExecutor } = await load("src/runs/foreground/subagent-executor.ts");
    const { registerWaitTool } = await load("src/runs/background/wait-tool.ts");
    const nativeEvents = helpers.createEventBus();
    const state: any = { baseCwd: repo, currentSessionId: "session-123", asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map(), cleanupTimers: new Map(), resultFileCoalescer: new Map(), lastForegroundControlId: null };
    const waitTools = new Map<string, any>();
    registerWaitTool({ events: nativeEvents, registerTool: (tool: any) => waitTools.set(tool.name, tool) } as never, state, true);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, "base.txt"), "base\n");
    execFileSync("git", ["add", "base.txt"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base"], { cwd: repo });
    execFileSync("git", ["branch", "-M", "pi-parallel-native"], { cwd: repo });
    mock = helpers.createMockPi(); mock.install(); mock.reset();
    const executor = createSubagentExecutor({
      pi: { events: nativeEvents, getSessionName: () => undefined },
      state,
      config: { worktreeBaseDir: join(root, "worktrees") }, asyncByDefault: false,
      tempArtifactsDir: join(root, "artifacts"), getSubagentSessionRoot: () => join(root, "sessions"),
      expandTilde: (value: string) => value,
      discoverAgents: () => {
        const owner: any = helpers.makeAgent("forgedock-owner", { thinking: false, systemPrompt: options.ownerSystemPrompt ?? "" });
        owner.acceptanceRole = "writer";
        return { agents: [helpers.makeAgent("echo", { thinking: false }), helpers.makeAgent("forgedock-parent-control.forgedock-work-on-coordinator", { thinking: false }), owner] };
      },
      allowMutatingManagementActions: true,
    });
    await run({ root, repo, mock, executor, context: helpers.makeMinimalCtx(repo), state, nativeEvents, waitTools });
  } finally {
    mock?.uninstall();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_") || key === "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT") delete process.env[key];
    Object.assign(process.env, inherited);
    await rm(root, { recursive: true, force: true });
  }
}

async function complete(executor: any, context: any, params: Record<string, unknown>) {
  const receipt = await executor.executePublic("candidate-boundary", { ...params, async: true, mission: false }, new AbortController().signal, undefined, context);
  assert.equal(receipt.isError, undefined, receipt.content?.[0]?.text);
  const statusFile = join(receipt.details.asyncDir, "status.json");
  // Bounded fixture wait for native publication, not model/status polling.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const status = JSON.parse(await readFile(statusFile, "utf8"));
    if (["complete", "failed", "stopped"].includes(status.state)) return { receipt, status, statusFile };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("native async fixture did not settle");
}

async function waitForNativeFile(file: string, predicate: (value: any) => boolean, message: string) {
  for (let attempt = 0; attempt < 1500; attempt++) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (predicate(value)) return value;
    } catch { /* Native status is written atomically after launch. */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function waitForNativeTextFile(file: string, predicate: (value: string) => boolean, message: string) {
  for (let attempt = 0; attempt < 1500; attempt++) {
    try {
      const value = await readFile(file, "utf8");
      if (predicate(value)) return value;
    } catch { /* Worktree file may not exist until the controlled child starts. */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function invokeNativeWait(waitTools: Map<string, any>, context: any, events: any[], id: string, toolCallId: string) {
  const tool = waitTools.get("subagent_wait");
  assert.ok(tool?.execute, "pinned extension did not register its supported subagent_wait tool");
  const args = { id, timeoutMs: 30000, stopOnAttention: false };
  events.push({ type: "tool_execution_start", toolName: "subagent_wait", toolCallId, args });
  const result = await tool.execute(toolCallId, args, new AbortController().signal, undefined, context);
  events.push({ type: "tool_execution_end", toolName: "subagent_wait", toolCallId, result });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return result;
}

async function prepareReplayDispatch(root: string, repo: string, issues: Array<Record<string, unknown>>) {
  const productSeed = resolve("qualification/fixtures/orchestration-replay/product");
  await cp(productSeed, repo, { recursive: true, force: true });
  const remote = join(root, "example", "product.git");
  await mkdir(join(root, "example"), { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", remote], { cwd: root });
  execFileSync("git", ["branch", "-M", "integration"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", `file://${remote}`], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "disposable orchestration seed"], { cwd: repo });
  execFileSync("git", ["push", "-q", "-u", "origin", "integration"], { cwd: repo });
  const issueFile = join(root, "orchestrate-issues.json");
  await writeFile(issueFile, JSON.stringify({ issues }));
  const outputDir = join(root, "candidate-dispatch");
  const helper = resolve("bin/forgedock-candidate.mjs");
  const result = JSON.parse(execFileSync(process.execPath, [helper, "prepare-dispatch", "--selector", issues.map((issue) => `#${issue.number}`).join(" "), "--delivery-mode", "local-replay", "--cwd", repo, "--issues-file", issueFile, "--out", outputDir], { cwd: repo, encoding: "utf8" }));
  const plan = JSON.parse(await readFile(result.planPath, "utf8"));
  const localDependent = plan.issues.find((issue: any) => issue.predecessors?.length > 0);
  if (localDependent) assert.match(localDependent.task, /There is no GitHub PR\/merge receipt in local replay/);
  return { ...result, plan, helper, issueFile, remote, outputDir, baseHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() };
}

function assistantMessage(text: string) {
  return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], model: "test/model", stopReason: "stop", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } };
}

function runFixtureNpm(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return execFileSync("npm", args, { cwd, encoding: "utf8", env });
}

function runFixtureNpmResult(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try { return { code: 0, output: execFileSync("npm", args, { cwd, encoding: "utf8", env }) }; }
  catch (error: any) { return { code: error.status ?? 1, output: `${error.stdout ?? ""}\n${error.stderr ?? ""}` }; }
}

function acceptanceText(issue: any, files: string[], tests: string[], command: string) {
  return [
    "```acceptance-report",
    JSON.stringify({
      criteriaSatisfied: issue.acceptanceMapping.criteria.map((criterion: any) => ({ id: criterion.id, status: "satisfied", evidence: "controlled native-adapter fixture executed the contract test" })),
      changedFiles: files,
      testsAddedOrUpdated: tests,
      commandsRun: [{ command, result: "passed", summary: "executed by the no-model adapter test before the controlled child was released" }],
      validationOutput: [`${command} passed`],
      residualRisks: [],
      noStagedFiles: true,
      manualNotes: "No-model native adapter fixture; not a live owner implementation.",
    }, null, 2),
    "```",
  ].join("\n");
}

function recordNativeLaunch(events: any[], request: Record<string, unknown>, callId: string, receipt: any) {
  events.push({ type: "tool_execution_start", toolName: "subagent", toolCallId: callId, args: request });
  events.push({ type: "tool_execution_end", toolName: "subagent", toolCallId: callId, result: receipt });
}

async function recordNativeStatusRead(events: any[], statusPath: string, callId: string) {
  const text = await readFile(statusPath, "utf8");
  events.push({ type: "tool_execution_start", toolName: "read", toolCallId: callId, args: { path: statusPath } });
  events.push({ type: "tool_execution_end", toolName: "read", toolCallId: callId, result: { content: [{ type: "text", text }] } });
  return JSON.parse(text);
}

function findEnvironment(value: any): any {
  if (typeof value === "string") {
    for (const text of [value, ...value.split("\n")]) {
      try {
        const found = findEnvironment(JSON.parse(text));
        if (found) return found;
      } catch {
        // Non-JSON output is not an environment envelope.
      }
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  if (value.PI_SUBAGENT_EXTENSION_BINDINGS) return value;
  for (const child of Object.values(value)) {
    const found = findEnvironment(child);
    if (found) return found;
  }
  return undefined;
}

async function ownerScript(output: string | false) {
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  const script = adapter.slice(adapter.indexOf("Use one visible promise graph.")).match(/```js\n([\s\S]*?)\n```/)?.[1];
  assert.ok(script);
  const helpers = script.slice(0, script.indexOf("if (!Number.isSafeInteger(ownerConcurrency)"));
  return `const configuredModel="test-model";\n${helpers}\nreturn await runIssue("owner", ${JSON.stringify({ agent: "echo", task: "Return fixture result", context: "fresh", worktree: true, output, outputMode: "inline", artifacts: true, acceptance: false })});`;
}

for (const explicitOutput of [true, false]) {
  test(`full adapter retained recovery with declared output=${explicitOutput}`, { skip: adapterSkip, timeout: 30000 }, async () => {
    await withAdapter(async ({ root, mock, executor, context }) => {
      mock.onCall({ output: "fixture terminal failure", exitCode: 1 });
      mock.onCall({ output: "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=2 dependency=SATISFIED" });
      const { status } = await complete(executor, context, { workflowScript: await ownerScript(explicitOutput ? join(root, "owner-report.md") : false) });
      assert.equal(status.state, "complete");
      const result = status.workflow.value;
      assert.ok(result.recoverySource?.runId, "retain the original source even if admission fails");
      assert.ok(result.recoverySource.artifactPaths.length > 0);
      // The documented default is a foreground child. Its retained contract is not
      // the persisted-async descriptor used by the suspected collision path.
      assert.equal(result.ok, true, result.error ?? result.output);
      assert.equal(mock.callCount(), 2);
      const calls = await Promise.all((await readdir(mock.dir)).filter((f: string) => /^call-.*\.json$/.test(f)).sort().map(async (f: string) => JSON.parse(await readFile(join(mock.dir, f), "utf8"))));
      assert.equal(calls[0].cwd, calls[1].cwd, "recovery reuses the real retained worktree");
      const session = (args: string[]) => args[args.indexOf("--session") + 1];
      assert.equal(session(calls[0].args), session(calls[1].args));
    });
  });
}

test("full adapter preserves original recovery references when the budget denies resume", { skip: adapterSkip, timeout: 30000 }, async () => {
  await withAdapter(async ({ mock, executor, context }) => {
    mock.onCall({ output: "fixture terminal failure", exitCode: 1 });
    const { status } = await complete(executor, context, { workflowScript: await ownerScript(false), maxSubagentSpawnsPerRun: 1 });
    assert.equal(status.state, "complete");
    const result = status.workflow.value;
    assert.equal(result.ok, false);
    assert.match(result.error ?? result.output, /fan-out limit/i);
    assert.ok(result.recoverySource?.runId);
    assert.ok(result.recoverySource.artifactPaths.length > 0);
    assert.equal(mock.callCount(), 1);
  });
});

test("candidate dispatch reconciles ok plus rejected native acceptance through the same native owner", { skip: adapterSkip, timeout: 60000 }, async () => {
  await withAdapter(async ({ root, repo, mock, executor, context }) => {
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: repo });
    execFileSync("git", ["branch", "-M", "staging"], { cwd: repo });
    const forgeYaml = `
project:
  owner: example
  repo: product
paths:
  root: .
branches:
  default: main
  staging: staging
  feature_pattern: feature/{slug}
agents:
  subagent_model: test/model
  thinking: off
orchestration:
  max_concurrent: 1
review:
  reviewer_timeout_ms: 1000
  panel_timeout_ms: 4000
  max_concurrent: 1
  publication_timeout_ms: 1000
`;
    await writeFile(join(repo, "forge.yaml"), forgeYaml);
    execFileSync("git", ["add", "forge.yaml"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "candidate fixture config"], { cwd: repo });
    execFileSync("git", ["update-ref", "refs/remotes/origin/staging", "HEAD"], { cwd: repo });
    const issueFile = join(root, "issues.json");
    await writeFile(issueFile, JSON.stringify({ issues: [{ number: 42, title: "native acceptance recovery", body: "## Acceptance Criteria\n- [ ] The captured source criterion is checked before delivery." }] }));
    const outputDir = join(root, "candidate-dispatch");
    const helper = resolve("bin/forgedock-candidate.mjs");
    const prepared = JSON.parse(execFileSync(process.execPath, [helper, "prepare-dispatch", "--selector", "#42", "--delivery-mode", "local-replay", "--cwd", repo, "--issues-file", issueFile, "--out", outputDir], { cwd: repo, encoding: "utf8" }));
    const request = JSON.parse(await readFile(prepared.requestPath, "utf8"));
    assert.equal(request.async, true);
    const plan = JSON.parse(await readFile(prepared.planPath, "utf8"));
    const targetTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo, encoding: "utf8" }).trim();
    const advancedTarget = execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit-tree", targetTree, "-p", plan.targetBase.headSha, "-m", "unrelated target advance"], { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["update-ref", "refs/remotes/origin/staging", advancedTarget], { cwd: repo });
    assert.notEqual(advancedTarget, plan.targetBase.headSha);
    mock.onCall({ output: "FORGE_WORK_ON_RESULT status=DONE issue=42 pr=none dependency=SATISFIED" });
    mock.onCall({ output: "FORGE_WORK_ON_RESULT status=GATED issue=42 pr=none dependency=UNSATISFIED" });
    const { status } = await complete(executor, context, request);
    assert.equal(status.state, "complete");
    assert.equal(status.runFanoutBudget.limit, request.maxSubagentSpawnsPerRun);
    assert.equal(Array.isArray(status.workflow.value), true);
    const result = status.workflow.value[0];
    assert.equal(result.status, "GATED");
    assert.equal(result.nativeAcceptanceStatus, "rejected");
    assert.equal(result.recoverySource.acceptanceStatus, "rejected");
    assert.equal(result.recoverySource.output, "FORGE_WORK_ON_RESULT status=DONE issue=42 pr=none dependency=SATISFIED");
    assert.equal(result.output, "FORGE_WORK_ON_RESULT status=GATED issue=42 pr=none dependency=UNSATISFIED");
    assert.equal(mock.callCount(), 2, "the accepted-looking marker is recovered once on its retained native owner");
    const calls = await Promise.all((await readdir(mock.dir)).filter((f: string) => /^call-.*\.json$/.test(f)).sort().map(async (f: string) => JSON.parse(await readFile(join(mock.dir, f), "utf8"))));
    assert.equal(calls[0].cwd, calls[1].cwd);
    const ownerHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: calls[0].cwd, encoding: "utf8" }).trim();
    assert.equal(ownerHead, plan.targetBase.headSha, "an unrelated target advance does not silently rebind a non-dependent owner");
    const session = (args: string[]) => args[args.indexOf("--session") + 1];
    assert.equal(session(calls[0].args), session(calls[1].args));
  });
});

test("async native dispatch waits through delayed GATED result and collects the persisted terminal batch", { skip: adapterSkip, timeout: 60000 }, async () => {
  await withAdapter(async ({ root, repo, mock, executor, context, waitTools }) => {
    const issuesInput = JSON.parse(await readFile(resolve("qualification/fixtures/orchestration-replay/orchestrate-issues.json"), "utf8"));
    issuesInput.issues.push({ number: 103, title: "Downstream sentinel", body: "# Downstream sentinel\n\n## Acceptance Criteria\n- [ ] Run only after issue #102 is delivered.\n\n## Affected Files\n- `test/display.test.mjs`\n\nDepends on #102" });
    const prepared = await prepareReplayDispatch(root, repo, issuesInput.issues);
    const plan = JSON.parse(await readFile(prepared.planPath, "utf8"));
    const request = JSON.parse(await readFile(prepared.requestPath, "utf8"));
    const issue101 = plan.issues.find((issue: any) => issue.number === 101)!;
    const issue102 = plan.issues.find((issue: any) => issue.number === 102)!;
    const release101 = join(root, "release-owner-101");
    const release102 = join(root, "release-owner-102");
    const output101 = `FORGE_WORK_ON_RESULT status=DONE issue=101 pr=none dependency=SATISFIED\n${acceptanceText(issue101, ["src/profile.mjs", "test/profile.test.mjs"], ["test/profile.test.mjs"], "npm test")}`;
    const producerSource = 'export function normalizeDisplayName(value) { return value.trim().toLowerCase(); }\nexport function profileId(profile) { return profile.id; }\n';
    const producerTest = [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { normalizeDisplayName, profileId } from "../src/profile.mjs";',
      'test("producer normalizes display text and preserves the profile", () => {',
      '  const profile = { id: "User-7", name: "  ALICE  " };',
      '  assert.equal(normalizeDisplayName(profile.name), "alice");',
      '  assert.equal(profileId(profile), "User-7");',
      '  assert.deepEqual(profile, { id: "User-7", name: "  ALICE  " });',
      '});',
      "",
    ].join("\n");
    mock.onCall({ writeFiles: [{ path: "src/profile.mjs", content: producerSource }, { path: "test/profile.test.mjs", content: producerTest }], steps: [{ waitForPath: release101, jsonl: [assistantMessage(output101)] }] });
    const gatedOutput = "FORGE_WORK_ON_RESULT status=GATED issue=102 pr=none dependency=SATISFIED";
    mock.onCall({ steps: [{ waitForPath: release102, jsonl: [assistantMessage(gatedOutput)] }] });

    try {
    const rootCallId = "qualification-gated-root-call";
    const receipt = await executor.executePublic(rootCallId, { ...request, mission: false }, new AbortController().signal, undefined, context);
    assert.equal(receipt.isError, undefined, receipt.content?.[0]?.text);
    assert.equal(receipt.details.asyncId, receipt.details.runId);
    assert.ok(receipt.details.asyncDir);
    assert.equal(Array.isArray(receipt.details.workflow?.value), false, "async launch receipt must not be mistaken for its final workflow result");
    const statusFile = join(receipt.details.asyncDir, "status.json");
    const parentEvents: any[] = [];
    recordNativeLaunch(parentEvents, request, rootCallId, receipt);

    for (let attempt = 0; attempt < 1000 && mock.callCount() < 1; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(mock.callCount(), 1, "only the prerequisite owner may be active before its delivery marker");
    const call101 = JSON.parse(await readFile(join(mock.dir, (await readdir(mock.dir)).find((file: string) => /^call-.*\.json$/.test(file))!), "utf8"));
    const owner101 = call101.cwd;
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner101, encoding: "utf8" }).trim(), prepared.baseHead);
    const producerTestOutput = runFixtureNpm(owner101, ["test"]);
    assert.match(producerTestOutput, /tests 1/);
    assert.match(producerTestOutput, /pass 1/);
    execFileSync("git", ["add", "src/profile.mjs", "test/profile.test.mjs"], { cwd: owner101 });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "controlled producer delivery"], { cwd: owner101 });
    const delivered101 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner101, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "origin", "HEAD:refs/heads/integration"], { cwd: owner101 });
    assert.equal(execFileSync("git", ["rev-parse", "refs/heads/integration"], { cwd: prepared.remote, encoding: "utf8" }).trim(), delivered101);
    await writeFile(release101, "release");

    for (let attempt = 0; attempt < 1000 && mock.callCount() < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(mock.callCount(), 2, "#102 becomes eligible only after #101's checked DONE result");
    const callFiles = (await readdir(mock.dir)).filter((file: string) => /^call-.*\.json$/.test(file)).sort();
    const call102 = JSON.parse(await readFile(join(mock.dir, callFiles[1]!), "utf8"));
    const owner102 = call102.cwd;
    const prepared102 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner102, encoding: "utf8" }).trim();
    assert.equal(prepared102, prepared.baseHead, "the dependent worktree starts from the exact prepared base before CONTEXT");
    execFileSync("git", ["fetch", "origin", "integration", "--quiet"], { cwd: owner102 });
    execFileSync("git", ["merge", "--ff-only", "origin/integration"], { cwd: owner102 });
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner102, encoding: "utf8" }).trim(), delivered101, "the dependent consumes the exact predecessor commit before edits");
    const activeStatus = JSON.parse(await readFile(statusFile, "utf8"));
    assert.equal(activeStatus.state, "running", "the persisted root must remain nonterminal while the child is held");
    const rootWait = invokeNativeWait(waitTools, context, parentEvents, receipt.details.runId, "qualification-root-wait");
    await writeFile(release102, "release");
    const waited = await rootWait;
    assert.match(waited.content?.[0]?.text ?? "", new RegExp(receipt.details.runId));
    const beforeCollector = await readFile(statusFile);
    const finalStatus = await recordNativeStatusRead(parentEvents, statusFile, "qualification-root-status-read");
    const { collectNativeBatch } = await import(new URL("../../qualification/native-batch-collector.mjs", import.meta.url).href);
    const batch = collectNativeBatch(parentEvents, { issues: [101, 102, 103], predecessors: { 101: [], 102: [101], 103: [102] }, repository: "example/product", target: "integration", cwd: repo }, resolve("bin/forgedock-candidate.mjs"));
    assert.equal(batch.status, "terminal");
    assert.equal(batch.outcome, "terminal-gated");
    assert.equal(batch.continuationCount, 0);
    assert.equal(batch.finalRoot.runId, receipt.details.runId);
    assert.equal(batch.observations.waits.some((wait: any) => wait.id === receipt.details.runId), true);
    assert.ok(batch.observations.readPaths.includes(statusFile));
    const rows = new Map<number, any>(batch.rows.map((row: any): [number, any] => [row.issue, row]));
    assert.equal(rows.get(101)?.status, "DONE");
    assert.equal(rows.get(101)?.runId, finalStatus.workflow.value.find((row: any) => row.issue === 101)?.runId);
    assert.equal(rows.get(102)?.status, "GATED");
    assert.equal(rows.get(102)?.dependency, "SATISFIED", "a gated owner may have a delivered incoming prerequisite");
    assert.equal(rows.get(102)?.nativeStatus, "completed");
    assert.equal(rows.get(103)?.status, "GATED");
    assert.equal(rows.get(103)?.nativeStatus, "not-started");
    assert.deepEqual(rows.get(103)?.blockedBy, ["issue-102"]);
    assert.equal(mock.callCount(), 2, "the gated #102 owner never releases or launches #103");
    assert.deepEqual(await readFile(statusFile), beforeCollector, "collector must not rewrite native status records");
    assert.equal(execFileSync("git", ["rev-parse", "refs/heads/integration"], { cwd: prepared.remote, encoding: "utf8" }).trim(), delivered101, "GATED work is not delivered to integration");
    } finally {
      await writeFile(release101, "release").catch(() => {});
      await writeFile(release102, "release").catch(() => {});
    }
  });
});

test("detached child GATED result reconciles on the exact async root without stale WAITING or successor admission", { skip: adapterSkip, timeout: 90000 }, async () => {
  await withAdapter(async ({ root, repo, mock, executor, context, state, nativeEvents, waitTools }) => {
    const issuesInput = JSON.parse(await readFile(resolve("qualification/fixtures/orchestration-replay/orchestrate-issues.json"), "utf8"));
    issuesInput.issues.push({ number: 103, title: "Downstream sentinel", body: "# Downstream sentinel\n\n## Acceptance Criteria\n- [ ] Run only after issue #102 is delivered.\n\n## Affected Files\n- `test/display.test.mjs`\n\nDepends on #102" });
    const prepared = await prepareReplayDispatch(root, repo, issuesInput.issues);
    const plan = JSON.parse(await readFile(prepared.planPath, "utf8"));
    const request = JSON.parse(await readFile(prepared.requestPath, "utf8"));
    const issue101 = plan.issues.find((issue: any) => issue.number === 101)!;
    const release101 = join(root, "detach-release-101");
    const supervisorReply = join(root, "detach-reply-102");
    const release102 = join(root, "detach-release-102");
    const output101 = `FORGE_WORK_ON_RESULT status=DONE issue=101 pr=none dependency=SATISFIED\n${acceptanceText(issue101, ["src/profile.mjs", "test/profile.test.mjs"], ["test/profile.test.mjs"], "npm test")}`;
    const producerSource = 'export function normalizeDisplayName(value) { return value.trim().toLowerCase(); }\nexport function profileId(profile) { return profile.id; }\n';
    const producerTest = [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { normalizeDisplayName, profileId } from "../src/profile.mjs";',
      'test("producer normalizes display text and preserves the profile", () => {',
      '  const profile = { id: "User-7", name: "  ALICE  " };',
      '  assert.equal(normalizeDisplayName(profile.name), "alice");',
      '  assert.equal(profileId(profile), "User-7");',
      '  assert.deepEqual(profile, { id: "User-7", name: "  ALICE  " });',
      '});',
      "",
    ].join("\n");
    const gatedOutput = "FORGE_WORK_ON_RESULT status=GATED issue=102 pr=none dependency=SATISFIED";
    mock.onCall({ writeFiles: [{ path: "src/profile.mjs", content: producerSource }, { path: "test/profile.test.mjs", content: producerTest }], steps: [{ waitForPath: release101, jsonl: [assistantMessage(output101)] }] });
    mock.onCall({ steps: [
      { jsonl: [{ type: "tool_execution_start", toolCallId: "controlled-contact", toolName: "contact_supervisor", args: { reason: "need_decision", message: "Controlled native detach test" } }] },
      { waitForPath: supervisorReply, jsonl: [{ type: "tool_execution_end", toolCallId: "controlled-contact", toolName: "contact_supervisor" }, { type: "tool_result_end", message: { role: "toolResult", toolCallId: "controlled-contact", toolName: "contact_supervisor", content: [{ type: "text", text: "Controlled reply" }] } }] },
      { waitForPath: release102, jsonl: [assistantMessage(gatedOutput)] },
    ] });

    const { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT } = await load("src/shared/types.ts");
    const detachRequestId = "qualification-detached-owner-102";
    let detachAccepted = false;
    nativeEvents.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload: any) => {
      if (payload?.requestId === detachRequestId) detachAccepted ||= payload.accepted === true;
    });
    const detachTimer = setInterval(() => {
      if (!detachAccepted) nativeEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: detachRequestId });
    }, 10);
    detachTimer.unref();
    const rootCallId = "qualification-detached-root";
    const parentEvents: any[] = [];
    let childRunId: string | undefined;
    try {
      const receipt = await executor.executePublic(rootCallId, { ...request, mission: false }, new AbortController().signal, undefined, context);
      assert.equal(receipt.isError, undefined, receipt.content?.[0]?.text);
      assert.equal(receipt.details.async, undefined);
      assert.equal(receipt.details.mode, "workflow");
      assert.ok(receipt.details.asyncDir);
      recordNativeLaunch(parentEvents, request, rootCallId, receipt);
      const statusFile = join(receipt.details.asyncDir, "status.json");
      for (let attempt = 0; attempt < 200 && mock.callCount() < 1; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      if (mock.callCount() < 1) {
        const failedRoot = JSON.parse(await readFile(statusFile, "utf8"));
        throw new Error(`detached fixture root never launched its producer owner: ${JSON.stringify({ state: failedRoot.state, error: failedRoot.error, trace: failedRoot.workflow?.trace, value: failedRoot.workflow?.value, steps: failedRoot.steps })}`);
      }
      const call101File = (await readdir(mock.dir)).find((file: string) => /^call-.*\.json$/.test(file))!;
      const owner101 = JSON.parse(await readFile(join(mock.dir, call101File), "utf8")).cwd;
      await waitForNativeTextFile(join(owner101, "src/profile.mjs"), (text) => text.includes("trim().toLowerCase()"), "controlled producer implementation was not written in its native worktree");
      const producerTestOutput = runFixtureNpm(owner101, ["test"]);
      assert.match(producerTestOutput, /tests 1/);
      assert.match(producerTestOutput, /pass 1/);
      execFileSync("git", ["add", "src/profile.mjs", "test/profile.test.mjs"], { cwd: owner101 });
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "controlled producer delivery"], { cwd: owner101 });
      const delivered101 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner101, encoding: "utf8" }).trim();
      execFileSync("git", ["push", "origin", "HEAD:refs/heads/integration"], { cwd: owner101 });
      await writeFile(release101, "release");

      for (let attempt = 0; attempt < 1000 && mock.callCount() < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(mock.callCount(), 2, "the successor is admitted only after the prerequisite's local delivery");
      const callFiles = (await readdir(mock.dir)).filter((file: string) => /^call-.*\.json$/.test(file)).sort();
      const owner102 = JSON.parse(await readFile(join(mock.dir, callFiles[1]!), "utf8")).cwd;
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner102, encoding: "utf8" }).trim(), prepared.baseHead);
      execFileSync("git", ["fetch", "origin", "integration", "--quiet"], { cwd: owner102 });
      execFileSync("git", ["merge", "--ff-only", "origin/integration"], { cwd: owner102 });
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner102, encoding: "utf8" }).trim(), delivered101);
      for (let attempt = 0; attempt < 500 && !detachAccepted; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(detachAccepted, true, "the actual native adapter accepted the child detach request");
      const intermediateStatus = await waitForNativeFile(statusFile, (value) => value.state === "running" && value.steps?.some((step: any) => step.workflowKey === "issue-102" && step.currentTool === "contact_supervisor"), `native root did not retain the detached owner as active (status=${await readFile(statusFile, "utf8")})`);
      const issue102Step = intermediateStatus.steps.find((step: any) => step.workflowKey === "issue-102");
      childRunId = issue102Step.runId;
      assert.ok(childRunId);
      assert.equal(issue102Step.status, "running");
      assert.equal(intermediateStatus.workflow?.value, undefined, "nonterminal launch snapshot must not be mistaken for a batch result");
      assert.equal(mock.callCount(), 2, "one owner per eligible issue; no replacement writer");

      await writeFile(supervisorReply, "controlled reply");
      const afterReplyStatus = await waitForNativeFile(statusFile, (value) => value.state === "running" && !value.steps?.find((step: any) => step.workflowKey === "issue-102")?.currentTool, "native root did not clear the child supervisor tool after its controlled reply");
      assert.equal(afterReplyStatus.runId, receipt.details.runId);
      const rootWait = invokeNativeWait(waitTools, context, parentEvents, receipt.details.runId, "qualification-detached-root-wait");
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(release102, "release");
      const waited = await rootWait;
      assert.match(waited.content?.[0]?.text ?? "", new RegExp(receipt.details.runId));
      const finalStatus = await waitForNativeFile(statusFile, (value) => value.state === "complete" && Array.isArray(value.workflow?.value), "the same async root did not publish its terminal workflow.value");
      await recordNativeStatusRead(parentEvents, statusFile, "qualification-final-root-readback");
      const statusCallId = "qualification-detached-child-status";
      parentEvents.push({ type: "tool_execution_start", toolName: "subagent", toolCallId: statusCallId, args: { action: "status", id: childRunId } });
      const childStatusResult = await executor.executePublic(statusCallId, { action: "status", id: childRunId }, new AbortController().signal, undefined, context);
      parentEvents.push({ type: "tool_execution_end", toolName: "subagent", toolCallId: statusCallId, result: childStatusResult });
      const statusText = childStatusResult.content?.[0]?.text ?? "";
      assert.match(statusText, /detached: intercom coordination/);
      const outputPath = statusText.match(/^\s*Output:\s*(.+)$/m)?.[1];
      assert.ok(outputPath, statusText);
      const metadataPath = outputPath.replace(/_output\.md$/, "_meta.json");
      assert.notEqual(metadataPath, outputPath);
      const metadataBytes = await readFile(metadataPath);
      const outputBytes = await readFile(outputPath);
      const metadataSha = createHash("sha256").update(metadataBytes).digest("hex");
      const outputSha = createHash("sha256").update(outputBytes).digest("hex");
      parentEvents.push({ type: "tool_execution_start", toolName: "read", toolCallId: "qualification-terminal-meta-readback", args: { path: metadataPath } });
      parentEvents.push({ type: "tool_execution_end", toolName: "read", toolCallId: "qualification-terminal-meta-readback", result: { content: [{ type: "text", text: metadataBytes.toString("utf8") }] } });
      parentEvents.push({ type: "tool_execution_start", toolName: "read", toolCallId: "qualification-terminal-output-readback", args: { path: outputPath } });
      parentEvents.push({ type: "tool_execution_end", toolName: "read", toolCallId: "qualification-terminal-output-readback", result: { content: [{ type: "text", text: outputBytes.toString("utf8") }] } });
      const metadata = JSON.parse(metadataBytes.toString("utf8"));
      assert.equal(metadata.runId, childRunId);
      assert.equal(metadata.execution.status, "completed");
      const marker = outputBytes.toString("utf8").replace(/\r\n?/g, "\n").split("\n").find((line) => line === gatedOutput);
      assert.equal(marker, gatedOutput);
      assert.equal(metadata.execution.success, true);
      const finalRootBytes = await readFile(statusFile);
      const finalRootHash = createHash("sha256").update(finalRootBytes).digest("hex");
      const finalRows = new Map<number, any>(finalStatus.workflow.value.map((row: any): [number, any] => [row.issue, row]));
      assert.equal(finalStatus.state, "complete");
      assert.equal(finalStatus.runId, receipt.details.runId);
      assert.equal(finalRows.get(101)?.status, "DONE");
      assert.equal(finalRows.get(102)?.runId, childRunId, "the GATED result must remain bound to the exact detached child");
      assert.equal(finalRows.get(102)?.status, "GATED");
      assert.equal(finalRows.get(102)?.dependency, "SATISFIED", "a GATED owner's incoming prerequisite may already be delivered");
      assert.equal(finalRows.get(102)?.nativeStatus, "completed");
      assert.equal(finalRows.get(103)?.status, "GATED");
      assert.equal(finalRows.get(103)?.nativeStatus, "not-started");
      assert.deepEqual(finalRows.get(103)?.blockedBy, ["issue-102"]);
      const { collectNativeBatch } = await import(new URL("../../qualification/native-batch-collector.mjs", import.meta.url).href);
      const batch = collectNativeBatch(parentEvents, { issues: [101, 102, 103], predecessors: { 101: [], 102: [101], 103: [102] }, repository: "example/product", target: "integration", cwd: repo }, resolve("bin/forgedock-candidate.mjs"));
      assert.equal(batch.status, "terminal");
      assert.equal(batch.outcome, "terminal-gated");
      assert.equal(batch.continuationCount, 0, "the active async root itself reconciled after the detached child returned");
      assert.equal(batch.finalRoot.runId, receipt.details.runId);
      assert.equal(batch.observations.waits.some((wait: any) => wait.id === receipt.details.runId), true);
      assert.equal(batch.rows.find((row: any) => row.issue === 102)?.runId, childRunId);
      assert.equal(batch.rows.find((row: any) => row.issue === 102)?.status, "GATED");
      assert.equal(batch.rows.find((row: any) => row.issue === 102)?.dependency, "SATISFIED");
      assert.equal(mock.callCount(), 2, "the terminal GATED result does not launch a replacement owner or successor");
      assert.deepEqual(await readFile(statusFile), finalRootBytes, "collector must not edit authoritative native root status");
      assert.equal(createHash("sha256").update(await readFile(statusFile)).digest("hex"), finalRootHash);
      assert.equal(createHash("sha256").update(await readFile(metadataPath)).digest("hex"), metadataSha);
      assert.equal(createHash("sha256").update(await readFile(outputPath)).digest("hex"), outputSha);
      assert.equal(execFileSync("git", ["rev-parse", "refs/heads/integration"], { cwd: prepared.remote, encoding: "utf8" }).trim(), delivered101, "the GATED consumer's own work was not delivered");
    } finally {
      clearInterval(detachTimer);
      await writeFile(release101, "release").catch(() => {});
      await writeFile(supervisorReply, "release").catch(() => {});
      await writeFile(release102, "release").catch(() => {});
      if (childRunId) await waitTools.get("subagent_wait")?.execute?.("cleanup-wait", { id: childRunId, timeoutMs: 1 }, new AbortController().signal, undefined, context).catch(() => {});
    }
  }, { ownerSystemPrompt: "Intercom orchestration channel:" });
});

test("verified DONE prerequisite delivery admits a consumer that consumes it through the normal workflow", { skip: adapterSkip, timeout: 90000 }, async () => {
  await withAdapter(async ({ root, repo, mock, executor, context, waitTools }) => {
    const issuesInput = JSON.parse(await readFile(resolve("qualification/fixtures/orchestration-replay/orchestrate-issues.json"), "utf8"));
    const prepared = await prepareReplayDispatch(root, repo, issuesInput.issues);
    const plan = JSON.parse(await readFile(prepared.planPath, "utf8"));
    const request = JSON.parse(await readFile(prepared.requestPath, "utf8"));
    const issue101 = plan.issues.find((issue: any) => issue.number === 101)!;
    const issue102 = plan.issues.find((issue: any) => issue.number === 102)!;
    const release101 = join(root, "done-release-101");
    const release102 = join(root, "done-release-102");
    const output101 = `FORGE_WORK_ON_RESULT status=DONE issue=101 pr=none dependency=SATISFIED\n${acceptanceText(issue101, ["src/profile.mjs", "test/profile.test.mjs"], ["test/profile.test.mjs"], "npm test")}`;
    const producerSource = 'export function normalizeDisplayName(value) { return value.trim().toLowerCase(); }\nexport function profileId(profile) { return profile.id; }\n';
    const producerTest = [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { normalizeDisplayName, profileId } from "../src/profile.mjs";',
      'test("producer normalizes display text and preserves the profile", () => {',
      '  const profile = { id: "User-7", name: "  ALICE  " };',
      '  assert.equal(normalizeDisplayName(profile.name), "alice");',
      '  assert.equal(profileId(profile), "User-7");',
      '  assert.deepEqual(profile, { id: "User-7", name: "  ALICE  " });',
      '});',
      "",
    ].join("\n");
    const output102 = `FORGE_WORK_ON_RESULT status=DONE issue=102 pr=none dependency=SATISFIED\n${acceptanceText(issue102, ["src/render.mjs"], [], "npm run test:all")}`;
    const rendererSource = [
      'import { normalizeDisplayName, profileId } from "./profile.mjs";',
      'export function renderProfile(profile) {',
      '  const base = `${profileId(profile)}:${normalizeDisplayName(profile.name)}`;',
      '  return typeof profile.teamLabel === "string" && profile.teamLabel.length > 0 ? `${base}:${profile.teamLabel}` : base;',
      '}',
      "",
    ].join("\n");
    mock.onCall({ writeFiles: [{ path: "src/profile.mjs", content: producerSource }, { path: "test/profile.test.mjs", content: producerTest }], steps: [{ waitForPath: release101, jsonl: [assistantMessage(output101)] }] });
    mock.onCall({ steps: [{ waitForPath: release102, jsonl: [assistantMessage(output102)] }] });

    const rootCallId = "qualification-done-root-call";
    const receipt = await executor.executePublic(rootCallId, { ...request, mission: false }, new AbortController().signal, undefined, context);
    assert.equal(receipt.isError, undefined, receipt.content?.[0]?.text);
    assert.equal(Array.isArray(receipt.details.workflow?.value), false);
    const statusFile = join(receipt.details.asyncDir, "status.json");
    const parentEvents: any[] = [];
    recordNativeLaunch(parentEvents, request, rootCallId, receipt);
    const rootWait = invokeNativeWait(waitTools, context, parentEvents, receipt.details.runId, "qualification-done-root-wait");

    for (let attempt = 0; attempt < 1000 && mock.callCount() < 1; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(mock.callCount(), 1, "successor must remain unlaunched while #101 is active");
    const callFiles101 = (await readdir(mock.dir)).filter((file: string) => /^call-.*\.json$/.test(file)).sort();
    const owner101 = JSON.parse(await readFile(join(mock.dir, callFiles101[0]!), "utf8")).cwd;
    await waitForNativeTextFile(join(owner101, "src/profile.mjs"), (text) => text.includes("trim().toLowerCase()"), "controlled producer implementation did not reach the native owner worktree");
    const producerTests = runFixtureNpm(owner101, ["test"]);
    assert.match(producerTests, /tests 1/); assert.match(producerTests, /pass 1/);
    execFileSync("git", ["add", "src/profile.mjs", "test/profile.test.mjs"], { cwd: owner101 });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "controlled producer delivery"], { cwd: owner101 });
    const delivered101 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner101, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "origin", "HEAD:refs/heads/integration"], { cwd: owner101 });
    assert.equal(execFileSync("git", ["rev-parse", "refs/heads/integration"], { cwd: prepared.remote, encoding: "utf8" }).trim(), delivered101);
    await writeFile(release101, "release");

    for (let attempt = 0; attempt < 1000 && mock.callCount() < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(mock.callCount(), 2, "#102 is admitted after native #101 DONE and exact local delivery");
    const callFiles = (await readdir(mock.dir)).filter((file: string) => /^call-.*\.json$/.test(file)).sort();
    const owner102 = JSON.parse(await readFile(join(mock.dir, callFiles[1]!), "utf8")).cwd;
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner102, encoding: "utf8" }).trim(), prepared.baseHead);
    execFileSync("git", ["fetch", "origin", "integration", "--quiet"], { cwd: owner102 });
    execFileSync("git", ["merge", "--ff-only", "origin/integration"], { cwd: owner102 });
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner102, encoding: "utf8" }).trim(), delivered101, "the successor consumes the exact predecessor before source edits");
    const consumerBaseline = runFixtureNpmResult(owner102, ["run", "test:display"]);
    assert.notEqual(consumerBaseline.code, 0);
    assert.match(consumerBaseline.output, /User-7:alice:Platform/);
    await writeFile(join(owner102, "src/render.mjs"), rendererSource);
    const consumerTests = runFixtureNpm(owner102, ["run", "test:display"]);
    assert.match(consumerTests, /tests 3/); assert.match(consumerTests, /pass 3/);
    const fullTests = runFixtureNpm(owner102, ["run", "test:all"]);
    assert.match(fullTests, /tests 4/); assert.match(fullTests, /pass 4/);
    execFileSync("git", ["add", "src/render.mjs"], { cwd: owner102 });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "controlled consumer delivery"], { cwd: owner102 });
    const delivered102 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner102, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "origin", "HEAD:refs/heads/integration"], { cwd: owner102 });
    assert.equal(execFileSync("git", ["rev-parse", "refs/heads/integration"], { cwd: prepared.remote, encoding: "utf8" }).trim(), delivered102);
    await writeFile(release102, "release");
    const waited = await rootWait;
    assert.match(waited.content?.[0]?.text ?? "", new RegExp(receipt.details.runId));
    const finalStatus = await waitForNativeFile(statusFile, (value) => value.state === "complete" && Array.isArray(value.workflow?.value), "positive native root did not publish its terminal workflow.value");
    await recordNativeStatusRead(parentEvents, statusFile, "qualification-done-root-readback");
    const { collectNativeBatch } = await import(new URL("../../qualification/native-batch-collector.mjs", import.meta.url).href);
    const batch = collectNativeBatch(parentEvents, { issues: [101, 102], predecessors: { 101: [], 102: [101] }, repository: "example/product", target: "integration", cwd: repo }, resolve("bin/forgedock-candidate.mjs"));
    assert.equal(batch.status, "terminal");
    assert.equal(batch.outcome, "terminal-done");
    const rows = new Map<number, any>(batch.rows.map((row: any): [number, any] => [row.issue, row]));
    assert.equal(rows.get(101)?.status, "DONE"); assert.equal(rows.get(101)?.dependency, "SATISFIED");
    assert.equal(rows.get(102)?.status, "DONE"); assert.equal(rows.get(102)?.dependency, "SATISFIED");
    assert.equal(rows.get(102)?.nativeAcceptanceStatus, "checked");
    assert.equal(execFileSync("git", ["merge-base", "--is-ancestor", delivered101, delivered102], { cwd: repo }).toString(), "");
    assert.equal(execFileSync("git", ["rev-parse", "refs/heads/integration"], { cwd: prepared.remote, encoding: "utf8" }).trim(), delivered102);
    assert.equal(mock.callCount(), 2, "one native owner per issue, with no replacement launch");
    assert.equal(finalStatus.workflow.value.find((row: any) => row.issue === 102)?.status, "DONE");
  });
});

test("prepared lane policy reaches the actual native child environment", { skip: adapterSkip, timeout: 30000 }, async () => {
  await withAdapter(async ({ root, repo, mock, executor, context }) => {
    const dispatch = await import(new URL("../../specs/helpers/dispatch.mjs", import.meta.url).href);
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/project.git"], { cwd: repo });
    execFileSync("git", ["update-ref", "refs/remotes/origin/staging", "HEAD"], { cwd: repo });
    const preparedRepo = join(root, "prepared-repo");
    execFileSync("git", ["worktree", "add", "-q", "-b", "pi-parallel-native-lane", preparedRepo, "HEAD"], { cwd: repo });
    await writeFile(join(repo, "forge.yaml"), 'project: {owner: example, repo: project}\nagents: {subagent_model: "test/model"}\n');
    await writeFile(join(repo, ".git", "info", "exclude"), "forge.yaml\n");
    const parentRoot = fileURLToPath(new URL("../..", import.meta.url));
    const controlPlane = dispatch.createControlPlaneDescriptor({ forgeDockRoot: parentRoot, piSubagentsRoot: realpathSync(join(parentRoot, "node_modules/pi-subagents")) });
    const contract = dispatch.createIssueContract(42, [
      { id: "source-behavior", textHash: `sha256:${"1".repeat(64)}`, proofType: "behavioral", affectedBoundaries: ["src/example.ts"] },
    ]);
    const contractBytes = `${JSON.stringify(contract)}\n`;
    const contractPath = join(root, "issue-42-contract.json");
    await writeFile(contractPath, contractBytes, { mode: 0o400 });
    const contractDescriptor = { path: contractPath, sha256: createHash("sha256").update(contractBytes).digest("hex") };
    const prepared = dispatch.prepareBatch({ activeOwners: 1, launchAllowance: 8, requestStartedAt: "2026-01-01T00:00:00Z", controlPlane,
      issues: [{ number: 42, target: "staging", baseCwd: preparedRepo, predecessors: [], contract: contractDescriptor }] }, join(root, "prepared"), repo);
    const script = await readFile(prepared.request.workflowScriptPath, "utf8");
    const graph = JSON.parse(script.match(/^const issueGraph=(.+);$/m)![1]!);
    // Probe the exact generated child descriptor through the full adapter; the
    // separate 100-lane fixture tests scheduling and admission of the fixed body.
    const item = { key: graph[0].key, ...graph[0].launch, acceptance: false };
    mock.onCall({ echoEnv: ["PI_SUBAGENT_EXTENSION_BINDINGS", "PI_SUBAGENT_RUN_ID"] });
    const { status } = await complete(executor, context, { workflowScript: `return await runs.all(${JSON.stringify([item])});` });
    assert.equal(status.state, "complete");
    assert.equal(status.workflow.value[0].ok, true, status.workflow.value[0].error);
    const received = JSON.parse(status.workflow.value[0].output);
    const policy = dispatch.loadPolicy(undefined, received);
    assert.equal(policy.issue, 42); assert.equal(policy.repo, "example/project");
    assert.equal(policy.target, "staging");
    assert.equal(policy.model, "test/model"); assert.equal(policy.remediationLimit, 1);
    const boundContract = dispatch.validateIssueContractFile(policy.contract, policy.issue);
    assert.equal(boundContract.issue, 42);
    assert.equal(policy.contractDigest, boundContract.digest);
    assert.deepEqual(boundContract.criteria.map((criterion: { id: string; proofType: string }) => [criterion.id, criterion.proofType]), [["source-behavior", "behavioral"]]);
    assert.ok(received.PI_SUBAGENT_RUN_ID);
    // Now execute the generated recipe unchanged through failure and retained resume.
    mock.onCall({ output: "technical owner failure", exitCode: 1 });
    mock.onCall({ echoEnv: ["PI_SUBAGENT_EXTENSION_BINDINGS", "PI_SUBAGENT_RUN_ID"] });
    const recovered = await complete(executor, context, prepared.request);
    assert.equal(recovered.status.state, "complete");
    const batch = JSON.parse(await readFile(prepared.batchFile, "utf8"));
    const row = recovered.status.workflow.value[0];
    assert.ok(row.recoverySource?.runId, JSON.stringify(row));
    assert.equal(dispatch.identifyLane(batch, recovered.status, row.runId).issue, 42);
    // Public retained resume can return a tracked async receipt. Resolve its exact
    // persisted result, rather than assuming progress previews contain final output.
    let restored: any;
    function findEnvironment(value: any): any {
      if (typeof value === "string") {
        for (const text of [value, ...value.split("\n")]) { try { const found = findEnvironment(JSON.parse(text)); if (found) return found; } catch { /* Prose is not environment JSON. */ } }
        return undefined;
      }
      if (!value || typeof value !== "object") return undefined;
      if (value.PI_SUBAGENT_EXTENSION_BINDINGS) return value;
      for (const child of Object.values(value)) { const found = findEnvironment(child); if (found) return found; }
      return undefined;
    }
    for (const artifact of row.artifactPaths) {
      if (!(await stat(artifact)).isDirectory()) continue;
      for (let attempt = 0; attempt < 1000; attempt++) {
        const childStatus = JSON.parse(await readFile(join(artifact, "status.json"), "utf8"));
        if (["complete", "failed", "stopped"].includes(childStatus.state)) {
          assert.equal(childStatus.state, "complete", childStatus.error);
          assert.equal(childStatus.runId, row.runId);
          restored = findEnvironment(await readFile(childStatus.outputFile, "utf8"));
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.ok(restored, `No terminal child environment result for ${row.runId}`);
    assert.equal(dispatch.loadPolicy(undefined, restored).issue, 42);
    assert.equal(restored.PI_SUBAGENT_EXTENSION_BINDINGS, received.PI_SUBAGENT_EXTENSION_BINDINGS);
  });
});

test("native continuation assigns a fresh run identity while preserving authorized owner binding", { skip: adapterSkip, timeout: 60000 }, async () => {
  await withAdapter(async ({ root, repo, mock, executor, context }) => {
    const dispatch = await import(new URL("../../specs/helpers/dispatch.mjs", import.meta.url).href);
    const records = await import(new URL("../../specs/helpers/record.mjs", import.meta.url).href);
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/project.git"], { cwd: repo });
    execFileSync("git", ["update-ref", "refs/remotes/origin/staging", "HEAD"], { cwd: repo });
    const preparedRepo = join(root, "prepared-replan-repo");
    execFileSync("git", ["worktree", "add", "-q", "-b", "pi-parallel-native-replan", preparedRepo, "HEAD"], { cwd: repo });
    await writeFile(join(repo, "forge.yaml"), 'project: {owner: example, repo: project}\nagents: {subagent_model: "test/model"}\n');
    await writeFile(join(repo, ".git", "info", "exclude"), "forge.yaml\n");
    const parentRoot = fileURLToPath(new URL("../..", import.meta.url));
    const controlPlane = dispatch.createControlPlaneDescriptor({ forgeDockRoot: parentRoot, piSubagentsRoot: realpathSync(join(parentRoot, "node_modules/pi-subagents")) });
    const originalContract = dispatch.createIssueContract(42, [
      { id: "product-behavior", textHash: `sha256:${"1".repeat(64)}`, proofType: "behavioral", affectedBoundaries: ["src/example.ts"] },
    ]);
    const originalBytes = `${JSON.stringify(originalContract)}\n`;
    const originalPath = join(root, "original-contract.json");
    await writeFile(originalPath, originalBytes, { mode: 0o400 });
    const originalDescriptor = { path: originalPath, sha256: createHash("sha256").update(originalBytes).digest("hex") };
    const prepared = dispatch.prepareBatch({ activeOwners: 1, launchAllowance: 8, requestStartedAt: "2026-01-01T00:00:00Z", controlPlane,
      issues: [{ number: 42, target: "staging", baseCwd: preparedRepo, predecessors: [], contract: originalDescriptor }] }, join(root, "prepared-replan"), repo);
    const script = await readFile(prepared.request.workflowScriptPath, "utf8");
    const graph = JSON.parse(script.match(/^const issueGraph=(.+);$/m)![1]!);
    const originalItem = { key: graph[0].key, ...graph[0].launch, acceptance: false };
    mock.onCall({ echoEnv: ["PI_SUBAGENT_EXTENSION_BINDINGS", "PI_SUBAGENT_RUN_ID", "PI_SUBAGENT_PARENT_RUN_ID"] });
    const first = await complete(executor, context, { workflowScript: `return await runs.all(${JSON.stringify([originalItem])});` });
    assert.equal(first.status.state, "complete");
    const originalEnv = findEnvironment(first.status.workflow.value[0]);
    assert.ok(originalEnv, "original native child did not return its binding environment");
    const originalRunId = originalEnv.PI_SUBAGENT_RUN_ID;
    assert.ok(originalRunId);
    const originalBinding = JSON.parse(originalEnv.PI_SUBAGENT_EXTENSION_BINDINGS)[dispatch.BINDING];
    const originalPolicy = dispatch.loadPolicy(undefined, originalEnv);
    const originalInputBytes = await readFile(originalBinding.path, "utf8");

    await writeFile(join(preparedRepo, "original-build.ts"), "export const originalBuild = true;\n");
    execFileSync("git", ["add", "original-build.ts"], { cwd: preparedRepo });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "original build"], { cwd: preparedRepo });
    const builtHead = dispatch.gitHead(preparedRepo);
    const nextContract = dispatch.createIssueContract(42, originalContract.criteria, 2, originalContract.digest);
    const nextBytes = `${JSON.stringify(nextContract)}\n`;
    const nextPath = join(root, "next-contract.json");
    await writeFile(nextPath, nextBytes, { mode: 0o400 });
    const nextDescriptor = { path: nextPath, sha256: createHash("sha256").update(nextBytes).digest("hex") };
    const replan = { token: "native-replan-1", previousHead: builtHead, previousContractDigest: originalContract.digest, previousRound: 1 };
    const ownerEnv = { ...originalEnv, PI_SUBAGENT_RUN_ID: originalRunId };
    const amended = dispatch.prepareReplan({ input: originalBinding, contract: nextDescriptor, replan, authorization: { ownerRunId: originalRunId, token: replan.token } }, join(root, "native-replanned"), preparedRepo, ownerEnv);
    assert.equal(await readFile(originalBinding.path, "utf8"), originalInputBytes);
    assert.equal(amended.continuation.extensionBindings[dispatch.BINDING].path, amended.input.path);

    mock.onCall({ echoEnv: ["PI_SUBAGENT_EXTENSION_BINDINGS", "PI_SUBAGENT_RUN_ID", "PI_SUBAGENT_PARENT_RUN_ID"] });
    const continuation = await complete(executor, context, { workflowScript: `return await runs.all(${JSON.stringify([{ key: "same-owner-continuation", ...amended.continuation }])});` });
    assert.equal(continuation.status.state, "complete");
    const continuedEnv = findEnvironment(continuation.status.workflow.value[0]);
    assert.ok(continuedEnv, "fresh continuation did not return its binding environment");
    assert.notEqual(continuedEnv.PI_SUBAGENT_RUN_ID, originalRunId);
    const continuedPolicy = dispatch.loadPolicy(undefined, continuedEnv);
    assert.equal(continuedPolicy.continuation.authorizedBy, originalRunId);
    assert.equal(continuedPolicy.continuation.expectedHeadSha, builtHead);
    assert.doesNotThrow(() => dispatch.validateLaneStartup(continuedPolicy, preparedRepo));
    assert.equal(continuedPolicy.targetBase.headSha, originalPolicy.targetBase.headSha);

    await writeFile(join(preparedRepo, "repair.ts"), "export const repaired = true;\n");
    execFileSync("git", ["add", "repair.ts"], { cwd: preparedRepo });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "repair"], { cwd: preparedRepo });
    const repairedHead = dispatch.gitHead(preparedRepo);
    const review = { pr: 564, head: repairedHead, baseSha: dispatch.gitHead(repo), round: 1, contractDigest: nextContract.digest, replan: continuedPolicy.replan, roles: [{ role: "correctness", thinking: "high", task: "Review repaired continuation head" }] };
    assert.doesNotThrow(() => dispatch.prepareReview(review, join(root, "native-repaired-review"), continuedEnv));
    const rendered = records.renderRecord({ kind: "REVIEW-PANEL", pr: 564, input: amended.input, head: repairedHead, baseSha: continuedPolicy.targetBase.headSha, round: 1, reviewerReports: [{ role: "correctness", id: 5641, url: "https://github.com/example/project/pull/564#issuecomment-5641", head: repairedHead, round: 1 }], inputs: [], supersedes: null }, `## Native continuation evidence\n\n**Repaired commit**: \`${repairedHead}\``, { cwd: preparedRepo, env: continuedEnv });
    assert.match(rendered.markdown, new RegExp(repairedHead));
  });
});

test("full async adapter persists all 100 rows even when output preview is truncated", { skip: adapterSkip, timeout: 30000 }, async () => {
  await withAdapter(async ({ root, mock, executor, context }) => {
    const output = join(root, "preview.md");
    const rows = Array.from({ length: 100 }, (_, i) => ({ key: `issue-${i + 1}`, status: "GATED", recoverySource: { runId: `retained-${i + 1}`, artifactPaths: [`/fixture/report-${i + 1}.md`] } }));
    const { status, statusFile } = await complete(executor, context, { workflowScript: `return ${JSON.stringify(rows)};`, output, outputMode: "file-only" });
    assert.equal(status.state, "complete");
    const preview = await readFile(output, "utf8");
    assert.equal(preview.includes('"key": "issue-100"'), false);
    // This is the documented native persisted-state retrieval, not the preview file.
    const full = JSON.parse(await readFile(statusFile, "utf8")).workflow.value;
    assert.deepEqual(full, rows);
    assert.ok(full[99]);
    assert.equal(full[99].recoverySource.runId, "retained-100");
    assert.equal(mock.callCount(), 0);
  });
});
