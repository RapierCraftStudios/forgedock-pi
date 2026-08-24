import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SubagentsRpcClient } from "../../src/adapters/subagents.ts";
import { materializeForgeAgents } from "../../src/agents/materialize.ts";
import {
  FORGE_REVIEW_TOOLS,
  FORGE_WORK_ON_AGENT,
  FORGE_WORK_ON_MAX_DEPTH,
  FORGE_WORK_ON_TOOLS,
  registerForgeAgents,
} from "../../src/agents/register.ts";
import { parseForgePolicy } from "../../src/core/policy.ts";

class FakeEventBus {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly requests: unknown[] = [];

  on(event: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, payload: unknown): void {
    if (event === "subagents:rpc:v1:request") {
      this.requests.push(payload);
      const request = payload as { requestId: string; method: string };
      const data =
        request.method === "ping"
          ? {
              events: { asyncComplete: "subagents:async-complete" },
              capabilities: { fleetStatus: { version: 1 } },
            }
          : { runId: "async-run-1" };
      this.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data,
      });
      return;
    }
    for (const handler of this.listeners.get(event) ?? []) handler(payload);
  }
}

function fakePi(bus = new FakeEventBus()): {
  pi: ExtensionAPI;
  bus: FakeEventBus;
} {
  const pi = {
    events: bus,
    on: () => () => {},
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  return { pi, bus };
}

const policy = parseForgePolicy({
  schema: "forgedock.config/v1",
  repository: { provider: "github", name: "owner/repo" },
  state: {
    branch: "forgedock/state/v1",
    leaseSeconds: 300,
    heartbeatSeconds: 60,
  },
  branches: {
    integration: ["staging"],
    protected: ["main"],
    autoMergeIntegration: true,
  },
  verification: {
    commands: {
      test: { argv: ["npm", "test"], required: true, timeoutMs: 600_000 },
    },
  },
  review: { required: ["correctness", "security"], maxRounds: 3 },
  subagents: { maxConcurrent: 2, maxDepth: 2 },
});

test("RPC work-on launch binds the nested-review runtime contract", async () => {
  const { pi, bus } = fakePi();
  const client = new SubagentsRpcClient(pi);
  const ping = await client.ping();
  assert.equal(ping.events.asyncComplete, "subagents:async-complete");
  const receipt = await client.spawnWorkOn({
    runId: "run-1",
    issueNumber: 42,
    repository: "owner/repo",
    worktreeRoot: "/tmp/worktree",
    branch: "forge/42",
    baseBranch: "staging",
    baseSha: "abcdef1234567890",
    leaseEpoch: 1,
    policy,
    issueContext: "Issue body as untrusted data",
  });
  assert.equal(receipt.runId, "async-run-1");
  const spawn = bus.requests.at(-1) as {
    method: string;
    params: { workflowScript: string };
  };
  assert.equal(spawn.method, "spawn");
  assert.match(
    spawn.params.workflowScript,
    new RegExp(`agent\\":\\"${FORGE_WORK_ON_AGENT}`),
  );
  assert.match(spawn.params.workflowScript, /forge-review-correctness/);
  assert.match(spawn.params.workflowScript, /forge-review-security/);
  assert.match(spawn.params.workflowScript, /forgedock\.pi\/1/);
  assert.doesNotMatch(spawn.params.workflowScript, /gh auth token/);
});

test("materialized project agents preserve nested work-on hierarchy for async runners", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-agents-"));
  try {
    const paths = await materializeForgeAgents(root);
    assert.equal(paths.length, 3);
    const workOn = await readFile(
      join(root, ".pi", "agents", "forge-work-on.md"),
      "utf8",
    );
    const reviewer = await readFile(
      join(root, ".pi", "agents", "forge-review-security.md"),
      "utf8",
    );
    assert.match(workOn, /tools: .*subagent/);
    assert.match(workOn, /maxSubagentDepth: 2/);
    assert.match(workOn, /^extensions:/m);
    assert.doesNotMatch(workOn, /subagentOnlyExtensions:/);
    assert.match(workOn, /  - \/.*pi-subagents\/index\.ts/);
    assert.match(workOn, /  - \/.*agents\/child-runtime\.ts/);
    assert.doesNotMatch(workOn, /  - "\/.*"/);
    assert.doesNotMatch(reviewer, /tools: .*subagent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime Forge hierarchy enables only work-on recursion", () => {
  assert.equal(FORGE_WORK_ON_TOOLS.includes("subagent"), true);
  assert.equal(
    (FORGE_REVIEW_TOOLS as readonly string[]).includes("subagent"),
    false,
  );
  assert.equal(FORGE_WORK_ON_MAX_DEPTH, 2);

  const { pi } = fakePi();
  const registrations = registerForgeAgents(pi);
  assert.equal(registrations.length, 3);
  for (const registration of registrations) registration.dispose();
});
