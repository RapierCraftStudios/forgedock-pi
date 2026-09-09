import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Opt in with a pinned pi-subagents checkout that has its test dependencies installed.
// Uses the full native adapter + mock CLI, not a real model or live repository.
const source = process.env.PI_SUBAGENTS_ADAPTER_SOURCE;
const load = (file: string) => import(pathToFileURL(resolve(source!, file)).href);

async function withAdapter(run: (h: any) => Promise<void>) {
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
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, "base.txt"), "base\n");
    execFileSync("git", ["add", "base.txt"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base"], { cwd: repo });
    mock = helpers.createMockPi(); mock.install(); mock.reset();
    const executor = createSubagentExecutor({
      pi: { events: helpers.createEventBus(), getSessionName: () => undefined },
      state: { baseCwd: repo, currentSessionId: "session-123", asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
      config: { worktreeBaseDir: join(root, "worktrees") }, asyncByDefault: false,
      tempArtifactsDir: join(root, "artifacts"), getSubagentSessionRoot: () => join(root, "sessions"),
      expandTilde: (value: string) => value,
      discoverAgents: () => ({ agents: [helpers.makeAgent("echo", { thinking: false }), helpers.makeAgent("forgedock-work-on-coordinator", { thinking: false })] }),
      allowMutatingManagementActions: true,
    });
    await run({ root, repo, mock, executor, context: helpers.makeMinimalCtx(repo) });
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

async function ownerScript(output: string | false) {
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  const script = adapter.slice(adapter.indexOf("Use one visible promise graph.")).match(/```js\n([\s\S]*?)\n```/)?.[1];
  assert.ok(script);
  const helpers = script.slice(0, script.indexOf("if (!Number.isSafeInteger(ownerConcurrency)"));
  return `const configuredModel="test-model";\n${helpers}\nreturn await runIssue("owner", ${JSON.stringify({ agent: "echo", task: "Return fixture result", context: "fresh", worktree: true, output, outputMode: "inline", artifacts: true, acceptance: false })});`;
}

for (const explicitOutput of [true, false]) {
  test(`full adapter retained recovery with declared output=${explicitOutput}`, { skip: !source, timeout: 30000 }, async () => {
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

test("full adapter preserves original recovery references when the budget denies resume", { skip: !source, timeout: 30000 }, async () => {
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

test("prepared lane policy reaches the actual native child environment", { skip: !source, timeout: 30000 }, async () => {
  await withAdapter(async ({ root, repo, mock, executor, context }) => {
    const dispatch = await import(new URL("../../specs/helpers/dispatch.mjs", import.meta.url).href);
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/project.git"], { cwd: repo });
    await writeFile(join(repo, "forge.yaml"), 'project: {owner: example, repo: project}\nagents: {subagent_model: "test/model"}\n');
    await writeFile(join(repo, ".git", "info", "exclude"), "forge.yaml\n");
    const parentRoot = fileURLToPath(new URL("../..", import.meta.url));
    const controlPlane = dispatch.createControlPlaneDescriptor({ forgeDockRoot: parentRoot, piSubagentsRoot: realpathSync(join(parentRoot, "node_modules/pi-subagents")) });
    const prepared = dispatch.prepareBatch({ activeOwners: 1, launchAllowance: 8, requestStartedAt: "2026-01-01T00:00:00Z", controlPlane,
      issues: [{ number: 42, target: "staging", baseCwd: repo, predecessors: [] }] }, join(root, "prepared"), repo);
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
    assert.equal(policy.model, "test/model"); assert.equal(policy.remediationLimit, 1);
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

test("full async adapter persists all 100 rows even when output preview is truncated", { skip: !source, timeout: 30000 }, async () => {
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
