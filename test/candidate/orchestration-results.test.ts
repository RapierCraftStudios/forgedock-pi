import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import vm from "node:vm";

const execFileAsync = promisify(execFile);
const helper = resolve("bin/forgedock-candidate.mjs");

async function prepared(issueRows = [
  { number: 1, title: "first", body: "## Acceptance Criteria\n- [ ] first result" },
  { number: 2, title: "second", body: "## Acceptance Criteria\n- [ ] second result\n\nDepends on #1" },
], ownerConcurrency = 2) {
  const root = await mkdtemp("/tmp/forgedock-candidate-outcomes-");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
  await writeFile(join(root, "README.md"), "outcomes\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
  await writeFile(join(root, "forge.yaml"), `
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
  max_concurrent: ${ownerConcurrency}
`);
  await execFileAsync("git", ["add", "forge.yaml"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "fixture"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await execFileAsync("git", ["branch", "-M", "integration"], { cwd: root });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/integration", head], { cwd: root });
  const issues = join(root, "..", `forgedock-candidate-outcomes-issues-${root.split("/").at(-1)}.json`);
  await writeFile(issues, JSON.stringify({ issues: issueRows }));
  const out = join(root, "..", `forgedock-candidate-outcomes-artifacts-${root.split("/").at(-1)}`);
  const preparedResult = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", issueRows.map((issue) => `#${issue.number}`).join(" "), "--cwd", root, "--issues-file", issues, "--out", out])).stdout) as { planPath: string; workflowPath: string; requestPath: string; ownerConcurrency: { configured: number; effective: number } };
  const preparedRequest = JSON.parse(await readFile(preparedResult.requestPath, "utf8")) as { maxSubagentSpawnsPerRun: number };
  const defaultResult = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--cwd", root, "--issues-file", issues], { env: { ...process.env, FORGEDOCK_CANDIDATE_ARTIFACT_ROOT: root } })).stdout) as { planPath: string };
  assert.match(defaultResult.planPath, /forgedock-candidate-artifacts/);
  await assert.rejects(execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--cwd", root, "--issues-file", issues, "--out", join(root, "contaminating-artifacts")]), /must be outside the source checkout; use/);
  const workflow = await readFile(preparedResult.workflowPath, "utf8");
  const execute = vm.runInNewContext(`(async (runs) => { ${workflow} })`, { Promise }) as (runs: { all: (items: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>> }) => Promise<any[]>;
  return { root, out, issues, planPath: preparedResult.planPath, workflowPath: preparedResult.workflowPath, requestPath: preparedResult.requestPath, launchAllowance: preparedRequest.maxSubagentSpawnsPerRun, ownerConcurrencySummary: preparedResult.ownerConcurrency, defaultOut: defaultResult.planPath.split("/plan.json")[0]!, ownerConcurrency, execute };
}

async function nativeStatusRef(out: string, runId: string, limit: number, used: number, rows: Array<Record<string, any>>, workflowValue: Array<Record<string, any>> = rows) {
  const path = join(out, `${runId}.status.json`);
  const steps = rows.flatMap((row) => [
    ...(typeof row.runId === "string" ? [{ workflowKey: row.key, runId: row.runId }] : []),
    ...(typeof row.recoverySource?.runId === "string" ? [{ workflowKey: row.key, runId: row.recoverySource.runId }] : []),
  ]);
  const status = { runId, state: "completed", mode: "workflow", runFanoutBudget: { limit, used, remaining: limit - used }, workflow: { value: workflowValue }, steps };
  const bytes = JSON.stringify(status);
  await writeFile(path, bytes);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), runId };
}

async function nativeOwnerStatusRef(out: string, runId: string, output: string, acceptanceStatus: string) {
  const dir = join(out, `${runId}-terminal`);
  await mkdir(dir, { recursive: true });
  const outputPath = join(dir, "output-0.log");
  const outputBytes = Buffer.from(output, "utf8");
  await writeFile(outputPath, outputBytes);
  const path = join(dir, "status.json");
  const status = { runId, state: "complete", mode: "single", outputFile: outputPath, steps: [{ status: "complete", acceptance: { status: acceptanceStatus } }] };
  const statusBytes = JSON.stringify(status);
  await writeFile(path, statusBytes);
  return { path, sha256: createHash("sha256").update(statusBytes).digest("hex"), outputSha256: createHash("sha256").update(outputBytes).digest("hex"), runId };
}

async function cleanup(result: Awaited<ReturnType<typeof prepared>>) {
  await rm(result.root, { recursive: true, force: true });
  await rm(result.out, { recursive: true, force: true });
  await rm(result.defaultOut, { recursive: true, force: true });
  await rm(result.issues, { force: true });
}

async function runSingle(result: Awaited<ReturnType<typeof prepared>>, outcome: Record<string, unknown>) {
  const calls: string[] = [];
  const rows = await result.execute({
    all: async (items) => {
      calls.push(...items.map((item) => String(item.key)));
      return items.map(() => ({ ...outcome, results: outcome.results ?? [{ acceptance: { status: outcome.nativeAcceptanceStatus ?? "accepted" } }] }));
    },
  });
  return { rows, calls };
}

test("generated dispatch honors configured owner ceilings 1, 2, and 10", { timeout: 30000 }, async () => {
  const issueRows = Array.from({ length: 10 }, (_, index) => ({ number: index + 1, title: `ready ${index + 1}`, body: `## Acceptance Criteria\n- [ ] complete ${index + 1}` }));
  for (const configured of [1, 2, 10]) {
    const result = await prepared(issueRows, configured);
    try {
      const plan = JSON.parse(await readFile(result.planPath, "utf8")) as { ownerConcurrency: { configured: number; effective: number }; issues: Array<{ number: number; admitted: boolean }> };
      const request = JSON.parse(await readFile(result.requestPath, "utf8")) as { globalConcurrencyLimit: number };
      assert.deepEqual(plan.ownerConcurrency, { configured, effective: configured });
      assert.deepEqual(result.ownerConcurrencySummary, { configured, effective: configured });
      assert.ok(plan.issues.every((issue) => issue.admitted));
      assert.equal(request.globalConcurrencyLimit, configured);
      const active = new Set<string>();
      const started: string[] = [];
      let peak = 0;
      const rows = await result.execute({
        all: async (items) => {
          assert.equal(items.length, 1);
          const key = String(items[0]?.key);
          active.add(key);
          started.push(key);
          peak = Math.max(peak, active.size);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active.delete(key);
          const issue = Number(key.slice("issue-".length));
          return [{ ok: true, runId: `native-${issue}`, results: [{ acceptance: { status: "accepted" } }], output: `FORGE_WORK_ON_RESULT status=DONE issue=${issue} pr=none dependency=SATISFIED` }];
        },
      });
      assert.equal(peak, configured, `configured ceiling ${configured}`);
      assert.equal(started.length, issueRows.length);
      assert.ok(rows.every((row: { status: string; dependency: string }) => row.status === "DONE" && row.dependency === "SATISFIED"));
    } finally {
      await cleanup(result);
    }
  }
});

test("continuation request preserves a configured ten-owner ceiling", async () => {
  const issueRows = Array.from({ length: 10 }, (_, index) => ({ number: index + 1, title: `ready ${index + 1}`, body: `## Acceptance Criteria\n- [ ] complete ${index + 1}` }));
  const result = await prepared(issueRows, 10);
  const plan = JSON.parse(await readFile(result.planPath, "utf8")) as { issues: Array<{ number: number }>; ownerConcurrency: { configured: number; effective: number }; launchAllowance: number };
  const continuationInput = join(result.out, "continuation-input.json");
  const continuationOut = join(result.root, "..", `forgedock-candidate-continuation-limit-${result.root.split("/").at(-1)}`);
  try {
    const initialResults = plan.issues.map((issue) => issue.number === 1
      ? { key: "issue-1", issue: 1, repository: "example/product", target: "integration", ok: false, status: "WAITING", nativeStatus: "detached", nativeAcceptanceStatus: "unknown", dependency: "UNSATISFIED", runId: "native-detached-owner-one", output: null, blockedBy: [], waitingFor: [], detached: true, error: "retained detached owner" }
      : { key: `issue-${issue.number}`, issue: issue.number, repository: "example/product", target: "integration", ok: true, status: "DONE", nativeStatus: "completed", nativeAcceptanceStatus: "accepted", dependency: "SATISFIED", runId: `native-owner-${issue.number}`, output: `FORGE_WORK_ON_RESULT status=DONE issue=${issue.number} pr=none dependency=SATISFIED`, blockedBy: [], waitingFor: [], detached: false, error: null });
    const terminalOutput = "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=none dependency=SATISFIED";
    const terminalResults = [{ issue: 1, runId: "native-detached-owner-one", nativeStatus: "completed", ok: true, status: "DONE", nativeAcceptanceStatus: "accepted", nativeStatusRef: await nativeOwnerStatusRef(result.out, "native-detached-owner-one", terminalOutput, "accepted"), dependency: "SATISFIED", output: terminalOutput, error: null }];
    const nativeStatus = await nativeStatusRef(result.out, "native-root-limit", plan.launchAllowance, 19, initialResults);
    const input = { schema: "forgedock.candidate-dispatch-continuation/v1", initialResults, terminalResults, nativeStatus };
    await writeFile(continuationInput, JSON.stringify({ ...input, nativeStatus: { ...nativeStatus, observedUsed: 20 } }));
    await assert.rejects(execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInput, "--out", continuationOut]), /persisted and observed fanout usage disagree/);
    await writeFile(continuationInput, JSON.stringify(input));
    const resultJson = JSON.parse((await execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInput, "--out", continuationOut])).stdout) as { continuationPath: string; requestPath: string; workflowPath: string; ownerConcurrency: { configured: number; effective: number }; fanoutBudget: { originalLimit: number; spent: number; remaining: number } };
    const request = JSON.parse(await readFile(resultJson.requestPath, "utf8")) as { globalConcurrencyLimit: number; maxSubagentSpawnsPerRun: number };
    const workflow = await readFile(resultJson.workflowPath, "utf8");
    assert.deepEqual(plan.ownerConcurrency, { configured: 10, effective: 10 });
    assert.deepEqual(resultJson.ownerConcurrency, { configured: 10, effective: 10 });
    assert.equal(request.globalConcurrencyLimit, 10);
    assert.equal(resultJson.fanoutBudget.originalLimit, plan.launchAllowance);
    assert.equal(resultJson.fanoutBudget.spent, 19);
    assert.equal(resultJson.fanoutBudget.remaining, plan.launchAllowance - 19);
    assert.equal(request.maxSubagentSpawnsPerRun, plan.launchAllowance - 19);
    assert.match(workflow, /const ownerConcurrency = 10;/);
  } finally {
    await rm(continuationInput, { force: true });
    await rm(continuationOut, { recursive: true, force: true });
    await cleanup(result);
  }
});

test("normalizes completed gated owners without relaunching them", async () => {
  const result = await prepared();
  try {
    const gated = await runSingle(result, { ok: true, status: "FAILED", runId: "gated", output: "FORGE_WORK_ON_RESULT status=GATED issue=1 pr=none dependency=UNSATISFIED" });
    assert.equal(gated.rows[0]?.status, "GATED");
    assert.equal(gated.rows[0]?.dependency, "UNSATISFIED");
    assert.equal(gated.rows[0]?.ok, true);
    assert.deepEqual(gated.calls, ["issue-1"]);
  } finally {
    await cleanup(result);
  }
});

test("accepts only a valid delivered DONE marker and retains native failures", async () => {
  const result = await prepared();
  try {
    const done = await runSingle(result, { ok: true, runId: "done", output: "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=11 dependency=SATISFIED" });
    assert.equal(done.rows[0]?.key, "issue-1");
    assert.equal(done.rows[0]?.status, "DONE");
    assert.equal(done.rows[0]?.dependency, "SATISFIED");
    assert.equal(done.rows[0]?.ok, true);
    assert.equal(done.rows[0]?.runId, "done");
    assert.equal(done.rows[0]?.error, null);

    const nativeFailure = await runSingle(result, { ok: false, runId: "failed", error: "provider stopped", output: "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=11 dependency=SATISFIED" });
    assert.equal(nativeFailure.rows[0]?.status, "FAILED");
    assert.equal(nativeFailure.rows[0]?.ok, false);
    assert.match(nativeFailure.rows[0]?.error ?? "", /provider stopped/);
  } finally {
    await cleanup(result);
  }
});

test("recovers a rejected DONE result once on the same owner and retains native acceptance history", async () => {
  const result = await prepared();
  try {
    const calls: string[] = [];
    const rows = await result.execute({
      all: async (items) => {
        const key = String(items[0]?.key);
        calls.push(key);
        if (key === "issue-1") return [{ ok: true, runId: "native-rejected-done", resumability: { state: "resumable" }, results: [{ acceptance: { status: "rejected" } }], output: "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=11 dependency=SATISFIED" }];
        if (key === "issue-1-recovery") return [{ ok: true, runId: "native-recovered-gated", results: [{ acceptance: { status: "rejected" } }], output: "FORGE_WORK_ON_RESULT status=GATED issue=1 pr=none dependency=UNSATISFIED" }];
        throw new Error(`Unexpected owner launch ${key}`);
      },
    });
    assert.deepEqual(calls, ["issue-1", "issue-1-recovery"]);
    assert.equal(rows[0]?.status, "GATED");
    assert.equal(rows[0]?.nativeAcceptanceStatus, "rejected");
    assert.equal(rows[0]?.recoverySource?.runId, "native-rejected-done");
    assert.equal(rows[0]?.recoverySource?.acceptanceStatus, "rejected");
    assert.equal(rows[1]?.status, "GATED");
    assert.deepEqual(Array.from(rows[1]?.blockedBy ?? []), ["issue-1"]);
  } finally {
    await cleanup(result);
  }
});

test("rejects malformed, duplicate, wrong-issue, and unsatisfied DONE markers", async () => {
  const result = await prepared();
  try {
    const cases = [
      "not a marker",
      "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=11 dependency=SATISFIED\nFORGE_WORK_ON_RESULT status=DONE issue=1 pr=11 dependency=SATISFIED",
      "FORGE_WORK_ON_RESULT status=DONE issue=2 pr=11 dependency=SATISFIED",
      "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=11 dependency=UNSATISFIED",
    ];
    for (const output of cases) {
      const rows = await runSingle(result, { ok: true, runId: "invalid", output });
      assert.equal(rows.rows[0]?.status, "FAILED", output);
      assert.equal(rows.rows[0]?.dependency, "UNSATISFIED", output);
      assert.equal(rows.rows[0]?.ok, false, output);
    }
  } finally {
    await cleanup(result);
  }
});

test("a gated predecessor stays unsatisfied and does not launch its dependent", async () => {
  const result = await prepared();
  try {
    const calls: string[] = [];
    const rows = await result.execute({
      all: async (items) => {
        calls.push(...items.map((item) => String(item.key)));
        return items.map((item) => item.key === "issue-1"
          ? { ok: true, runId: "gated", output: "FORGE_WORK_ON_RESULT status=GATED issue=1 pr=none dependency=UNSATISFIED" }
          : { ok: true, runId: "unexpected", output: "FORGE_WORK_ON_RESULT status=DONE issue=2 pr=12 dependency=SATISFIED" });
      },
    });
    assert.equal(calls.join(","), "issue-1");
    assert.equal(rows[0]?.status, "GATED");
    assert.equal(rows[1]?.status, "GATED");
    assert.deepEqual(Array.from(rows[1]?.blockedBy ?? []), ["issue-1"]);
  } finally {
    await cleanup(result);
  }
});

test("detached owners retain capacity and generated continuation releases only terminal dependencies", async () => {
  const result = await prepared([
    { number: 1, title: "detached producer", body: "## Acceptance Criteria\n- [ ] producer" },
    { number: 2, title: "dependent", body: "## Acceptance Criteria\n- [ ] consumer\n\nDepends on #1" },
    { number: 3, title: "independent three", body: "## Acceptance Criteria\n- [ ] independent three" },
    { number: 4, title: "independent four", body: "## Acceptance Criteria\n- [ ] independent four" },
    { number: 5, title: "second dependent", body: "## Acceptance Criteria\n- [ ] downstream consumer\n\nDepends on #2" },
  ]);
  const continuationInputPath = join(result.out, "continuation-input.json");
  const continuationOutDone = join(result.root, "..", `forgedock-candidate-continuation-done-${result.root.split("/").at(-1)}`);
  const continuationOutSecond = join(result.root, "..", `forgedock-candidate-continuation-second-${result.root.split("/").at(-1)}`);
  try {
    const calls: string[] = [];
    let releaseFirst!: (value: Array<Record<string, unknown>>) => void;
    let releaseThird!: (value: Array<Record<string, unknown>>) => void;
    let firstStarted!: () => void;
    let thirdStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const thirdStartedPromise = new Promise<void>((resolve) => { thirdStarted = resolve; });
    const firstResult = new Promise<Array<Record<string, unknown>>>((resolve) => { releaseFirst = resolve; });
    const thirdResult = new Promise<Array<Record<string, unknown>>>((resolve) => { releaseThird = resolve; });
    const running = result.execute({
      all: async (items) => {
        const key = String(items[0]?.key);
        calls.push(key);
        if (key === "issue-1") { firstStarted(); return firstResult; }
        if (key === "issue-3") { thirdStarted(); return thirdResult; }
        if (key === "issue-4") return [{ ok: true, runId: "native-independent-four", results: [{ acceptance: { status: "accepted" } }], output: "FORGE_WORK_ON_RESULT status=DONE issue=4 pr=14 dependency=SATISFIED" }];
        throw new Error(`Unexpected owner launch ${key}`);
      },
    });
    await Promise.all([firstStartedPromise, thirdStartedPromise]);
    releaseFirst([{ ok: false, detached: true, runId: "native-detached-owner-one", error: "owner awaits supervisor" }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual([...calls].sort(), ["issue-1", "issue-3"], "a detached writer retains its concurrency slot");
    releaseThird([{ ok: true, runId: "native-independent-three", results: [{ acceptance: { status: "accepted" } }], output: "FORGE_WORK_ON_RESULT status=DONE issue=3 pr=13 dependency=SATISFIED" }]);
    const initialRows = await running;
    const initialByKey = new Map(initialRows.map((row) => [row.key, row]));
    assert.equal(initialByKey.get("issue-1")?.status, "WAITING");
    assert.equal(initialByKey.get("issue-1")?.nativeStatus, "detached");
    assert.equal(initialByKey.get("issue-1")?.runId, "native-detached-owner-one");
    for (const key of ["issue-2", "issue-5"]) {
      assert.equal(initialByKey.get(key)?.status, "WAITING");
      assert.equal(initialByKey.get(key)?.nativeStatus, "not-started");
    }
    assert.deepEqual(Array.from(initialByKey.get("issue-2")?.waitingFor ?? []), ["issue-1"]);
    assert.deepEqual(Array.from(initialByKey.get("issue-5")?.waitingFor ?? []), ["issue-2"]);
    assert.equal(initialByKey.get("issue-3")?.status, "DONE");
    assert.equal(initialByKey.get("issue-4")?.status, "DONE");
    assert.ok(calls.includes("issue-4"));
    assert.equal(calls.includes("issue-2"), false);

    const detached = initialRows[0]!;
    const terminalDoneOutput = "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=11 dependency=SATISFIED";
    const terminalDone = {
      issue: 1, runId: detached.runId, nativeStatus: "completed", ok: true, status: "DONE", nativeAcceptanceStatus: "accepted",
      nativeStatusRef: await nativeOwnerStatusRef(result.out, String(detached.runId), terminalDoneOutput, "accepted"),
      dependency: "SATISFIED", output: terminalDoneOutput, error: null,
    };
    const nativeStatus = await nativeStatusRef(result.out, "native-root-initial", result.launchAllowance, 8, initialRows);
    const continuationRequest = {
      schema: "forgedock.candidate-dispatch-continuation/v1",
      initialResults: initialRows,
      terminalResults: [terminalDone],
      nativeStatus,
    };
    await writeFile(continuationInputPath, JSON.stringify({ ...continuationRequest, terminalResults: [] }));
    await assert.rejects(execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInputPath, "--out", continuationOutDone]), /Wait for and resolve every exact detached owner/);
    await writeFile(continuationInputPath, JSON.stringify({ ...continuationRequest, terminalResults: [{ ...terminalDone, runId: "different-detached-run" }] }));
    await assert.rejects(execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInputPath, "--out", continuationOutDone]), /not bound to the exact owner run/);
    await writeFile(continuationInputPath, JSON.stringify(continuationRequest));
    const continuation = JSON.parse((await execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInputPath, "--out", continuationOutDone])).stdout) as { continuationPath: string; workflowPath: string; requestPath: string; fanoutBudget: { originalLimit: number; spent: number; remaining: number } };
    const continuationRecord = JSON.parse(await readFile(continuation.continuationPath, "utf8")) as { ownerConcurrency: { configured: number; effective: number }; fanoutHistory: unknown[] };
    assert.deepEqual(continuationRecord.ownerConcurrency, { configured: 2, effective: 2 });
    assert.equal(continuationRecord.fanoutHistory.length, 1);
    assert.deepEqual(continuation.fanoutBudget, { originalLimit: result.launchAllowance, spent: 8, remaining: result.launchAllowance - 8 });
    const firstRequest = JSON.parse(await readFile(continuation.requestPath, "utf8")) as { maxSubagentSpawnsPerRun: number };
    assert.equal(firstRequest.maxSubagentSpawnsPerRun, result.launchAllowance - 8);
    const workflow = await readFile(continuation.workflowPath, "utf8");
    const executeContinuation = vm.runInNewContext(`(async (runs) => { ${workflow} })`, { Promise }) as (runs: { all: (items: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>> }) => Promise<any[]>;
    const firstContinuationCalls: string[] = [];
    const firstContinuationRows = await executeContinuation({
      all: async (items) => {
        firstContinuationCalls.push(...items.map((item) => String(item.key)));
        return [{ ok: false, detached: true, runId: "native-dependent-two", error: "second owner awaits its exact native run" }];
      },
    });
    assert.deepEqual(firstContinuationCalls, ["issue-2"]);
    const firstContinuationByKey = new Map(firstContinuationRows.map((row) => [row.key, row]));
    assert.equal(firstContinuationByKey.get("issue-1")?.status, "DONE");
    assert.equal(firstContinuationByKey.get("issue-2")?.status, "WAITING");
    assert.equal(firstContinuationByKey.get("issue-2")?.nativeStatus, "detached");
    assert.equal(firstContinuationByKey.get("issue-3")?.status, "DONE");
    assert.equal(firstContinuationByKey.get("issue-4")?.status, "DONE");
    assert.equal(firstContinuationByKey.get("issue-5")?.status, "WAITING");
    assert.deepEqual(Array.from(firstContinuationByKey.get("issue-5")?.waitingFor ?? []), ["issue-2"]);

    const secondNativeStatus = await nativeStatusRef(result.out, "native-root-continuation", result.launchAllowance - 8, 3, [firstContinuationByKey.get("issue-2")!], firstContinuationRows);
    const continuationBytes = await readFile(continuation.continuationPath);
    const previousContinuation = { path: continuation.continuationPath, sha256: createHash("sha256").update(continuationBytes).digest("hex") };
    const terminalSecondOutput = "FORGE_WORK_ON_RESULT status=DONE issue=2 pr=12 dependency=SATISFIED";
    const terminalSecond = { issue: 2, runId: "native-dependent-two", nativeStatus: "completed", ok: true, status: "DONE", nativeAcceptanceStatus: "accepted", nativeStatusRef: await nativeOwnerStatusRef(result.out, "native-dependent-two", terminalSecondOutput, "accepted"), dependency: "SATISFIED", output: terminalSecondOutput, error: null };
    await writeFile(continuationInputPath, JSON.stringify({ schema: "forgedock.candidate-dispatch-continuation/v1", initialResults: firstContinuationRows, terminalResults: [terminalSecond], nativeStatus: secondNativeStatus, previousContinuation }));
    const secondContinuation = JSON.parse((await execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInputPath, "--out", continuationOutSecond])).stdout) as { workflowPath: string; requestPath: string; fanoutBudget: { originalLimit: number; spent: number; remaining: number } };
    assert.deepEqual(secondContinuation.fanoutBudget, { originalLimit: result.launchAllowance, spent: 11, remaining: result.launchAllowance - 11 });
    const secondRequest = JSON.parse(await readFile(secondContinuation.requestPath, "utf8")) as { maxSubagentSpawnsPerRun: number };
    assert.equal(secondRequest.maxSubagentSpawnsPerRun, result.launchAllowance - 11);
    const secondWorkflow = await readFile(secondContinuation.workflowPath, "utf8");
    const executeSecondContinuation = vm.runInNewContext(`(async (runs) => { ${secondWorkflow} })`, { Promise }) as (runs: { all: (items: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>> }) => Promise<any[]>;
    const secondCalls: string[] = [];
    const finalRows = await executeSecondContinuation({
      all: async (items) => {
        secondCalls.push(...items.map((item) => String(item.key)));
        return items.map(() => ({ ok: true, runId: "native-downstream-five", results: [{ acceptance: { status: "accepted" } }], output: "FORGE_WORK_ON_RESULT status=DONE issue=5 pr=15 dependency=SATISFIED" }));
      },
    });
    assert.deepEqual(secondCalls, ["issue-5"]);
    const finalByKey = new Map(finalRows.map((row) => [row.key, row]));
    for (const key of ["issue-1", "issue-2", "issue-3", "issue-4", "issue-5"]) assert.equal(finalByKey.get(key)?.status, "DONE", key);
  } finally {
    await rm(continuationInputPath, { force: true });
    await rm(continuationOutDone, { recursive: true, force: true });
    await rm(continuationOutSecond, { recursive: true, force: true });
    await cleanup(result);
  }
});

test("a rejected native GATED result is terminal and cannot release dependents", async () => {
  const result = await prepared([
    { number: 1, title: "gated producer", body: "## Acceptance Criteria\n- [ ] producer" },
    { number: 2, title: "dependent", body: "## Acceptance Criteria\n- [ ] consumer\n\nDepends on #1" },
  ]);
  const continuationInputPath = join(result.out, "gated-continuation-input.json");
  const continuationOut = join(result.root, "..", `forgedock-candidate-continuation-gated-${result.root.split("/").at(-1)}`);
  try {
    const initialRows = await result.execute({
      all: async (items) => [{ ok: false, detached: true, runId: "native-gated-owner-one", error: "owner remains detached" }],
    });
    const initial = initialRows.find((row) => row.key === "issue-1")!;
    const nativeStatus = await nativeStatusRef(result.out, "native-root-gated", result.launchAllowance, 4, initialRows);
    const terminalGatedOutput = "FORGE_WORK_ON_RESULT status=GATED issue=1 pr=none dependency=UNSATISFIED";
    const terminalGated = { issue: 1, runId: initial.runId, nativeStatus: "completed", ok: true, status: "GATED", nativeAcceptanceStatus: "rejected", nativeStatusRef: await nativeOwnerStatusRef(result.out, String(initial.runId), terminalGatedOutput, "rejected"), dependency: "UNSATISFIED", output: terminalGatedOutput, error: null };
    await writeFile(continuationInputPath, JSON.stringify({ schema: "forgedock.candidate-dispatch-continuation/v1", initialResults: initialRows, terminalResults: [terminalGated], nativeStatus }));
    const continuation = JSON.parse((await execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInputPath, "--out", continuationOut])).stdout) as { workflowPath: string };
    const workflow = await readFile(continuation.workflowPath, "utf8");
    const executeContinuation = vm.runInNewContext(`(async (runs) => { ${workflow} })`, { Promise }) as (runs: { all: (items: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>> }) => Promise<any[]>;
    const calls: string[] = [];
    const rows = await executeContinuation({ all: async (items) => { calls.push(...items.map((item) => String(item.key))); return []; } });
    assert.deepEqual(calls, []);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    assert.equal(byKey.get("issue-1")?.status, "GATED");
    assert.equal(byKey.get("issue-1")?.nativeAcceptanceStatus, "rejected");
    assert.equal(byKey.get("issue-2")?.status, "GATED");
    assert.deepEqual(Array.from(byKey.get("issue-2")?.blockedBy ?? []), ["issue-1"]);
  } finally {
    await rm(continuationInputPath, { force: true });
    await rm(continuationOut, { recursive: true, force: true });
    await cleanup(result);
  }
});
