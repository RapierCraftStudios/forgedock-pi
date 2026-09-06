import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Real workflow + admission engines; simulated owners/reviewers, no model or live repo.
const source = process.env.PI_SUBAGENTS_SOURCE;
type NodeSpec = { key: string; predecessors: string[]; launch: Record<string, unknown> };

async function runtime() {
  const load = (file: string) => import(pathToFileURL(resolve(source!, file)).href);
  return { ...(await load("src/workflows/scripted-workflow.ts")), ...(await load("src/runs/shared/run-fanout-budget.ts")) };
}
async function scriptFor(nodes: NodeSpec[], concurrency: number) {
  const spec = await readFile("specs/pi-adapter.md", "utf8");
  const snippet = spec.slice(spec.indexOf("Use one visible promise graph.")).match(/```js\n([\s\S]*?)\n```/)?.[1];
  assert.ok(snippet);
  return `const configuredModel="test/model"; const ownerConcurrency=${concurrency}; const issueGraph=${JSON.stringify(nodes)};\n${snippet}`;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const marker = (n: number, status = "DONE") => `FORGE_WORK_ON_RESULT status=${status} issue=${n} pr=${n + 1000} dependency=${status === "DONE" ? "SATISFIED" : "UNSATISFIED"}`;

const nodes: NodeSpec[] = Array.from({ length: 100 }, (_, index) => {
  const n = index + 1;
  const predecessor = ({ 5: 4, 7: 6, 8: 7, 11: 10, 13: 12 } as Record<number, number>)[n]
    ?? (n > 20 && n % 5 === 0 ? n - 1 : undefined);
  return { key: `issue-${n}`, predecessors: predecessor ? [`issue-${predecessor}`] : [],
    launch: { agent: "worker", task: `Issue ${n}`, cwd: `/simulated/issue-${n}` } };
});

test("100 issue DAG streams bounded owners and shared-budget nested reviews", { skip: !source, timeout: 45000 }, async () => {
  const { runWorkflowScript, createRunFanoutBudget, claimRunFanoutBatch, getRunFanoutBudgetSnapshot } = await runtime();
  const budget = createRunFanoutBudget(`forge-scale-${randomUUID()}`, 920);
  const initialStarted = deferred();
  const releaseInitial = deferred();
  const releaseSlow = deferred();
  const activeOwners = new Set<number>();
  const finished = new Set<number>();
  const starts: number[] = [];
  const events: string[] = [];
  let peakOwners = 0, activeReviews = 0, peakReviews = 0, reviewCalls = 0, expectedReviews = 0, initialCount = 0;
  let graph: Promise<any> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    graph = runWorkflowScript({ script: await scriptFor(nodes, 4), globalConcurrencyLimit: 4, timeoutMs: 35000,
      admit: (calls: Array<{ key: string }>) => claimRunFanoutBatch(budget, calls.map(c => c.key)),
      status: async () => { throw new Error("no status polling expected"); },
      launch: async (key: string, params: Record<string, unknown>) => {
        const n = params.resume ? 12 : Number(key.slice("issue-".length));
        assert.ok(n >= 1 && n <= 100);
        assert.equal(activeOwners.has(n), false, "never overlap a retained owner with itself");
        if (params.resume) {
          assert.equal(params.resume, "retained-12");
          assert.equal(params.agent, undefined);
          assert.equal(params.model, undefined);
        } else {
          assert.equal(params.model, "test/model");
          assert.equal(params.cwd, `/simulated/issue-${n}`);
          for (const predecessor of nodes[n - 1]!.predecessors) assert.ok(finished.has(Number(predecessor.slice(6))));
        }
        starts.push(n); events.push(`start-${n}`); activeOwners.add(n);
        peakOwners = Math.max(peakOwners, activeOwners.size);
        try {
          if (initialCount < 4) {
            initialCount++;
            if (initialCount === 4) initialStarted.release();
            await releaseInitial.promise;
          }
          if (n === 4) await releaseSlow.promise;
          if (n === 6) { releaseSlow.release(); return { key, ok: true, runId: key, output: marker(n, "GATED") }; }
          if (n === 10) return { key, ok: false, runId: key, output: "unrecoverable fixture", resumability: { state: "not-resumable" } };
          if (n === 12 && !params.resume) return { key, ok: false, runId: "retained-12", output: "provider interrupted", resumability: { state: "resumable" } };

          // Role count becomes known only inside the simulated owner's investigation.
          const roles = ["correctness", "security", "infra", "test-quality"].slice(0, 2 + n % 3);
          const rounds = n === 15 ? 2 : 1; // one cohesive fallback in the same owner
          expectedReviews += roles.length * rounds;
          for (let round = 0; round < rounds; round++) {
            const items = roles.map(role => ({ key: `${role}-${round}`, agent: "reviewer", task: `Review ${n}` }));
            await runWorkflowScript({ script: `return await runs.all(${JSON.stringify(items)});`, globalConcurrencyLimit: 2, timeoutMs: 15000,
              admit: (calls: Array<{ key: string }>) => claimRunFanoutBatch({ ...budget, parentPath: key }, calls.map(c => c.key)),
              status: async () => { throw new Error("no nested status polling expected"); },
              launch: async (reviewKey: string) => {
                reviewCalls++; activeReviews++; peakReviews = Math.max(peakReviews, activeReviews);
                try {
                  await new Promise(resolve => setTimeout(resolve, 2));
                  return { key: reviewKey, ok: true, runId: `${key}-${reviewKey}`, output: "verified fixture review" };
                } finally { activeReviews--; }
              },
            });
          }
          finished.add(n);
          return { key, ok: true, runId: params.resume ? "retained-12-resumed" : key,
            output: `${"Full evidence stays in native artifacts. ".repeat(100)}\n${marker(n)}`,
            outputReference: `/simulated/evidence/${n}.md` };
        } finally { activeOwners.delete(n); events.push(`end-${n}`); }
      },
    });
    await Promise.race([initialStarted.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("initial owners did not start")), 5000); })]);
    assert.equal(getRunFanoutBudgetSnapshot(budget).used, 4, "queued owners must not claim the whole allowance");
    releaseInitial.release();
    const result = await graph;
    assert.equal(result.value.length, 100);
    assert.equal(peakOwners, 4);
    assert.ok(peakReviews > 0 && peakReviews <= 8, "nested reviewers run while all owner slots are held");
    assert.ok(events.indexOf("start-6") < events.indexOf("end-4"), "an independent owner bypasses a waiting dependent");
    assert.equal(new Set(starts).size, 97);
    assert.equal(starts.length, 98, "only one retained-owner recovery is admitted");
    assert.equal(starts.filter(n => n === 12).length, 2);
    assert.equal(starts.filter(n => n === 15).length, 1, "fallback review does not create another writer");
    assert.equal(reviewCalls, expectedReviews);
    assert.equal(getRunFanoutBudgetSnapshot(budget).used, starts.length + reviewCalls);
    for (const n of [6, 7, 8, 11]) assert.equal(result.value[n - 1].status, "GATED");
    assert.equal(result.value[9].status, "FAILED");
    assert.equal(result.value.filter((r: { status: string }) => r.status === "DONE").length, 95);
    assert.deepEqual(result.value[7].blockedBy, ["issue-7"]);
    assert.ok(JSON.stringify(result.value).length < 50000, "return compact rows, not 100 full evidence reports");
    assert.ok(result.value[0].outputReference);
  } finally {
    clearTimeout(timer); releaseInitial.release(); releaseSlow.release();
    await graph?.catch(() => {});
    await rm(budget.directory, { recursive: true, force: true });
  }
});

test("native fanout rejects the default-64 eager batch and oversized panels atomically", { skip: !source }, async () => {
  const { runWorkflowScript, createRunFanoutBudget, claimRunFanoutBatch, getRunFanoutBudgetSnapshot } = await runtime();
  const budget = createRunFanoutBudget(`forge-small-${randomUUID()}`, 64);
  let launched = 0;
  try {
    const denied = await runWorkflowScript({
      script: `return await runs.all(${JSON.stringify(nodes.map(n => ({ key: n.key, agent: "worker", task: "fixture" })))});`,
      admit: (calls: Array<{ key: string }>) => claimRunFanoutBatch(budget, calls.map(c => c.key)),
      launch: async (key: string) => { launched++; return { key, ok: true, output: "unexpected" }; },
      status: async () => { throw new Error("unexpected status"); },
    });
    // runs.all preserves admission failures as results instead of rejecting.
    assert.equal(denied.value.length, 100);
    assert.ok(denied.value.every((r: { ok: boolean; output: string; error?: string }) =>
      r.ok === false && /fan-out limit/i.test(r.error ?? r.output)));
    assert.equal(launched, 0);
    assert.equal(getRunFanoutBudgetSnapshot(budget).used, 0);
    claimRunFanoutBatch(budget, Array.from({ length: 62 }, (_, i) => `used-${i}`));
    assert.throws(() => claimRunFanoutBatch({ ...budget, parentPath: "owner" }, ["a", "b", "c"]), /fan-out limit/i);
    assert.equal(getRunFanoutBudgetSnapshot(budget).used, 62);
    claimRunFanoutBatch(budget, ["last-a", "last-b"]);
    assert.equal(getRunFanoutBudgetSnapshot(budget).remaining, 0);
  } finally { await rm(budget.directory, { recursive: true, force: true }); }
});

test("denied recovery keeps its original references in compact DAG rows", { skip: !source }, async () => {
  const { runWorkflowScript, createRunFanoutBudget, claimRunFanoutBatch, getRunFanoutBudgetSnapshot } = await runtime();
  const budget = createRunFanoutBudget(`forge-recovery-budget-${randomUUID()}`, 1);
  let launches = 0;
  try {
    const result = await runWorkflowScript({
      script: await scriptFor([
        { key: "owner", predecessors: [], launch: { agent: "worker", task: "fixture" } },
        { key: "dependent", predecessors: ["owner"], launch: { agent: "worker", task: "fixture" } },
      ], 2),
      admit: (calls: Array<{ key: string }>) => claimRunFanoutBatch(budget, calls.map(c => c.key)),
      launch: async (key: string) => {
        launches++;
        return { key, ok: false, runId: "original-retained", output: "fixture failure",
          artifactPaths: ["/fixture/original-output.md"], outputReference: "/fixture/original-output.md",
          resumability: { state: "resumable" } };
      },
      status: async () => { throw new Error("unexpected status"); },
    });
    assert.equal(launches, 1);
    assert.equal(getRunFanoutBudgetSnapshot(budget).used, 1);
    assert.equal(result.value[0].runId, null);
    assert.equal(result.value[0].recoverySource.runId, "original-retained");
    assert.deepEqual(result.value[0].recoverySource.artifactPaths, ["/fixture/original-output.md"]);
    assert.match(result.value[0].error, /fan-out limit/i);
    assert.equal(result.value[1].status, "GATED");
  } finally { await rm(budget.directory, { recursive: true, force: true }); }
});

for (const invalid of [
  [{ key: "same", predecessors: [], launch: {} }, { key: "same", predecessors: [], launch: {} }],
  [{ key: "a", predecessors: ["unknown"], launch: {} }],
  [{ key: "a", predecessors: ["b"], launch: {} }, { key: "b", predecessors: ["a"], launch: {} }],
] satisfies NodeSpec[][]) {
  test(`invalid DAG rejected before any owner: ${JSON.stringify(invalid.map(n => n.predecessors))}`, { skip: !source }, async () => {
    const { runWorkflowScript } = await runtime();
    let launches = 0;
    await assert.rejects(runWorkflowScript({ script: await scriptFor(invalid, 4),
      launch: async (key: string) => { launches++; return { key, ok: true, output: marker(1) }; },
      status: async () => { throw new Error("unexpected status"); },
    }), /unique keys.*topological predecessors/);
    assert.equal(launches, 0);
  });
}
