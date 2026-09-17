import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import vm from "node:vm";

const execFileAsync = promisify(execFile);
const helper = resolve("bin/forgedock-candidate.mjs");

async function prepared() {
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
  await writeFile(issues, JSON.stringify({ issues: [
    { number: 1, title: "first", body: "## Acceptance Criteria\n- [ ] first result" },
    { number: 2, title: "second", body: "## Acceptance Criteria\n- [ ] second result\n\nDepends on #1" },
  ] }));
  const out = join(root, "..", `forgedock-candidate-outcomes-artifacts-${root.split("/").at(-1)}`);
  const preparedResult = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--cwd", root, "--issues-file", issues, "--out", out])).stdout) as { workflowPath: string };
  const defaultResult = JSON.parse((await execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--cwd", root, "--issues-file", issues], { env: { ...process.env, FORGEDOCK_CANDIDATE_ARTIFACT_ROOT: root } })).stdout) as { planPath: string };
  assert.match(defaultResult.planPath, /forgedock-candidate-artifacts/);
  await assert.rejects(execFileAsync("node", [helper, "prepare-dispatch", "--selector", "#1 #2", "--cwd", root, "--issues-file", issues, "--out", join(root, "contaminating-artifacts")]), /must be outside the source checkout; use/);
  const workflow = await readFile(preparedResult.workflowPath, "utf8");
  const execute = vm.runInNewContext(`(async (runs) => { ${workflow} })`, { Promise }) as (runs: { all: (items: Array<Record<string, unknown>>) => Promise<Array<Record<string, unknown>>> }) => Promise<any[]>;
  return { root, out, issues, defaultOut: defaultResult.planPath.split("/plan.json")[0]!, execute };
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
