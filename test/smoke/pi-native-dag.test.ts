import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Executes the installed workflow engine with model-free launch seams; override only to
// qualify another pinned checkout.
const source = process.env.PI_SUBAGENTS_SOURCE ?? resolve("node_modules/pi-subagents");
const done = "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=2 dependency=SATISFIED";
const prelude = `const configuredModel="test/model";
const issueA={agent:"worker",task:"A"};
const issueB={agent:"worker",task:"B"};
const issueC={agent:"worker",task:"C"};
const ownerConcurrency=2;
const issueGraph=[
 {key:"work-on-A",predecessors:[],launch:issueA},
 {key:"work-on-B",predecessors:[],launch:issueB},
 {key:"work-on-C",predecessors:["work-on-A"],launch:issueC}
];\n`;

test("installed Pi executor retains failure metadata and releases C before B", async () => {
  const { runWorkflowScript } = await import(pathToFileURL(resolve(source!, "src/workflows/scripted-workflow.ts")).href);
  const spec = await readFile("specs/pi-adapter.md", "utf8");
  const snippet = spec.slice(spec.indexOf("Use one visible promise graph.")).match(/```js\n([\s\S]*?)\n```/)?.[1];
  assert.ok(snippet);
  const calls: Array<{ key: string; params: Record<string, unknown> }> = [];
  let finishB!: () => void;
  const pendingB = new Promise<void>((resolve) => { finishB = resolve; });
  let startedC!: () => void;
  const pendingC = new Promise<void>((resolve) => { startedC = resolve; });
  const graph = runWorkflowScript({ script: prelude + snippet, timeoutMs: 10000,
    launch: async (key: string, params: Record<string, unknown>) => {
      calls.push({ key, params });
      if (key === "work-on-A") return { key, ok: false, agent: "worker", runId: "retained-A", output: "interrupted", resumability: { state: "resumable" } };
      if (key === "work-on-B") await pendingB;
      if (key === "work-on-C") startedC();
      return { key, ok: true, agent: "worker", runId: key, output: done };
    },
    status: async () => { throw new Error("no status polling expected"); },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pendingC, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("C did not start before B")), 3000); })]);
    assert.deepEqual(calls.map(c => c.key), ["work-on-A", "work-on-B", "work-on-A-recovery", "work-on-C"]);
    for (const { params } of calls) {
      if (params.resume) { assert.equal(params.resume, "retained-A"); assert.equal(params.agent, undefined); }
      else assert.equal(params.model, "test/model");
    }
  } finally {
    clearTimeout(timer);
    finishB();
    await graph;
  }
});

test("installed panel deadline preserves completed roles before one-role recovery", { timeout: 10000 }, async () => {
  const { runWorkflowScript } = await import(pathToFileURL(resolve(source, "src/workflows/scripted-workflow.ts")).href);
  const calls: string[] = [];
  let stalledSettled = false;
  const panel = runWorkflowScript({
    script: `return await runs.all([
      { key: "correctness", agent: "reviewer", task: "complete" },
      { key: "security", agent: "reviewer", task: "complete" },
      { key: "stalled", agent: "reviewer", task: "stall", timeoutMs: 1000 }
    ]);`,
    globalConcurrencyLimit: 3,
    timeoutMs: 1000,
    launch: async (key: string, _params: Record<string, unknown>, signal: AbortSignal) => {
      calls.push(key);
      if (key !== "stalled") return { key, ok: true, runId: `${key}-run`, output: `${key} report`, artifactPaths: [] };
      return await new Promise((resolve) => signal.addEventListener("abort", () => {
        stalledSettled = true;
        resolve({ key, ok: false, runId: "stalled-run", output: "panel deadline", error: "panel deadline", timedOut: true, artifactPaths: [] });
      }, { once: true }));
    },
    status: async () => { throw new Error("status polling is not part of joined panel recovery"); },
  });
  await assert.rejects(panel, (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const workflowError = error as Error & { partial?: { children: Array<{ key: string }> } };
    if (!workflowError.partial) return false;
    assert.match(workflowError.message, /Workflow script timed out after 1000ms/);
    assert.deepEqual(workflowError.partial.children.map((child) => child.key), ["correctness", "security"]);
    return true;
  });
  assert.equal(stalledSettled, true, "the stalled role must observe panel cancellation before replacement");

  let recoveryCalls = 0;
  const recovered = await runWorkflowScript({
    script: `return await runs.all([{ key: "stalled-recovery", agent: "reviewer", task: "recover saved report" }]);`,
    timeoutMs: 1000,
    launch: async (key: string) => {
      recoveryCalls++;
      return { key, ok: true, runId: "stalled-recovery-run", output: "saved report reconciled", artifactPaths: [] };
    },
    status: async () => { throw new Error("status polling is not part of joined panel recovery"); },
  });
  assert.equal(recoveryCalls, 1);
  assert.equal(calls.filter((key) => key !== "stalled").length, 2, "completed roles are not rerun");
  assert.equal((recovered.value as any[])[0].key, "stalled-recovery");
});

for (const scenario of ["gated", "decomposed", "unresumable", "detached", "stopped", "recovery-fails", "ambiguous-result", "missing-result"] as const) {
  test(`installed Pi executor does not release C for ${scenario}`, async () => {
    const { runWorkflowScript } = await import(pathToFileURL(resolve(source!, "src/workflows/scripted-workflow.ts")).href);
    const spec = await readFile("specs/pi-adapter.md", "utf8");
    const snippet = spec.slice(spec.indexOf("Use one visible promise graph.")).match(/```js\n([\s\S]*?)\n```/)?.[1];
    assert.ok(snippet);
    const calls: string[] = [];
    const result = await runWorkflowScript({ script: prelude + snippet, timeoutMs: 10000,
      launch: async (key: string) => {
        calls.push(key);
        if (key === "work-on-B") return { key, ok: true, output: done };
        if (scenario === "ambiguous-result") return { key, ok: true, output: `${done}\n${done}` };
        if (scenario === "missing-result") return { key, ok: true, output: "No lifecycle result" };
        if (scenario === "gated" || scenario === "decomposed") return { key, ok: true, output: `FORGE_WORK_ON_RESULT status=${scenario === "gated" ? "GATED" : "DONE"} issue=1 pr=none dependency=UNSATISFIED` };
        return { key, ok: false, output: "interrupted", runId: "retained-A", detached: scenario === "detached", stopped: scenario === "stopped", resumability: { state: scenario === "unresumable" ? "not-resumable" : "resumable" } };
      },
      status: async () => { throw new Error("no status polling expected"); },
    });
    assert.equal(calls.includes("work-on-C"), false);
    assert.equal(calls.filter(k => k.includes("recovery")).length, scenario === "recovery-fails" ? 1 : 0);
    assert.equal(result.value[2].status, "GATED");
  });
}
