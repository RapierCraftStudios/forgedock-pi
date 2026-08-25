import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  boundedNodeAgent,
  SubagentsRpcClient,
} from "../../src/adapters/subagents.ts";
import { materializeForgeAgents } from "../../src/agents/materialize.ts";
import {
  FORGE_READ_ONLY_NODE_AGENT,
  FORGE_READ_ONLY_NODE_TOOLS,
  FORGE_REVIEW_TOOLS,
  FORGE_REFRESH_REVIEW_AGENT,
  FORGE_REFRESH_REVIEW_TOOLS,
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
    params: Record<string, unknown> & { task: string };
  };
  assert.equal(spawn.method, "spawn");
  assert.equal(spawn.params.agent, FORGE_WORK_ON_AGENT);
  assert.equal(spawn.params.async, true);
  assert.equal(spawn.params.workflowScript, undefined);
  const serialized = JSON.stringify(spawn.params);
  assert.match(serialized, /forge-review-correctness/);
  assert.match(serialized, /forge-review-security/);
  assert.match(spawn.params.task, /async:\s*false/);
  assert.match(spawn.params.task, /const results = await runs\.all/);
  assert.match(spawn.params.task, /return results/);
  assert.match(
    spawn.params.task,
    /do not continue until both results have returned/i,
  );
  assert.match(serialized, /forgedock\.pi\/1/);
  assert.match(serialized, /Reviewer remediation is pre-authorized/);
  assert.doesNotMatch(serialized, /gh auth token/);
});

test("RPC dedicated reviewer launch uses the registered reviewer and reviewer schema", async () => {
  const { pi, bus } = fakePi();
  const client = new SubagentsRpcClient(pi);
  await client.spawnReviewNode({
    runId: "run-review",
    issueNumber: 10,
    repository: "owner/repo",
    worktreeRoot: "/tmp/worktree",
    branch: "forge/10",
    baseBranch: "staging",
    baseSha: "abcdef1234567890",
    reviewHeadSha: "fedcba9876543210",
    leaseEpoch: 1,
    policy,
    issueContext: "untrusted issue text",
    node: { nodeId: "review-security-1", node: "review-security", attempt: 1 },
  });
  const spawn = bus.requests.at(-1) as {
    params: {
      agent: string;
      task: string;
      extensionBindings: Record<string, { nodeId: string; reviewHeadSha: string }>;
      outputSchema: { properties: { schema: { const: string } } };
    };
  };
  assert.equal(spawn.params.agent, "forge-review-security");
  assert.equal(spawn.params.outputSchema.properties.schema.const, "forgedock.reviewer-result/v1");
  assert.match(spawn.params.task, /Frozen review head SHA: fedcba9876543210/);
  assert.match(spawn.params.task, /Call forge_diff first/);
  assert.match(spawn.params.task, /pre-existing repository defects.*out of scope/i);
  assert.match(spawn.params.task, /forge_finalize_reviewer/);
  assert.equal(
    spawn.params.extensionBindings["forgedock.pi/1"]?.nodeId,
    "review-security-1",
  );
  assert.equal(
    spawn.params.extensionBindings["forgedock.pi/1"]?.reviewHeadSha,
    "fedcba9876543210",
  );
  assert.doesNotMatch(spawn.params.task, /runs\.all/);
});

test("RPC bounded node launch delegates one node without child checkpoints", async () => {
  const { pi, bus } = fakePi();
  const client = new SubagentsRpcClient(pi);
  await client.spawnNode({
    runId: "run-node",
    issueNumber: 9,
    repository: "owner/repo",
    worktreeRoot: "/tmp/worktree",
    branch: "forge/9",
    baseBranch: "staging",
    baseSha: "abcdef1234567890",
    leaseEpoch: 1,
    policy,
    issueContext: "untrusted issue text",
    node: { nodeId: "investigate-1", node: "investigate", attempt: 1 },
  });
  const spawn = bus.requests.at(-1) as {
    params: {
      agent: string;
      task: string;
      outputSchema: { properties: { schema: { const: string } } };
    };
  };
  assert.equal(spawn.params.agent, FORGE_READ_ONLY_NODE_AGENT);
  assert.equal(spawn.params.outputSchema.properties.schema.const, "forgedock.node-result/v1");
  assert.match(spawn.params.task, /Execute exactly one ForgeDock node: investigate/);
  assert.match(spawn.params.task, /do not call forge_checkpoint/i);
  assert.match(spawn.params.task, /forge_finalize_node/);
  assert.match(spawn.params.task, /read-only node/);
  assert.match(spawn.params.task, /Shell execution.*unavailable/);
  assert.doesNotMatch(spawn.params.task, /Process resolve, investigate, plan/i);
});

test("RPC bounded implementation remediation retains the guarded writer", async () => {
  const { pi, bus } = fakePi();
  const client = new SubagentsRpcClient(pi);
  await client.spawnNode({
    runId: "run-remediation",
    issueNumber: 9,
    repository: "owner/repo",
    worktreeRoot: "/tmp/worktree",
    branch: "forge/9",
    baseBranch: "staging",
    baseSha: "abcdef1234567890",
    leaseEpoch: 1,
    policy,
    issueContext: "untrusted issue text",
    node: { nodeId: "implement-2", node: "implement", attempt: 2 },
  });
  const spawn = bus.requests.at(-1) as {
    params: { agent: string; task: string };
  };
  assert.equal(spawn.params.agent, FORGE_WORK_ON_AGENT);
  assert.match(spawn.params.task, /Bash is available for implementation/);
  assert.match(spawn.params.task, /Use forge_commit/);
});

test("RPC work-on treats GitHub-only verification as valid", async () => {
  const { pi, bus } = fakePi();
  const client = new SubagentsRpcClient(pi);
  const githubOnlyPolicy = parseForgePolicy({
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
      github: { required: true, waitTimeoutMs: 60_000, pollIntervalMs: 1_000 },
      commands: {},
    },
    review: { required: ["correctness", "security"], maxRounds: 3 },
    subagents: { maxConcurrent: 2, maxDepth: 2 },
  });
  await client.spawnWorkOn({
    runId: "run-github-ci",
    issueNumber: 7,
    repository: "owner/repo",
    worktreeRoot: "/tmp/worktree",
    branch: "forge/7",
    baseBranch: "staging",
    baseSha: "abcdef1234567890",
    leaseEpoch: 1,
    policy: githubOnlyPolicy,
    issueContext: "Issue body",
  });
  const spawn = bus.requests.at(-1) as {
    params: { task: string; workflowScript?: string };
  };
  assert.equal(spawn.params.workflowScript, undefined);
  assert.match(
    spawn.params.task,
    /No local verification commands are configured\. This is valid/,
  );
  assert.match(spawn.params.task, /parent enforce GitHub-configured CI/);
});

test("materialized project agents preserve nested work-on hierarchy for async runners", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-agents-"));
  try {
    const paths = await materializeForgeAgents(root);
    assert.equal(paths.length, 5);
    const readOnlyNode = await readFile(
      join(root, ".pi", "agents", `${FORGE_READ_ONLY_NODE_AGENT}.md`),
      "utf8",
    );
    const workOn = await readFile(
      join(root, ".pi", "agents", "forge-work-on.md"),
      "utf8",
    );
    const reviewer = await readFile(
      join(root, ".pi", "agents", "forge-review-security.md"),
      "utf8",
    );
    const refresh = await readFile(
      join(root, ".pi", "agents", `${FORGE_REFRESH_REVIEW_AGENT}.md`),
      "utf8",
    );
    assert.match(readOnlyNode, /^acceptanceRole: read-only$/m);
    assert.match(readOnlyNode, /^completionGuard: false$/m);
    assert.doesNotMatch(
      readOnlyNode,
      /tools: .*\b(?:bash|edit|write|forge_commit|subagent)\b/,
    );
    assert.match(readOnlyNode, /forge_verify/);
    assert.match(readOnlyNode, /forge_diff/);
    assert.match(readOnlyNode, /forge_prepare_review/);
    assert.match(readOnlyNode, /forge_finalize_node/);
    assert.match(workOn, /^completionGuard: true$/m);
    assert.doesNotMatch(workOn, /tools: .*subagent/);
    assert.doesNotMatch(workOn, /forge_finalize_work_on/);
    assert.match(workOn, /forge_finalize_node/);
    assert.match(workOn, /^async: true$/m);
    assert.match(workOn, /maxSubagentDepth: 2/);
    assert.match(workOn, /^extensions:/m);
    assert.doesNotMatch(workOn, /subagentOnlyExtensions:/);
    assert.match(workOn, /  - \/.*pi-subagents\/index\.ts/);
    assert.match(workOn, /  - \/.*agents\/child-runtime\.ts/);
    assert.doesNotMatch(workOn, /  - "\/.*"/);
    assert.doesNotMatch(reviewer, /tools: .*subagent/);
    assert.match(reviewer, /forge_finalize_reviewer/);
    assert.match(reviewer, /^completionGuard: true$/m);
    assert.match(reviewer, /^extensions:/m);
    assert.match(reviewer, /^async: false$/m);
    assert.match(refresh, /tools: .*subagent/);
    assert.match(refresh, /forge_refresh_base/);
    assert.match(refresh, /^completionGuard: true$/m);
    assert.match(refresh, /maxSubagentDepth: 2/);
    const settings = JSON.parse(
      await readFile(join(root, ".pi", "settings.json"), "utf8"),
    ) as { retry: { enabled: boolean; maxRetries: number } };
    assert.equal(settings.retry.enabled, true);
    assert.equal(settings.retry.maxRetries, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RPC resume revives a transiently failed work-on session", async () => {
  const { pi, bus } = fakePi();
  const client = new SubagentsRpcClient(pi);
  const receipt = await client.resume(
    "failed-workflow",
    "Continue from durable checkpoints.",
  );
  assert.equal(receipt.runId, "async-run-1");
  const request = bus.requests.at(-1) as {
    method: string;
    params: { id: string; message: string };
  };
  assert.equal(request.method, "resume");
  assert.deepEqual(request.params, {
    id: "failed-workflow",
    message: "Continue from durable checkpoints.",
  });
});

test("runtime Forge hierarchy keeps bounded work-on least-authority", () => {
  for (const forbiddenTool of [
    "bash",
    "edit",
    "write",
    "forge_commit",
    "subagent",
  ]) {
    assert.equal(
      (FORGE_READ_ONLY_NODE_TOOLS as readonly string[]).includes(forbiddenTool),
      false,
    );
  }
  for (const trustedNodeTool of [
    "forge_verify",
    "forge_diff",
    "forge_prepare_review",
    "forge_finalize_node",
  ]) {
    assert.equal(
      (FORGE_READ_ONLY_NODE_TOOLS as readonly string[]).includes(
        trustedNodeTool,
      ),
      true,
    );
  }
  for (const node of [
    "resolve",
    "investigate",
    "plan",
    "prepare-worktree",
    "verify",
    "prepare-pr",
  ] as const) {
    assert.equal(boundedNodeAgent(node), FORGE_READ_ONLY_NODE_AGENT);
  }
  assert.equal(boundedNodeAgent("implement"), FORGE_WORK_ON_AGENT);
  assert.equal((FORGE_WORK_ON_TOOLS as readonly string[]).includes("bash"), true);
  assert.equal((FORGE_WORK_ON_TOOLS as readonly string[]).includes("subagent"), false);
  assert.equal((FORGE_WORK_ON_TOOLS as readonly string[]).includes("forge_finalize_work_on"), false);
  assert.equal((FORGE_WORK_ON_TOOLS as readonly string[]).includes("forge_checkpoint"), false);
  assert.equal(
    (FORGE_REVIEW_TOOLS as readonly string[]).includes("subagent"),
    false,
  );
  assert.equal(
    (FORGE_REFRESH_REVIEW_TOOLS as readonly string[]).includes("subagent"),
    true,
  );
  assert.equal(FORGE_WORK_ON_MAX_DEPTH, 2);

  const { pi } = fakePi();
  const registrations = registerForgeAgents(pi);
  assert.equal(registrations.length, 5);
  const registry = (
    globalThis as Record<PropertyKey, unknown>
  )[Symbol.for("pi-subagents.runtime-agents.v1")] as {
    byPi: WeakMap<
      ExtensionAPI,
      Array<{
        agent: {
          name: string;
          acceptanceRole?: string;
          completionGuard?: boolean;
        };
      }>
    >;
  };
  const runtimeAgents = registry.byPi.get(pi)?.map(({ agent }) => agent) ?? [];
  const readOnlyAgent = runtimeAgents.find(
    ({ name }) => name === FORGE_READ_ONLY_NODE_AGENT,
  );
  assert.equal(readOnlyAgent?.acceptanceRole, "read-only");
  assert.equal(readOnlyAgent?.completionGuard, false);
  assert.equal(
    runtimeAgents.find(({ name }) => name === FORGE_WORK_ON_AGENT)
      ?.completionGuard,
    true,
  );
  for (const agent of runtimeAgents.filter(
    ({ name }) =>
      name !== FORGE_READ_ONLY_NODE_AGENT && name !== FORGE_WORK_ON_AGENT,
  )) {
    assert.equal(agent.completionGuard, true);
  }
  for (const registration of registrations) registration.dispose();
});
