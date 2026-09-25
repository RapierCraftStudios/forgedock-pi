import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import vm from "node:vm";

const execFileAsync = promisify(execFile);
const helper = resolve("bin/forgedock-candidate.mjs");

async function prepared(issueRows = [
  { number: 1, title: "first", body: "## Acceptance Criteria\n- [ ] first result" },
  { number: 2, title: "second", body: "## Acceptance Criteria\n- [ ] second result\n\nDepends on #1" },
]) {
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
  max_concurrent: 2
`);
  await execFileAsync("git", ["add", "forge.yaml"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "fixture"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await execFileAsync("git", ["branch", "-M", "integration"], { cwd: root });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/integration", head], { cwd: root });
  const issues = join(root, "..", `forgedock-candidate-outcomes-issues-${root.split("/").at(-1)}.json`);
  await writeFile(issues, JSON.stringify({ issues: issueRows }));
  const out = join(root, "..", `forgedock-candidate-outcomes-artifacts-${root.split("/").at(-1)}`);
  const preparedResult = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", issueRows.map((issue) => `#${issue.number}`).join(" "), "--cwd", root, "--issues-file", issues, "--out", out])).stdout) as { planPath: string; workflowPath: string };
  const defaultResult = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--cwd", root, "--issues-file", issues], { env: { ...process.env, FORGEDOCK_CANDIDATE_ARTIFACT_ROOT: root } })).stdout) as { planPath: string };
  assert.match(defaultResult.planPath, /forgedock-candidate-artifacts/);
  await assert.rejects(execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--cwd", root, "--issues-file", issues, "--out", join(root, "contaminating-artifacts")]), /must be outside the source checkout; use/);
  const workflow = await readFile(preparedResult.workflowPath, "utf8");
  const execute = vm.runInNewContext(`(async (runs) => { ${workflow} })`, { Promise }) as (runs: { all: (items: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>> }) => Promise<any[]>;
  return { root, out, issues, planPath: preparedResult.planPath, workflowPath: preparedResult.workflowPath, defaultOut: defaultResult.planPath.split("/plan.json")[0]!, execute };
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
      return items.map(() => ({ ...outcome }));
    },
  });
  return { rows, calls };
}

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
  ]);
  const continuationInputPath = join(result.out, "continuation-input.json");
  const continuationOutDone = join(result.root, "..", `forgedock-candidate-continuation-done-${result.root.split("/").at(-1)}`);
  const continuationOutGated = join(result.root, "..", `forgedock-candidate-continuation-gated-${result.root.split("/").at(-1)}`);
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
        if (key === "issue-4") return [{ ok: true, runId: "native-independent-four", output: "FORGE_WORK_ON_RESULT status=DONE issue=4 pr=14 dependency=SATISFIED" }];
        throw new Error(`Unexpected owner launch ${key}`);
      },
    });
    await Promise.all([firstStartedPromise, thirdStartedPromise]);
    releaseFirst([{ ok: false, detached: true, runId: "native-detached-owner-one", error: "owner awaits supervisor" }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual([...calls].sort(), ["issue-1", "issue-3"], "a detached writer retains its concurrency slot");
    releaseThird([{ ok: true, runId: "native-independent-three", output: "FORGE_WORK_ON_RESULT status=DONE issue=3 pr=13 dependency=SATISFIED" }]);
    const initialRows = await running;
    assert.equal(initialRows[0]?.status, "WAITING");
    assert.equal(initialRows[0]?.nativeStatus, "detached");
    assert.equal(initialRows[0]?.runId, "native-detached-owner-one");
    assert.equal(initialRows[1]?.status, "WAITING");
    assert.equal(initialRows[1]?.nativeStatus, "not-started");
    assert.deepEqual(Array.from(initialRows[1]?.waitingFor ?? []), ["issue-1"]);
    assert.equal(initialRows[2]?.status, "DONE");
    assert.equal(initialRows[3]?.status, "DONE");
    assert.ok(calls.includes("issue-4"));
    assert.equal(calls.includes("issue-2"), false);

    const detached = initialRows[0]!;
    const terminalDone = {
      issue: 1, runId: detached.runId, nativeStatus: "completed", ok: true, status: "DONE",
      dependency: "SATISFIED", output: "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=11 dependency=SATISFIED", error: null,
    };
    const continuationRequest = {
      schema: "forgedock.candidate-dispatch-continuation/v1",
      initialResults: initialRows,
      terminalResults: [terminalDone],
    };
    await writeFile(continuationInputPath, JSON.stringify({ ...continuationRequest, terminalResults: [] }));
    await assert.rejects(execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInputPath, "--out", continuationOutDone]), /Wait for and resolve every exact detached owner/);
    await writeFile(continuationInputPath, JSON.stringify({ ...continuationRequest, terminalResults: [{ ...terminalDone, runId: "different-detached-run" }] }));
    await assert.rejects(execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInputPath, "--out", continuationOutDone]), /not bound to the exact owner run/);
    await writeFile(continuationInputPath, JSON.stringify(continuationRequest));
    const continuation = JSON.parse((await execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInputPath, "--out", continuationOutDone])).stdout) as { workflowPath: string };
    const workflow = await readFile(continuation.workflowPath, "utf8");
    const executeContinuation = vm.runInNewContext(`(async (runs) => { ${workflow} })`, { Promise }) as (runs: { all: (items: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>> }) => Promise<any[]>;
    const doneCalls: string[] = [];
    const doneRows = await executeContinuation({
      all: async (items) => {
        doneCalls.push(...items.map((item) => String(item.key)));
        return items.map(() => ({ ok: true, runId: "native-dependent-two", output: "FORGE_WORK_ON_RESULT status=DONE issue=2 pr=12 dependency=SATISFIED" }));
      },
    });
    assert.deepEqual(doneCalls, ["issue-2"]);
    assert.equal(doneRows[0]?.status, "DONE");
    assert.equal(doneRows[1]?.status, "DONE");
    assert.equal(doneRows[0]?.nativeStatus, "completed");
    assert.equal(doneRows[2]?.status, "DONE");
    assert.equal(doneRows[3]?.status, "DONE");

    const terminalGated = { ...terminalDone, status: "GATED", dependency: "UNSATISFIED", output: "FORGE_WORK_ON_RESULT status=GATED issue=1 pr=none dependency=UNSATISFIED" };
    await writeFile(continuationInputPath, JSON.stringify({ ...continuationRequest, terminalResults: [terminalGated] }));
    const gatedContinuationOut = JSON.parse((await execFileAsync("node", [helper, "continue-dispatch", "--plan", result.planPath, "--results", continuationInputPath, "--out", continuationOutGated])).stdout) as { workflowPath: string };
    const gatedWorkflow = await readFile(gatedContinuationOut.workflowPath, "utf8");
    const executeGatedContinuation = vm.runInNewContext(`(async (runs) => { ${gatedWorkflow} })`, { Promise }) as (runs: { all: (items: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>> }) => Promise<any[]>;
    const gatedCalls: string[] = [];
    const gatedRows = await executeGatedContinuation({
      all: async (items) => {
        gatedCalls.push(...items.map((item) => String(item.key)));
        return items.map(() => ({ ok: true, runId: "unexpected", output: "FORGE_WORK_ON_RESULT status=DONE issue=2 pr=12 dependency=SATISFIED" }));
      },
    });
    assert.deepEqual(gatedCalls, []);
    assert.equal(gatedRows[0]?.status, "GATED");
    assert.equal(gatedRows[1]?.status, "GATED");
    assert.deepEqual(Array.from(gatedRows[1]?.blockedBy ?? []), ["issue-1"]);
    assert.equal(gatedRows[2]?.status, "DONE");
    assert.equal(gatedRows[3]?.status, "DONE");
  } finally {
    await rm(continuationInputPath, { force: true });
    await rm(continuationOutDone, { recursive: true, force: true });
    await rm(continuationOutGated, { recursive: true, force: true });
    await cleanup(result);
  }
});
