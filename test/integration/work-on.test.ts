import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  type GitHubRequest,
  type GitHubResponse,
  type GitHubTransport,
} from "../../src/adapters/github-api.ts";
import { GitHubWorkflowAdapter } from "../../src/adapters/github-workflow.ts";
import forgeChildRuntime, {
  validatePhaseReport,
  type ForgeChildRuntimeDependencies,
} from "../../src/agents/child-runtime.ts";
import type { ForgeWorkOnResult } from "../../src/agents/contracts.ts";
import type { PreparedWorktree } from "../../src/adapters/git.ts";
import { RunJournal } from "../../src/workflows/journal.ts";
import {
  ForgeWorkOnController,
  type ForgeGitPort,
  type ForgeJournalPort,
  type ForgeRpcPort,
  type ForgeStateStorePort,
} from "../../src/workflows/work-on.ts";
import type {
  ReadRunStateResult,
} from "../../src/adapters/github-state.ts";
import type { RunEvent } from "../../src/core/events.ts";
import type { RepositoryLease } from "../../src/core/lease.ts";
import type { RunState } from "../../src/core/state.ts";
import { parseForgePolicy, type ForgePolicy } from "../../src/core/policy.ts";

const repository = "owner/repo";
const issueNumber = 3;
const baseSha = "base-sha-0000000000000000000000000000000000000000";
const headSha = "head-sha-1111111111111111111111111111111111111111";
const mergeSha = "merge-sha-2222222222222222222222222222222222222222";
const issueMarkers = [
  "<!-- FORGE:INVESTIGATOR -->",
  "<!-- INVESTIGATION:COMPLETE -->",
  "<!-- FORGE:FAST_PATH -->",
  "<!-- FORGE:CONTRACT -->",
  "<!-- FORGE:CONTEXT -->",
  "<!-- FORGE:CONTEXT:COMPLETE -->",
  "<!-- FORGE:ARCHITECT -->",
  "<!-- FORGE:ARCHITECT:COMPLETE -->",
  "<!-- FORGE:BUILDER -->",
  "<!-- FORGE:BUILDER:COMPLETE -->",
  "<!-- FORGE:ACCEPTANCE_GATE -->",
  "<!-- FORGE:ACCEPTANCE_GATE:PASSED -->",
  "<!-- FORGE:REVIEW_STARTED -->",
] as const;

interface FakePull {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  mergeability: "mergeable" | "conflicting" | "unknown";
}

interface FakeComment {
  id: number;
  body: string;
}

class FakeGitHubTransport implements GitHubTransport {
  readonly requests: GitHubRequest[] = [];
  readonly issueComments: FakeComment[] = [];
  readonly pullComments: FakeComment[] = [];
  readonly labels = new Set<string>();
  readonly issue = {
    number: issueNumber,
    title: "Add end-to-end tests for work-on finalization and recovery",
    body: "Deterministic integration fixture",
    state: "open" as "open" | "closed",
  };
  pull: FakePull | undefined;
  mergeRequests = 0;
  issueCloseRequests = 0;
  pullCreateRequests = 0;
  artifactPosts = 0;
  failArtifactOnce = false;
  failPullCreateAfterEffectOnce = false;
  failMergeAfterEffectOnce = false;
  failIssueCloseAfterEffectOnce = false;

  constructor(options: { existingPull?: boolean; missingIssueMarker?: string } = {}) {
    for (const marker of issueMarkers) {
      if (marker !== options.missingIssueMarker)
        this.issueComments.push({ id: this.issueComments.length + 1, body: marker });
    }
    this.issueComments.push({
      id: this.issueComments.length + 1,
      body: "<!-- FORGE:REVIEW_STARTED -->",
    });
    if (options.existingPull ?? true) this.createExistingPull();
  }

  async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
    this.requests.push(request);
    const root = "/repos/owner/repo";
    const issuePath = `${root}/issues/${issueNumber}`;
    const pullPath = `${root}/pulls/7`;

    if (request.method === "GET" && request.path === issuePath)
      return this.response(200, this.issueResponse());
    if (request.method === "PATCH" && request.path === issuePath) {
      this.issue.state = "closed";
      this.issueCloseRequests += 1;
      if (this.failIssueCloseAfterEffectOnce) {
        this.failIssueCloseAfterEffectOnce = false;
        throw new Error("synthetic issue-close response loss");
      }
      return this.response(200, this.issueResponse());
    }
    if (request.method === "GET" && request.path === `${issuePath}/comments?per_page=100`)
      return this.response(200, this.issueComments);
    if (request.method === "POST" && request.path === `${issuePath}/comments`)
      return this.postComment(this.issueComments, request) as GitHubResponse<T>;
    if (request.method === "GET" && request.path === `${issuePath}/labels`)
      return this.response(200, this.labelsAsObjects());
    if (request.method === "PUT" && request.path === `${issuePath}/labels`) {
      this.labels.clear();
      for (const label of (request.body as { labels: string[] }).labels)
        this.labels.add(label);
      return this.response(200, this.labelsAsObjects());
    }

    if (request.method === "GET" && request.path.startsWith(`${root}/pulls?`))
      return this.response(200, this.pull ? [this.pullResponse()] : []);
    if (request.method === "POST" && request.path === `${root}/pulls`) {
      this.pullCreateRequests += 1;
      this.createExistingPull();
      if (this.failPullCreateAfterEffectOnce) {
        this.failPullCreateAfterEffectOnce = false;
        throw new Error("synthetic pull-request response loss");
      }
      return this.response(201, this.pullResponse());
    }
    if (request.method === "GET" && request.path === pullPath)
      return this.response(200, this.pullResponse());
    if (request.method === "PUT" && request.path === `${pullPath}/merge`) {
      this.mergeRequests += 1;
      this.pull = {
        ...(this.pull ?? this.newPull()),
        state: "closed",
        merged: true,
      };
      if (this.failMergeAfterEffectOnce) {
        this.failMergeAfterEffectOnce = false;
        throw new Error("synthetic merge response loss");
      }
      return this.response(200, {
        merged: true,
        sha: mergeSha,
        message: "Pull request merged",
      });
    }
    if (request.method === "GET" && request.path === `${pullPath}/comments?per_page=100`)
      return this.response(200, this.pullComments);
    if (request.method === "POST" && request.path === `${pullPath}/comments`)
      return this.postComment(this.pullComments, request, true) as GitHubResponse<T>;

    throw new Error(`Unexpected fake GitHub request ${request.method} ${request.path}`);
  }

  count(method: GitHubRequest["method"], suffix: string): number {
    return this.requests.filter(
      (request) => request.method === method && request.path.endsWith(suffix),
    ).length;
  }

  private postComment(
    target: FakeComment[],
    request: GitHubRequest,
    pull = false,
  ): GitHubResponse<unknown> {
    const body = (request.body as { body: string }).body;
    if (pull && this.failArtifactOnce) {
      this.failArtifactOnce = false;
      throw new Error("synthetic audit publication interruption");
    }
    const comment = { id: target.length + 1, body };
    target.push(comment);
    if (pull) this.artifactPosts += 1;
    return this.response(201, comment);
  }

  private createExistingPull(): void {
    this.pull = this.newPull();
    this.pullComments.length = 0;
    this.pullComments.push({
      id: 1,
      body: "<!-- FORGE:REVIEW_ROUTE mode=single-pr sha=head-sha -->",
    });
  }

  private newPull(): FakePull {
    return {
      number: 7,
      state: "open",
      merged: false,
      headSha,
      baseSha,
      headRef: "forge/issue-3-run",
      baseRef: "staging",
      mergeability: "mergeable",
    };
  }

  private issueResponse(): unknown {
    return {
      ...this.issue,
      labels: this.labelsAsObjects(),
    };
  }

  private pullResponse(): unknown {
    const pull = this.pull ?? this.newPull();
    return {
      number: pull.number,
      html_url: "https://github.test/owner/repo/pull/7",
      state: pull.state,
      merged: pull.merged,
      head: { sha: pull.headSha, ref: pull.headRef },
      base: { sha: pull.baseSha, ref: pull.baseRef },
      mergeable:
        pull.mergeability === "mergeable"
          ? true
          : pull.mergeability === "conflicting"
            ? false
            : null,
    };
  }

  private labelsAsObjects(): Array<{ name: string }> {
    return [...this.labels].map((name) => ({ name }));
  }

  private response<T>(status: number, data: unknown): GitHubResponse<T> {
    return { status, data: data as T, headers: {} };
  }
}

class MemoryStateStore implements ForgeStateStorePort {
  tip = "state-tip-0";
  events: RunEvent[] = [];
  state: RunState | undefined;
  lease: RepositoryLease | undefined;
  leaseOverride: RepositoryLease | undefined;
  commits = 0;

  async ensureBranch(): Promise<string> {
    return this.tip;
  }

  async readRun(_runId: string): Promise<ReadRunStateResult> {
    return {
      tip: this.tip,
      events: this.events,
      snapshotMatchesJournal: true,
      ...(this.state ? { state: this.state } : {}),
      ...((this.leaseOverride ?? this.lease)
        ? { lease: this.leaseOverride ?? this.lease }
        : {}),
    };
  }

  async commitRunState(
    input: Parameters<ForgeStateStorePort["commitRunState"]>[0],
  ): Promise<string> {
    if (input.expectedTip !== this.tip)
      throw new Error(`state CAS mismatch: expected ${input.expectedTip}`);
    this.events = [...input.events];
    this.state = input.state;
    this.lease = input.lease;
    this.commits += 1;
    this.tip = `state-tip-${this.commits}`;
    return this.tip;
  }
}

class FakeGit implements ForgeGitPort {
  readonly calls: string[] = [];
  readonly failures = new Set<string>();
  headSha = headSha;
  changed = ["test/integration/work-on.test.ts"];

  async resolveRepositoryRoot(): Promise<string> {
    return "/fake/repository";
  }

  async prepare(
    repositoryRoot: string,
    input: { runId: string; issueNumber: number; baseBranch: string },
  ): Promise<PreparedWorktree> {
    return {
      repositoryRoot,
      worktreePath: `/fake/worktrees/${input.runId}`,
      branch: `forge/issue-${input.issueNumber}-${input.runId.slice(0, 8)}`,
      baseBranch: input.baseBranch,
      baseSha,
    };
  }

  async head(): Promise<string> {
    return this.headSha;
  }

  async changedFiles(): Promise<string[]> {
    return [...this.changed];
  }

  async assertClean(): Promise<void> {
    this.calls.push("assert-clean");
  }

  async push(): Promise<void> {
    this.failOrRecord("push");
  }

  async deleteRemoteBranch(): Promise<void> {
    this.failOrRecord("delete-remote-branch");
  }

  async cleanup(): Promise<void> {
    this.failOrRecord("cleanup");
  }

  private failOrRecord(effect: string): void {
    this.calls.push(effect);
    if (this.failures.delete(effect))
      throw new Error(`synthetic ${effect} response loss`);
  }
}

class FakePi {
  readonly branch: Array<{
    type: "custom";
    customType: string;
    data: unknown;
  }> = [];
  readonly notifications: string[] = [];

  appendEntry(customType: string, data: unknown): void {
    this.branch.push({ type: "custom", customType, data });
  }
}

class FakeRpc implements ForgeRpcPort {
  readonly handlers = new Set<(payload: unknown) => void>();
  readonly spawnInputs: Parameters<ForgeRpcPort["spawnWorkOn"]>[0][] = [];
  result: ForgeWorkOnResult | undefined;
  resultOverrides: { headSha?: string; reviewers?: string[] } = {};
  onSpawn: ((input: Parameters<ForgeRpcPort["spawnWorkOn"]>[0]) => Promise<void>) | undefined;
  statusCalls = 0;

  async ping(): Promise<Awaited<ReturnType<ForgeRpcPort["ping"]>>> {
    return {
      version: 1,
      events: { asyncComplete: "subagents:async-complete" },
      capabilities: {},
    };
  }

  onAsyncComplete(handler: (payload: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async spawnWorkOn(
    input: Parameters<ForgeRpcPort["spawnWorkOn"]>[0],
  ): Promise<Awaited<ReturnType<ForgeRpcPort["spawnWorkOn"]>>> {
    this.spawnInputs.push(input);
    if (this.onSpawn) await this.onSpawn(input);
    this.result = makeResult(input, this.resultOverrides);
    return {
      runId: "child-run-1",
      resultPath: `${input.worktreeRoot}/.pi/forge/${input.runId}-work-on.json`,
      raw: {},
    };
  }

  async status(): Promise<unknown> {
    this.statusCalls += 1;
    return this.result;
  }

  emitCompletion(): void {
    const payload = { runId: "child-run-1" };
    for (const handler of this.handlers) handler(payload);
  }
}

class RuntimeEvents {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }
}

class RuntimePi {
  readonly events = new RuntimeEvents();
  readonly handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  readonly tools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();

  on(
    event: string,
    handler: (event: unknown, ctx: unknown) => unknown,
  ): () => void {
    this.handlers.set(event, handler);
    return () => this.handlers.delete(event);
  }

  registerTool(tool: { name: string; execute: (...args: any[]) => Promise<unknown> }): void {
    this.tools.set(tool.name, tool);
  }

  async exec(): Promise<{ stdout: string; stderr: string; code: number }> {
    return { stdout: "fake-token\n", stderr: "", code: 0 };
  }
}

function makePolicy(overrides: { autoMerge?: boolean } = {}): ForgePolicy {
  return parseForgePolicy({
    schema: "forgedock.config/v1",
    repository: { provider: "github", name: repository },
    state: {
      branch: "forgedock/state/v1",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
    },
    branches: {
      integration: ["staging"],
      protected: ["main"],
      autoMergeIntegration: overrides.autoMerge ?? true,
    },
    verification: {
      commands: {
        synthetic: {
          argv: ["synthetic-check"],
          required: false,
          timeoutMs: 1_000,
        },
      },
    },
    review: {
      required: ["forge-review-correctness", "forge-review-security"],
      maxRounds: 3,
    },
    subagents: { maxConcurrent: 2, maxDepth: 2 },
  });
}

function makeResult(
  input: Parameters<ForgeRpcPort["spawnWorkOn"]>[0],
  overrides: {
    headSha?: string;
    reviewers?: string[];
  } = {},
): ForgeWorkOnResult {
  const reviewers = overrides.reviewers ?? [
    "forge-review-correctness",
    "forge-review-security",
  ];
  const reviewerResults = reviewers.map((reviewer) => ({
    schema: "forgedock.reviewer-result/v1" as const,
    runId: input.runId,
    reviewer,
    headSha: overrides.headSha ?? headSha,
    verdict: "pass" as const,
    findings: [],
    filesReviewed: ["test/integration/work-on.test.ts"],
    limitations: [],
  }));
  return {
    schema: "forgedock.work-on-result/v1",
    runId: input.runId,
    issueNumber: input.issueNumber,
    status: "ready-for-merge",
    branch: input.branch,
    baseSha: input.baseSha,
    headSha: overrides.headSha ?? headSha,
    changedFiles: ["test/integration/work-on.test.ts"],
    verification: [],
    review: {
      headSha: overrides.headSha ?? headSha,
      rounds: 1,
      completedReviewers: reviewers,
      reviewerResults,
      findings: [],
    },
    residualRisks: [],
  };
}

async function appendChildPhases(
  journal: ForgeJournalPort,
  runId: string,
): Promise<void> {
  const phases = [
    "resolve",
    "investigate",
    "plan",
    "prepare-worktree",
    "implement",
    "verify",
    "review",
  ] as const;
  for (const phase of phases) {
    await journal.append({
      runId,
      type: "phase.queued",
      payload: {
        phase,
        attempt: 1,
        restartAction: `retry ${phase}`,
      },
      idempotencyKey: `phase:${phase}:1:queue`,
      sessionId: "child-session",
      message: `${phase} queued`,
    });
    await journal.append({
      runId,
      type: "phase.started",
      payload: {
        phase,
        attempt: 1,
        logicalNodeId: `${phase}-1`,
      },
      idempotencyKey: `phase:${phase}:1:start`,
      sessionId: "child-session",
      message: `${phase} started`,
    });
    await journal.append({
      runId,
      type: "phase.completed",
      payload: {
        phase,
        attempt: 1,
        evidence: [`${phase} evidence`],
      },
      idempotencyKey: `phase:${phase}:1:complete`,
      sessionId: "child-session",
      message: `${phase} complete`,
    });
  }
}

interface HarnessOptions {
  existingPull?: boolean;
  missingIssueMarker?: string;
  autoMerge?: boolean;
  staleLease?: boolean;
  reviewers?: string[];
  resultHeadSha?: string;
  gitHeadSha?: string;
  failGitEffect?: string;
  crashAt?: "pull-request" | "review-artifact" | "merge" | "close";
}

function createHarness(options: HarnessOptions = {}) {
  const pi = new FakePi();
  const rpc = new FakeRpc();
  rpc.resultOverrides = {
    headSha: options.resultHeadSha,
    reviewers: options.reviewers,
  };
  const git = new FakeGit();
  if (options.gitHeadSha) git.headSha = options.gitHeadSha;
  if (options.failGitEffect) git.failures.add(options.failGitEffect);
  const transport = new FakeGitHubTransport({
    existingPull: options.existingPull ?? true,
    missingIssueMarker: options.missingIssueMarker,
  });
  if (options.crashAt === "pull-request")
    transport.failPullCreateAfterEffectOnce = true;
  if (options.crashAt === "review-artifact") transport.failArtifactOnce = true;
  if (options.crashAt === "merge") transport.failMergeAfterEffectOnce = true;
  if (options.crashAt === "close")
    transport.failIssueCloseAfterEffectOnce = true;
  const store = new MemoryStateStore();
  let journal: ForgeJournalPort | undefined;
  const policy = makePolicy({ autoMerge: options.autoMerge });
  rpc.onSpawn = async (input) => {
    if (!journal) throw new Error("journal was not created before child spawn");
    await appendChildPhases(journal, input.runId);
    if (options.staleLease && store.state?.lease) {
      store.leaseOverride = {
        ...store.state.lease,
        ownerRunId: "different-run",
        ownerSessionId: "different-session",
      };
    }
    rpc.result = makeResult(input, {
      headSha: options.resultHeadSha,
      reviewers: options.reviewers,
    });
  };
  const dependencies = {
    rpc,
    git,
    loadPolicy: async () => ({
      policy,
      trackedPath: "/fake/repository/.forge/config.json",
      localPath: "/fake/repository/.pi/forge.local.json",
      localOverridesApplied: false,
    }),
    materializeAgents: async () => [],
    resolveGitHubToken: async () => "fake-token",
    createTransport: () => transport,
    createStateStore: () => store,
    createJournal: (stateStore: ForgeStateStorePort) => {
      const created = new RunJournal(
        stateStore as unknown as ConstructorParameters<typeof RunJournal>[0],
      );
      journal = created;
      return created;
    },
  };
  const controller = new ForgeWorkOnController(
    pi as unknown as ExtensionAPI,
    dependencies,
  );
  const context = makeContext(pi, "session-1");
  return {
    pi,
    rpc,
    git,
    transport,
    store,
    controller,
    context,
    dependencies,
  };
}

function makeContext(pi: FakePi, sessionId: string): ExtensionContext & ExtensionCommandContext {
  return {
    cwd: "/fake/repository",
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => pi.branch,
    },
    ui: {
      setStatus: () => undefined,
      notify: (message: string) => pi.notifications.push(message),
    },
  } as unknown as ExtensionContext & ExtensionCommandContext;
}

async function completeHarness(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.controller.attach(harness.context);
  await harness.controller.startIssue(
    issueNumber,
    harness.context as unknown as ExtensionCommandContext,
  );
  harness.rpc.emitCompletion();
  await eventually(
    () => harness.controller.listRuns()[0]?.status !== "running",
  );
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("timed out waiting for Forge lifecycle completion");
}

async function resumeFailedHarness(
  harness: ReturnType<typeof createHarness>,
): Promise<ForgeWorkOnController> {
  const latest = harness.pi.branch.at(-1);
  assert.ok(latest);
  assert.equal((latest.data as { status?: unknown }).status, "failed");
  (latest.data as { status: string }).status = "running";
  harness.controller.dispose();
  const restored = new ForgeWorkOnController(
    harness.pi as unknown as ExtensionAPI,
    harness.dependencies,
  );
  await restored.attach(harness.context);
  harness.rpc.emitCompletion();
  await eventually(() => restored.listRuns()[0]?.status !== "running");
  return restored;
}

const validReports: Record<"investigate" | "plan" | "implement" | "verify", string> = {
  investigate: `<!-- FORGE:INVESTIGATOR -->\n## Investigation Report\n### Root Cause\ncovered\n### Evidence\ncovered\n### Acceptance Spec\ncovered\n<!-- INVESTIGATION:COMPLETE -->`,
  plan: `<!-- FORGE:CONTRACT -->\n## Builder Contract\n<!-- FORGE:CONTEXT -->\ncontext\n<!-- FORGE:CONTEXT:COMPLETE -->\n<!-- FORGE:ARCHITECT -->\nplan\n<!-- FORGE:ARCHITECT:COMPLETE -->`,
  implement: `<!-- FORGE:BUILDER -->\n## Implementation Complete\n### Approach\ncovered\n### Changes\ncovered\n### Acceptance Criteria Status\ncovered\n### Testing Checklist\ncovered`,
  verify: `<!-- FORGE:ACCEPTANCE_GATE -->\n## Acceptance Gate — PASSED\n<!-- FORGE:ACCEPTANCE_GATE:PASSED -->`,
};

test("child checkpoint reports and journal sequencing are deterministic and idempotent", async () => {
  for (const [phase, report] of Object.entries(validReports) as Array<
    [keyof typeof validReports, string]
  >)
    assert.doesNotThrow(() => validatePhaseReport(phase, report));

  assert.throws(
    () => validatePhaseReport("investigate", "## Investigation Report\n### Evidence"),
    /missing canonical ForgeDock fields/,
  );
  assert.throws(
    () => validatePhaseReport("verify", "<!-- FORGE:ACCEPTANCE_GATE -->"),
    /FORGE:ACCEPTANCE_GATE:PASSED/,
  );

  const store = new MemoryStateStore();
  const journal = new RunJournal(
    store as unknown as ConstructorParameters<typeof RunJournal>[0],
  );
  await journal.initialize({
    runId: "checkpoint-run",
    repository,
    issueNumber,
    integrationBranch: "staging",
    protectedBranch: "main",
    sessionId: "session-1",
    leaseSeconds: 300,
  });
  await journal.append({
    runId: "checkpoint-run",
    type: "phase.queued",
    payload: {
      phase: "resolve",
      attempt: 1,
      restartAction: "retry resolve",
    },
    idempotencyKey: "phase:resolve:1:queue",
    sessionId: "session-1",
    message: "resolve queued",
  });
  const duplicate = await journal.append({
    runId: "checkpoint-run",
    type: "phase.queued",
    payload: {
      phase: "resolve",
      attempt: 1,
      restartAction: "retry resolve",
    },
    idempotencyKey: "phase:resolve:1:queue",
    sessionId: "session-1",
    message: "duplicate resolve queued",
  });
  assert.equal(duplicate.events.length, 3);
  assert.equal(duplicate.state.phases.resolve?.attempts[0]?.status, "queued");
});

test("child runtime checkpoint tool persists ordered events and rejects malformed reports before commit", async () => {
  const store = new MemoryStateStore();
  const journal = new RunJournal(
    store as unknown as ConstructorParameters<typeof RunJournal>[0],
  );
  await journal.initialize({
    runId: "runtime-run",
    repository,
    issueNumber,
    integrationBranch: "staging",
    protectedBranch: "main",
    sessionId: "runtime-session",
    leaseSeconds: 300,
  });
  const projector = {
    async projectEvent(): Promise<void> {},
    async postArtifact(): Promise<void> {},
    async appendToLatestComment(): Promise<void> {},
    async setWorkflowLabel(): Promise<void> {},
  };
  const root = process.cwd();
  const binding = {
    runId: "runtime-run",
    resultPath: `${root}/.pi/forge/runtime-run-work-on.json`,
    repository,
    issueNumber,
    leaseEpoch: 1,
    stateBranch: "forgedock/state/v1",
    worktreeRoot: root,
    branch: "forge/issue-3-runtime",
    baseBranch: "staging",
    baseSha,
    maxReviewRounds: 3,
    verificationCommands: {},
  };
  const priorBinding = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({
    "forgedock.pi/1": binding,
  });
  try {
    const pi = new RuntimePi();
    const dependencies: ForgeChildRuntimeDependencies = {
      createTransport: () =>
        ({
          request: async () => {
            throw new Error("network must not be used by the fake checkpoint store");
          },
        }) as GitHubTransport,
      createStateStore: () => store,
      createProjector: () => projector as unknown as ReturnType<NonNullable<ForgeChildRuntimeDependencies["createProjector"]>>,
    };
    forgeChildRuntime(pi as unknown as ExtensionAPI, dependencies);
    const sessionContext = {
      cwd: root,
      sessionManager: { getSessionId: () => "runtime-session" },
    };
    const sessionStart = pi.handlers.get("session_start");
    assert.ok(sessionStart);
    await sessionStart({}, sessionContext);
    const checkpoint = pi.tools.get("forge_checkpoint");
    assert.ok(checkpoint);
    const invoke = (params: Record<string, unknown>) =>
      checkpoint.execute(
        "checkpoint",
        params,
        undefined,
        undefined,
        sessionContext,
      );

    await invoke({ phase: "resolve", attempt: 1, action: "queue" });
    await invoke({ phase: "resolve", attempt: 1, action: "start" });
    await invoke({ phase: "resolve", attempt: 1, action: "complete" });
    await invoke({ phase: "investigate", attempt: 1, action: "queue" });
    await invoke({ phase: "investigate", attempt: 1, action: "start" });
    await invoke({
      phase: "investigate",
      attempt: 1,
      action: "complete",
      report: validReports.investigate,
    });
    const sequenceAfterInvestigation = store.state?.sequence;
    await invoke({
      phase: "investigate",
      attempt: 1,
      action: "complete",
      report: validReports.investigate,
    });
    assert.equal(store.state?.sequence, sequenceAfterInvestigation);

    await invoke({ phase: "plan", attempt: 1, action: "queue" });
    await invoke({ phase: "plan", attempt: 1, action: "start" });
    const eventsBeforeMalformed = store.events.length;
    await assert.rejects(
      invoke({ phase: "plan", attempt: 1, action: "complete", report: "malformed" }),
      /missing canonical ForgeDock fields/,
    );
    assert.equal(store.events.length, eventsBeforeMalformed);
    assert.equal(store.state?.phases.plan?.attempts[0]?.status, "running");

    assert.ok(store.state?.lease);
    store.leaseOverride = {
      ...store.state.lease,
      ownerRunId: "other-run",
      ownerSessionId: "other-session",
    };
    await assert.rejects(
      invoke({ phase: "plan", attempt: 1, action: "complete", report: validReports.plan }),
      /no longer owns run/,
    );
  } finally {
    if (priorBinding === undefined)
      delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = priorBinding;
  }
});

test("controller finalization reaches terminal state and duplicate completion has no duplicate effects", async () => {
  const harness = createHarness({ existingPull: true });
  await completeHarness(harness);

  assert.equal(harness.controller.listRuns()[0]?.status, "completed");
  assert.deepEqual(harness.git.calls.filter((call) => call !== "assert-clean"), [
    "push",
    "delete-remote-branch",
    "cleanup",
  ]);
  assert.equal(harness.transport.pullCreateRequests, 0);
  assert.equal(harness.transport.mergeRequests, 1);
  assert.equal(harness.transport.issueCloseRequests, 1);
  assert.equal(harness.store.state?.status, "completed");
  assert.equal(harness.store.state?.lease, undefined);
  const effects = Object.values(harness.store.state?.effects ?? {});
  assert.equal(effects.length, 5);
  assert.deepEqual(
    effects.map((effect) => effect.effectType).sort(),
    ["cleanup", "issue-close", "merge", "pull-request", "push"].sort(),
  );
  assert.equal(harness.transport.issue.state, "closed");
  assert.equal(harness.transport.labels.has("workflow:merged"), true);

  const statusCalls = harness.rpc.statusCalls;
  harness.rpc.emitCompletion();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.rpc.statusCalls, statusCalls);
  assert.equal(harness.transport.mergeRequests, 1);
  assert.equal(harness.transport.issueCloseRequests, 1);
  assert.equal(harness.git.calls.filter((call) => call === "cleanup").length, 1);
});

test("workflow adapter reuses PRs and makes artifacts, merge, and close retries idempotent", async () => {
  const transport = new FakeGitHubTransport({ existingPull: false });
  const github = new GitHubWorkflowAdapter(transport, repository);
  const first = await github.createPullRequest({
    title: "fixture",
    body: "fixture",
    head: "forge/issue-3-run",
    base: "staging",
  });
  const second = await github.createPullRequest({
    title: "fixture",
    body: "fixture",
    head: "forge/issue-3-run",
    base: "staging",
  });
  assert.equal(first.number, second.number);
  assert.equal(transport.pullCreateRequests, 1);

  await github.postPullArtifact({
    pullNumber: 7,
    marker: "<!-- FIXTURE:ARTIFACT -->",
    body: "artifact",
  });
  await github.postPullArtifact({
    pullNumber: 7,
    marker: "<!-- FIXTURE:ARTIFACT -->",
    body: "artifact retry",
  });
  assert.equal(
    transport.pullComments.filter((comment) =>
      comment.body.includes("<!-- FIXTURE:ARTIFACT -->"),
    ).length,
    1,
  );

  await github.mergePullRequest({
    pullNumber: 7,
    expectedHeadSha: headSha,
  });
  await github.mergePullRequest({
    pullNumber: 7,
    expectedHeadSha: headSha,
  });
  assert.equal(transport.mergeRequests, 1);

  await github.closeIssue(issueNumber);
  await github.closeIssue(issueNumber);
  assert.equal(transport.issueCloseRequests, 1);
});

test("finalization fails closed for stale SHA, lease, audit, review, and policy authority", async () => {
  const cases: Array<[string, HarnessOptions]> = [
    ["stale reviewed SHA", { resultHeadSha: "stale-head" }],
    ["stale lease", { staleLease: true }],
    ["missing audit marker", { missingIssueMarker: "<!-- FORGE:ARCHITECT -->" }],
    ["incomplete review panel", { reviewers: ["forge-review-correctness"] }],
    ["human-only policy", { autoMerge: false }],
  ];
  for (const [name, options] of cases) {
    const harness = createHarness(options);
    await completeHarness(harness);
    assert.equal(
      harness.controller.listRuns()[0]?.status,
      "failed",
      `${name} should fail the run`,
    );
    assert.equal(harness.transport.mergeRequests, 0, `${name} merged unexpectedly`);
  }
});

test("a crash at an owned Git effect is recorded without terminal duplication", async () => {
  const harness = createHarness({ failGitEffect: "push" });
  await completeHarness(harness);
  assert.equal(harness.controller.listRuns()[0]?.status, "failed");
  assert.equal(harness.transport.mergeRequests, 0);
  assert.equal(harness.git.calls.includes("push"), true);

  const restored = new ForgeWorkOnController(
    harness.pi as unknown as ExtensionAPI,
    harness.dependencies,
  );
  await restored.attach(harness.context);
  assert.equal(restored.listRuns()[0]?.status, "failed");
  harness.rpc.emitCompletion();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.transport.mergeRequests, 0);
});

test("restart replay recovers after push, PR, audit, merge, close, and cleanup response loss", async () => {
  const cases: Array<[string, HarnessOptions]> = [
    ["push", { failGitEffect: "push" }],
    ["pull-request", { existingPull: false, crashAt: "pull-request" }],
    ["audit publication", { crashAt: "review-artifact" }],
    ["merge", { crashAt: "merge" }],
    ["close", { crashAt: "close" }],
    ["cleanup", { failGitEffect: "delete-remote-branch" }],
  ];
  for (const [name, options] of cases) {
    const harness = createHarness(options);
    await completeHarness(harness);
    assert.equal(harness.controller.listRuns()[0]?.status, "failed", `${name} did not stop at the crash boundary`);
    const restored = await resumeFailedHarness(harness);
    assert.equal(restored.listRuns()[0]?.status, "completed", `${name} did not recover`);
    assert.equal(harness.transport.mergeRequests, 1, `${name} duplicated merge`);
    assert.equal(harness.transport.issueCloseRequests, 1, `${name} duplicated close`);
    assert.equal(harness.store.state?.status, "completed", `${name} did not complete the journal`);
  }
});

