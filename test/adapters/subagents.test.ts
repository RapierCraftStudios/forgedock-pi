import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return result.stdout;
}

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
  assert.match(spawn.params.workflowScript, /cwd/);
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

test("materialized runtime agents stay out of commits without repository ignore rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-agent-commit-"));
  try {
    await gitOutput(root, "init", "-b", "main");
    await gitOutput(root, "config", "user.name", "ForgeDock Test");
    await gitOutput(root, "config", "user.email", "forgedock@example.invalid");
    await writeFile(join(root, "implementation.txt"), "base\n");
    await gitOutput(root, "add", "implementation.txt");
    await gitOutput(root, "commit", "-m", "base");

    await materializeForgeAgents(root);
    await writeFile(join(root, "implementation.txt"), "implementation\n");

    const exclude = await readFile(
      join(root, ".git", "info", "exclude"),
      "utf8",
    );
    assert.equal(exclude.includes("/.pi/agents/"), true);
    const status = await gitOutput(
      root,
      "status",
      "--porcelain",
      "--untracked-files=all",
    );
    assert.equal(status.includes(".pi/agents"), false);

    await gitOutput(root, "add", "-A");
    assert.equal(
      (await gitOutput(root, "diff", "--cached", "--name-only")).trim(),
      "implementation.txt",
    );
    await gitOutput(root, "commit", "-m", "implementation");

    const committedFiles = await gitOutput(
      root,
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
    );
    assert.equal(committedFiles.includes(".pi/agents/"), false);
    assert.equal(committedFiles.includes(".pi/forge/"), false);
    const patch = await gitOutput(root, "show", "--format=", "HEAD");
    assert.equal(patch.includes("pi-subagents"), false);
    assert.equal(patch.includes("child-runtime.ts"), false);
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
