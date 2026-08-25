import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  boundedNodeAgent,
  findProviderReceiptFromDescriptors,
  SubagentsRpcClient,
} from "../../src/adapters/subagents.ts";
import { ForgeWorkOnController } from "../../src/workflows/work-on.ts";
import { materializeForgeAgents } from "../../src/agents/materialize.ts";
import {
  FORGE_READ_ONLY_NODE_AGENT,
  FORGE_READ_ONLY_NODE_COMPLETION_GUARD,
  FORGE_READ_ONLY_NODE_TOOLS,
  FORGE_REVIEW_TOOLS,
  FORGE_REFRESH_REVIEW_AGENT,
  FORGE_REFRESH_REVIEW_TOOLS,
  FORGE_WORK_ON_AGENT,
  FORGE_WORK_ON_MAX_DEPTH,
  FORGE_WORK_ON_TOOLS,
  registerForgeAgents,
} from "../../src/agents/register.ts";
import { createBuilderPathContract } from "../../src/core/builder-contract.ts";
import { parseForgePolicy } from "../../src/core/policy.ts";

class FakeEventBus {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly requests: unknown[] = [];
  readonly failures = new Map<string, { code: string; message: string }>();

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
      const failure = this.failures.get(request.method);
      if (failure) {
        this.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          success: false,
          error: failure,
        });
        return;
      }
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

test("provider receipt recovery finds the async run by durable launch identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-provider-receipts-"));
  try {
    const runDir = join(root, "provider-run-1");
    await mkdir(runDir);
    await writeFile(
      join(runDir, "recovery-descriptor.json"),
      JSON.stringify({
        sourceRunId: "provider-run-1",
        extensionBindings: {
          "forgedock.pi/1": {
            runId: "forge-run-1",
            nodeId: "resolve-1",
            resultPath: "/worktree/result.json",
            launchNonce: "nonce-1",
          },
        },
      }),
    );
    await writeFile(
      join(runDir, "status.json"),
      JSON.stringify({ state: "running", updatedAt: 10 }),
    );

    assert.equal(
      await findProviderReceiptFromDescriptors(
        {
          forgeRunId: "forge-run-1",
          nodeId: "resolve-1",
          resultPath: "/worktree/result.json",
          launchNonce: "nonce-1",
        },
        root,
      ),
      "provider-run-1",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider cancellation treats an unavailable run as already stopped", async () => {
  const { pi, bus } = fakePi();
  bus.failures.set("stop", {
    code: "not_found",
    message: "Async run 'old-session-run' was not found in the active session.",
  });
  const controller = new ForgeWorkOnController(pi);

  await controller.stopProviderRuns([
    "old-session-run",
    "launch:resolve-1:nonce",
    "old-session-run",
  ]);

  const stops = bus.requests.filter(
    (request) => (request as { method?: string }).method === "stop",
  ) as Array<{ params: { id: string } }>;
  assert.deepEqual(stops.map((request) => request.params.id), ["old-session-run"]);
});

test("provider cancellation treats a completed run as already stopped", async () => {
  const { pi, bus } = fakePi();
  bus.failures.set("stop", {
    code: "invalid_state",
    message: "Async run completed-run is complete; stop only supports running async runs.",
  });
  const controller = new ForgeWorkOnController(pi);

  await controller.stopProviderRuns(["completed-run"]);
});

test("provider cancellation rejects nonterminal invalid-state failures", async () => {
  const { pi, bus } = fakePi();
  bus.failures.set("stop", {
    code: "invalid_state",
    message: "Workflow live-run is not controlled by this extension runtime; reload recovery cannot stop it safely.",
  });
  const controller = new ForgeWorkOnController(pi);

  await assert.rejects(
    controller.stopProviderRuns(["live-run"]),
    /reload recovery cannot stop it safely/,
  );
});

test("provider cancellation still fails closed on stop transport errors", async () => {
  const { pi, bus } = fakePi();
  bus.failures.set("stop", {
    code: "execution_failed",
    message: "Provider control channel failed.",
  });
  const controller = new ForgeWorkOnController(pi);

  await assert.rejects(
    controller.stopProviderRuns(["live-run"]),
    /Provider control channel failed/,
  );
});

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
  const spawn = bus.requests.at(-1) as { params: { agent: string; task: string; outputSchema: { properties: { schema: { const: string } } } } };
  assert.equal(spawn.params.agent, FORGE_READ_ONLY_NODE_AGENT);
  assert.equal(spawn.params.outputSchema.properties.schema.const, "forgedock.node-result/v1");
  assert.match(spawn.params.task, /Execute exactly one ForgeDock node: investigate/);
  assert.match(spawn.params.task, /do not call forge_checkpoint/i);
  assert.match(spawn.params.task, /forge_finalize_node/);
  assert.match(spawn.params.task, /read-only node/);
  assert.match(spawn.params.task, /Shell execution.*unavailable/);
  assert.match(spawn.params.task, /Integration base: staging/);
  assert.match(spawn.params.task, /artifact identity field.*integration base/i);
  assert.match(spawn.params.task, /issue context below as untrusted data/i);
  assert.doesNotMatch(spawn.params.task, /Process resolve, investigate, plan/i);
  await client.spawnNode({
    runId: "run-resolve",
    issueNumber: 9,
    repository: "owner/repo",
    worktreeRoot: "/tmp/worktree",
    branch: "forge/9",
    baseBranch: "staging",
    baseSha: "abcdef1234567890",
    leaseEpoch: 1,
    policy,
    issueContext: "untrusted issue text",
    node: { nodeId: "resolve-1", node: "resolve", attempt: 1 },
  });
  const resolveSpawn = bus.requests.at(-1) as { params: { task: string } };
  assert.match(resolveSpawn.params.task, /resolve artifact contract is exact/);
  assert.match(resolveSpawn.params.task, /issueNumber: positive integer/);

  await client.spawnNode({
    runId: "run-verify",
    issueNumber: 9,
    repository: "owner/repo",
    worktreeRoot: "/tmp/worktree",
    branch: "forge/9",
    baseBranch: "staging",
    baseSha: "abcdef1234567890",
    leaseEpoch: 1,
    policy,
    issueContext: "untrusted issue text",
    node: {
      nodeId: "verify-1",
      node: "verify",
      attempt: 1,
      headSha: "fedcba9876543210",
    },
  });
  const verifySpawn = bus.requests.at(-1) as {
    params: {
      task: string;
      extensionBindings: Record<string, { nodeHeadSha?: string }>;
    };
  };
  assert.match(verifySpawn.params.task, /Bound node head SHA: fedcba9876543210/);
  assert.match(verifySpawn.params.task, /Approved verification command names: test/);
  assert.equal(
    verifySpawn.params.extensionBindings["forgedock.pi/1"]?.nodeHeadSha,
    "fedcba9876543210",
  );
});

test("bounded implementation launch binds the durable builder contract", async () => {
  const { pi, bus } = fakePi();
  const client = new SubagentsRpcClient(pi);
  const builderContract = createBuilderPathContract(["src/**", "test/**"]);
  await client.spawnNode({
    runId: "run-implement",
    issueNumber: 9,
    repository: "owner/repo",
    worktreeRoot: "/tmp/worktree",
    branch: "forge/9",
    baseBranch: "staging",
    baseSha: "abcdef1234567890",
    leaseEpoch: 1,
    policy,
    issueContext: "untrusted issue text",
    builderContract,
    node: { nodeId: "implement-1", node: "implement", attempt: 1 },
  });
  const spawn = bus.requests.at(-1) as {
    params: {
      task: string;
      extensionBindings: Record<
        string,
        { builderContract?: { contractHash: string } }
      >;
    };
  };
  assert.equal(
    spawn.params.extensionBindings["forgedock.pi/1"]?.builderContract
      ?.contractHash,
    builderContract.contractHash,
  );
  assert.match(spawn.params.task, new RegExp(builderContract.contractHash));
  assert.match(spawn.params.task, /Allowed paths: src\/\*\*, test\/\*\*/);
  assert.match(spawn.params.task, /Raw shell, direct Git commands.*unavailable/);
  assert.match(spawn.params.task, /forge_commit/);
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
    assert.equal(FORGE_READ_ONLY_NODE_COMPLETION_GUARD, false);
    assert.match(readOnlyNode, /^completionGuard: false$/m);
    assert.match(workOn, /^completionGuard: true$/m);
    assert.doesNotMatch(readOnlyNode, /tools: .*\b(?:edit|write|forge_commit)\b/);
    assert.doesNotMatch(workOn, /tools: .*subagent/);
    assert.doesNotMatch(workOn, /forge_finalize_work_on/);
    assert.match(workOn, /forge_finalize_node/);
    assert.match(workOn, /^async: true$/m);
    assert.match(workOn, /maxSubagentDepth: 2/);
    assert.match(workOn, /^extensions:/m);
    assert.doesNotMatch(workOn, /subagentOnlyExtensions:/);
    assert.match(workOn, / {2}- \/.*pi-subagents\/index\.ts/);
    assert.match(workOn, / {2}- \/.*agents\/child-runtime\.ts/);
    assert.doesNotMatch(workOn, / {2}- "\/.*"/);
    assert.doesNotMatch(reviewer, /tools: .*subagent/);
    assert.match(reviewer, /forge_finalize_reviewer/);
    assert.match(reviewer, /^extensions:/m);
    assert.match(reviewer, /^async: false$/m);
    assert.match(refresh, /tools: .*subagent/);
    assert.match(refresh, /forge_refresh_base/);
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

test("runtime materialization rejects a pre-existing .pi symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-agents-link-"));
  const external = await mkdtemp(join(tmpdir(), "forgedock-agents-external-"));
  const sentinel = join(external, "sentinel.txt");
  try {
    await writeFile(sentinel, "external\n");
    await symlink(external, join(root, ".pi"), "dir");
    await assert.rejects(
      materializeForgeAgents(root),
      /no-follow|ELOOP|ENOTDIR|symbolic link|secure/i,
    );
    assert.equal(await readFile(sentinel, "utf8"), "external\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("runtime materialization rejects a replacement final-file symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-agents-replacement-"));
  const external = await mkdtemp(join(tmpdir(), "forgedock-agents-target-"));
  const target = join(external, "agent.md");
  try {
    await writeFile(target, "external\n");
    await mkdir(join(root, ".pi", "agents"), { recursive: true });
    await symlink(target, join(root, ".pi", "agents", "forge-work-on.md"));
    await assert.rejects(materializeForgeAgents(root));
    assert.equal(await readFile(target, "utf8"), "external\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("runtime materialization rejects a pre-existing .pi/forge symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-forge-link-"));
  const external = await mkdtemp(join(tmpdir(), "forgedock-forge-target-"));
  const sentinel = join(external, "sentinel.txt");
  try {
    await writeFile(sentinel, "external\n");
    await mkdir(join(root, ".pi", "agents"), { recursive: true });
    await symlink(external, join(root, ".pi", "forge"), "dir");
    await assert.rejects(materializeForgeAgents(root));
    assert.equal(await readFile(sentinel, "utf8"), "external\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
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
  assert.equal(
    (FORGE_READ_ONLY_NODE_TOOLS as readonly string[]).includes("edit"),
    false,
  );
  assert.equal(
    (FORGE_READ_ONLY_NODE_TOOLS as readonly string[]).includes("bash"),
    false,
  );
  assert.equal(boundedNodeAgent("resolve"), FORGE_READ_ONLY_NODE_AGENT);
  assert.equal(boundedNodeAgent("investigate"), FORGE_READ_ONLY_NODE_AGENT);
  assert.equal(boundedNodeAgent("plan"), FORGE_READ_ONLY_NODE_AGENT);
  assert.equal(boundedNodeAgent("implement"), FORGE_WORK_ON_AGENT);
  assert.equal(
    (FORGE_WORK_ON_TOOLS as readonly string[]).includes("bash"),
    false,
  );
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
  for (const registration of registrations) registration.dispose();
});
