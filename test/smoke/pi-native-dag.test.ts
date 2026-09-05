import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Opt-in host compatibility check; executes the installed workflow engine, not models.
// PI_SUBAGENTS_SOURCE=/path/to/pi-subagents node --import tsx --test test/smoke/pi-native-dag.test.ts
const source = process.env.PI_SUBAGENTS_SOURCE;
const done = "FORGE_WORK_ON_RESULT status=DONE issue=1 pr=2 dependency=SATISFIED";
const prelude = `const configuredModel="test/model";
const issueA={agent:"worker",task:"A"};
const issueB={agent:"worker",task:"B"};
const issueC={agent:"worker",task:"C"};\n`;

test("installed Pi executor retains failure metadata and releases C before B", { skip: !source }, async () => {
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

for (const scenario of ["gated", "decomposed", "unresumable", "detached", "stopped", "recovery-fails"] as const) {
  test(`installed Pi executor does not release C for ${scenario}`, { skip: !source }, async () => {
    const { runWorkflowScript } = await import(pathToFileURL(resolve(source!, "src/workflows/scripted-workflow.ts")).href);
    const spec = await readFile("specs/pi-adapter.md", "utf8");
    const snippet = spec.slice(spec.indexOf("Use one visible promise graph.")).match(/```js\n([\s\S]*?)\n```/)?.[1];
    assert.ok(snippet);
    const calls: string[] = [];
    const result = await runWorkflowScript({ script: prelude + snippet, timeoutMs: 10000,
      launch: async (key: string) => {
        calls.push(key);
        if (key === "work-on-B") return { key, ok: true, output: done };
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
