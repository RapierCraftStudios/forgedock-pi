import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
  GitHubRequest,
  GitHubResponse,
  GitHubTransport,
} from "../../src/adapters/github-api.ts";
import type {
  GitHubIssueData,
  GitHubPullRequestData,
  MergeResult,
} from "../../src/adapters/github-workflow.ts";
import type {
  ExecResult,
  PreparedWorktree,
} from "../../src/adapters/git.ts";
import type { ForgeReviewerResult, ForgeWorkOnResult } from "../../src/agents/contracts.ts";
import type { ForgeChildRuntimeServices } from "../../src/agents/child-runtime.ts";
import { parseForgePolicy, type ForgePolicy } from "../../src/core/policy.ts";
import {
  replayRunEvents,
  type RunState,
} from "../../src/core/state.ts";
import { RUN_PHASES, type RunEvent } from "../../src/core/events.ts";
import type { RepositoryLease } from "../../src/core/lease.ts";
import type {
  ForgeWorkOnGit,
  ForgeWorkOnGitHub,
  ForgeWorkOnProjector,
  ForgeWorkOnRpc,
} from "../../src/workflows/work-on.ts";
import type { RunJournalStore } from "../../src/workflows/journal.ts";
import { RunJournal } from "../../src/workflows/journal.ts";

export const TEST_REPOSITORY = "owner/repo";
export const TEST_ISSUE = 3;
export const TEST_RUN_ID = "run-issue-3";
export const TEST_SUBAGENT_RUN_ID = "subagent-issue-3";
export const TEST_BRANCH = "forge/issue-3-run-issu";
export const TEST_BASE_BRANCH = "staging";
export const TEST_BASE_SHA = "base-sha-issue-3";
export const TEST_HEAD_SHA = "head-sha-issue-3";

export function testPolicy(): ForgePolicy {
  return parseForgePolicy({
    schema: "forgedock.config/v1",
    repository: { provider: "github", name: TEST_REPOSITORY },
    state: {
      branch: "forgedock/state/v1",
      leaseSeconds: 300,
      heartbeatSeconds: 60,
    },
    branches: {
      integration: [TEST_BASE_BRANCH],
      protected: ["main"],
      autoMergeIntegration: true,
    },
    verification: {
      commands: {
        test: {
          argv: ["npm", "test"],
          required: true,
          timeoutMs: 600_000,
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

export class MemoryRunStore implements RunJournalStore {
  tip = "tip-0";
  events: RunEvent[] = [];
  state: RunState | undefined;
  lease: RepositoryLease | undefined;
  commits = 0;

  async ensureBranch(): Promise<string> {
    return this.tip;
  }

  async readRun(runId: string) {
    if (this.state && this.state.runId !== runId)
      throw new Error(`Unexpected run ${runId}.`);
    return {
      tip: this.tip,
      events: [...this.events],
      snapshotMatchesJournal: this.state !== undefined,
      ...(this.state ? { state: this.state } : {}),
      ...(this.lease ? { lease: this.lease } : {}),
    };
  }

  async commitRunState(input: {
    expectedTip: string;
    events: readonly RunEvent[];
    state: RunState;
    lease?: RepositoryLease;
    message: string;
  }): Promise<string> {
    if (input.expectedTip !== this.tip)
      throw new Error(`CAS conflict for ${input.expectedTip}.`);
    if (!input.message.trim()) throw new Error("State message is required.");
    const reduced = replayRunEvents(input.events);
    if (JSON.stringify(reduced) !== JSON.stringify(input.state))
      throw new Error("Fixture state snapshot does not match its journal.");
    this.events = [...input.events];
    this.state = input.state;
    this.lease = input.lease;
    this.tip = `tip-${++this.commits}`;
    return this.tip;
  }

  clone(): MemoryRunStore {
    const copy = new MemoryRunStore();
    copy.tip = this.tip;
    copy.events = [...this.events];
    copy.state = this.state;
    copy.lease = this.lease;
    copy.commits = this.commits;
    return copy;
  }
}

interface StoredIssue extends GitHubIssueData {
  labels: string[];
}

interface StoredPull extends GitHubPullRequestData {
  mergeSha: string;
}

export class MemoryGitHub
  implements ForgeWorkOnGitHub, ForgeChildRuntimeServices["github"]
{
  readonly issues = new Map<number, StoredIssue>();
  readonly pulls = new Map<number, StoredPull>();
  readonly comments = new Map<number, string[]>();
  readonly effects: string[] = [];
  readonly failureBudget = new Map<string, number>();
  nextPullNumber = 100;
  nextCommentId = 1;
  closeCalls = 0;
  mergeCalls = 0;

  constructor() {
    this.issues.set(TEST_ISSUE, {
      number: TEST_ISSUE,
      title: "Add end-to-end tests for work-on finalization and recovery",
      body: "Deterministic integration fixture issue.",
      state: "open",
      labels: ["enhancement", "workflow"],
    });
  }

  failNext(operation: string): void {
    this.failureBudget.set(operation, (this.failureBudget.get(operation) ?? 0) + 1);
  }

  seedComments(number: number, ...bodies: string[]): void {
    this.comments.set(number, [...bodies]);
  }

  addComment(number: number, body: string): void {
    const current = this.comments.get(number) ?? [];
    current.push(body);
    this.comments.set(number, current);
  }

  async getIssue(issueNumber: number): Promise<GitHubIssueData> {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found.`);
    return { ...issue, labels: [...issue.labels] };
  }

  async createPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<GitHubPullRequestData> {
    this.throwIfBudgeted("pull-request");
    const existing = [...this.pulls.values()].find(
      (pull) =>
        pull.headRef === input.head &&
        (pull.state === "open" || pull.merged),
    );
    if (existing) return { ...existing };
    const number = this.nextPullNumber++;
    const pull: StoredPull = {
      number,
      htmlUrl: `https://github.invalid/${TEST_REPOSITORY}/pull/${number}`,
      state: "open",
      merged: false,
      headSha: TEST_HEAD_SHA,
      baseSha: TEST_BASE_SHA,
      headRef: input.head,
      baseRef: input.base,
      mergeability: "mergeable",
      mergeSha: `merge-sha-${number}`,
    };
    this.pulls.set(number, pull);
    this.comments.set(number, []);
    this.effects.push(`pull-request:${number}`);
    return { ...pull };
  }

  async getPullRequest(pullNumber: number): Promise<GitHubPullRequestData> {
    const pull = this.pulls.get(pullNumber);
    if (!pull) throw new Error(`PR #${pullNumber} not found.`);
    return { ...pull };
  }

  async mergePullRequest(input: {
    pullNumber: number;
    expectedHeadSha: string;
  }): Promise<MergeResult> {
    this.throwIfBudgeted("merge");
    this.mergeCalls += 1;
    const pull = this.pulls.get(input.pullNumber);
    if (!pull) throw new Error(`PR #${input.pullNumber} not found.`);
    if (pull.merged)
      return { merged: true, sha: pull.mergeSha, message: "Already merged" };
    if (pull.headSha !== input.expectedHeadSha)
      throw new Error(`Stale reviewed SHA ${input.expectedHeadSha}.`);
    pull.merged = true;
    pull.state = "closed";
    this.effects.push(`merge:${input.pullNumber}`);
    return { merged: true, sha: pull.mergeSha, message: "Merged" };
  }

  async getComments(issueOrPullNumber: number): Promise<string[]> {
    return [...(this.comments.get(issueOrPullNumber) ?? [])];
  }

  async postPullArtifact(input: {
    pullNumber: number;
    marker: string;
    body: string;
  }): Promise<number> {
    this.throwIfBudgeted("pull-artifact");
    const comments = this.comments.get(input.pullNumber) ?? [];
    const existing = comments.findIndex((body) => body.includes(input.marker));
    if (existing >= 0) return existing + 1;
    comments.push(`${input.marker}\n${input.body.trim()}\n`);
    this.comments.set(input.pullNumber, comments);
    this.effects.push(`pull-artifact:${input.marker}`);
    return this.nextCommentId++;
  }

  async closeIssue(issueNumber: number): Promise<void> {
    this.throwIfBudgeted("close");
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found.`);
    this.closeCalls += 1;
    issue.state = "closed";
    this.effects.push(`close:${issueNumber}`);
  }

  private throwIfBudgeted(operation: string): void {
    const remaining = this.failureBudget.get(operation) ?? 0;
    if (remaining < 1) return;
    if (remaining === 1) this.failureBudget.delete(operation);
    else this.failureBudget.set(operation, remaining - 1);
    throw new Error(`Injected ${operation} failure.`);
  }
}

export class MemoryProjector implements ForgeWorkOnProjector {
  readonly labels = new Map<number, string>();
  readonly failureBudget = new Map<string, number>();
  readonly effects: string[] = [];

  constructor(readonly github: MemoryGitHub) {}

  failNext(operation: string): void {
    this.failureBudget.set(operation, (this.failureBudget.get(operation) ?? 0) + 1);
  }

  async projectEvent(input: {
    issueNumber: number;
    event: RunEvent;
    markdown: string;
    addLabels?: readonly string[];
  }): Promise<{ commentId: number; created: boolean; labelsAdded: readonly string[] }> {
    this.throwIfBudgeted("project-event");
    const marker = `<!-- FORGEDOCK-EVENT:${input.event.eventId} -->`;
    const comments = this.github.comments.get(input.issueNumber) ?? [];
    const exists = comments.some((body) => body.includes(marker));
    if (!exists) comments.push(`${marker}\n${input.markdown.trim()}`);
    this.github.comments.set(input.issueNumber, comments);
    for (const label of input.addLabels ?? []) {
      const issue = this.github.issues.get(input.issueNumber);
      if (issue && !issue.labels.includes(label)) issue.labels.push(label);
    }
    this.effects.push(`project-event:${input.event.eventId}`);
    return {
      commentId: 1,
      created: !exists,
      labelsAdded: input.addLabels ?? [],
    };
  }

  async postArtifact(input: {
    issueNumber: number;
    runId: string;
    eventId: string;
    artifactKey: string;
    markdown: string;
  }): Promise<number> {
    this.throwIfBudgeted("artifact");
    const marker = `<!-- FORGEDOCK-ARTIFACT:${input.eventId}:${input.artifactKey} -->`;
    const comments = this.github.comments.get(input.issueNumber) ?? [];
    const existing = comments.findIndex((body) => body.includes(marker));
    if (existing >= 0) return existing + 1;
    comments.push(`${marker}\n${input.markdown.trim()}`);
    this.github.comments.set(input.issueNumber, comments);
    this.effects.push(`artifact:${input.artifactKey}`);
    return comments.length;
  }

  async appendToLatestComment(input: {
    issueNumber: number;
    marker: string;
    append: string;
    skipIfContains?: string;
  }): Promise<number> {
    this.throwIfBudgeted("append");
    const comments = this.github.comments.get(input.issueNumber) ?? [];
    const index = comments
      .map((body, position) => ({ body, position }))
      .filter(({ body }) => body.includes(input.marker))
      .filter(
        ({ body }) =>
          !input.skipIfContains || !body.includes(input.skipIfContains),
      )
      .at(-1)?.position;
    if (index === undefined) throw new Error(`Missing ${input.marker}.`);
    comments[index] = `${comments[index]}\n${input.append}`;
    this.github.comments.set(input.issueNumber, comments);
    return index + 1;
  }

  async setWorkflowLabel(issueNumber: number, workflowLabel: string): Promise<void> {
    this.throwIfBudgeted("label");
    this.labels.set(issueNumber, workflowLabel);
    const issue = this.github.issues.get(issueNumber);
    if (issue) {
      issue.labels = issue.labels.filter((label) => !label.startsWith("workflow:"));
      issue.labels.push(workflowLabel);
    }
  }

  private throwIfBudgeted(operation: string): void {
    const remaining = this.failureBudget.get(operation) ?? 0;
    if (remaining < 1) return;
    if (remaining === 1) this.failureBudget.delete(operation);
    else this.failureBudget.set(operation, remaining - 1);
    throw new Error(`Injected ${operation} failure.`);
  }
}

export class MemoryGit implements ForgeWorkOnGit {
  readonly calls: string[] = [];
  readonly failureBudget = new Map<string, number>();
  cleaned = false;
  prepared: PreparedWorktree;

  constructor(readonly root: string) {
    this.prepared = {
      repositoryRoot: root,
      worktreePath: join(root, "worktree"),
      branch: TEST_BRANCH,
      baseBranch: TEST_BASE_BRANCH,
      baseSha: TEST_BASE_SHA,
    };
  }

  failNext(operation: string): void {
    this.failureBudget.set(operation, (this.failureBudget.get(operation) ?? 0) + 1);
  }

  async resolveRepositoryRoot(): Promise<string> {
    return this.root;
  }

  async prepare(): Promise<PreparedWorktree> {
    await mkdir(this.prepared.worktreePath, { recursive: true });
    this.cleaned = false;
    this.calls.push("prepare");
    return this.prepared;
  }

  async cleanup(): Promise<void> {
    this.throwIfBudgeted("cleanup");
    this.calls.push("cleanup");
    this.cleaned = true;
  }

  async assertClean(): Promise<void> {
    this.throwIfBudgeted("assert-clean");
    this.calls.push("assert-clean");
  }

  async head(): Promise<string> {
    return TEST_HEAD_SHA;
  }

  async changedFiles(): Promise<string[]> {
    return ["test/integration/work-on.test.ts", "src/workflows/work-on.ts"];
  }

  async push(): Promise<void> {
    this.throwIfBudgeted("push");
    this.calls.push("push");
  }

  async deleteRemoteBranch(): Promise<void> {
    this.throwIfBudgeted("delete-remote");
    this.calls.push("delete-remote");
  }

  private throwIfBudgeted(operation: string): void {
    const remaining = this.failureBudget.get(operation) ?? 0;
    if (remaining < 1) return;
    if (remaining === 1) this.failureBudget.delete(operation);
    else this.failureBudget.set(operation, remaining - 1);
    throw new Error(`Injected ${operation} failure.`);
  }
}

export class MemoryRpc implements ForgeWorkOnRpc {
  readonly handlers = new Set<(payload: unknown) => void>();
  readonly launchInputs: unknown[] = [];
  readonly statuses = new Map<string, unknown>();
  result: ForgeWorkOnResult | undefined;

  async ping(): Promise<{
    version: 1;
    events: { asyncComplete: string };
    capabilities: Record<string, unknown>;
  }> {
    return {
      version: 1,
      events: { asyncComplete: "memory:async-complete" },
      capabilities: {},
    };
  }

  async spawnWorkOn(input: {
    runId: string;
    issueNumber: number;
    repository: string;
    worktreeRoot: string;
    branch: string;
    baseBranch: string;
    baseSha: string;
    leaseEpoch: number;
    policy: ForgePolicy;
    issueContext: string;
  }) {
    this.launchInputs.push(input);
    const resultPath = join(input.worktreeRoot, ".pi", "forge", "result.json");
    return { runId: TEST_SUBAGENT_RUN_ID, resultPath, raw: {} };
  }

  async status(): Promise<unknown> {
    return this.result;
  }

  onAsyncComplete(handler: (payload: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  complete(): void {
    const payload = { runId: TEST_SUBAGENT_RUN_ID, result: this.result };
    for (const handler of this.handlers) handler(payload);
  }
}

export class MemoryPi {
  readonly entries: Array<{ type: string; data: unknown }> = [];
  readonly notices: string[] = [];
  readonly statuses: Array<string | undefined> = [];
  readonly execCalls: Array<{ command: string; args: readonly string[] }> = [];

  asExtensionApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }

  appendEntry(type: string, data: unknown): void {
    const index = this.entries.findIndex((entry) => entry.type === type);
    if (index >= 0) this.entries[index] = { type, data };
    else this.entries.push({ type, data });
  }

  getBranch(): Array<{ type: "custom"; customType: string; data: unknown }> {
    return this.entries.map((entry) => ({
      type: "custom",
      customType: entry.type,
      data: entry.data,
    }));
  }

  async exec(command: string, args: readonly string[]): Promise<ExecResult> {
    this.execCalls.push({ command, args });
    return {
      stdout: command === "gh" ? "fixture-token\n" : "",
      stderr: "",
      code: 0,
    };
  }

  context(cwd: string, sessionId: string): ExtensionContext {
    const pi = this;
    return {
      cwd,
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => pi.getBranch(),
      },
      ui: {
        notify: (message: string) => pi.notices.push(message),
        setStatus: (_key: string, value: string | undefined) =>
          pi.statuses.push(value),
      },
    } as unknown as ExtensionContext;
  }
}

export function servicesFor(
  github: MemoryGitHub,
  store: MemoryRunStore,
  projector = new MemoryProjector(github),
): {
  github: MemoryGitHub;
  store: MemoryRunStore;
  projector: MemoryProjector;
} {
  return { github, store, projector };
}

export async function initializeRun(
  store: MemoryRunStore,
  now = new Date(Date.now() - 1_000),
): Promise<void> {
  const journal = new RunJournal(store);
  await journal.initialize({
    runId: TEST_RUN_ID,
    repository: TEST_REPOSITORY,
    issueNumber: TEST_ISSUE,
    integrationBranch: TEST_BASE_BRANCH,
    protectedBranch: "main",
    sessionId: "session-1",
    leaseSeconds: 300,
    now,
  });
}

export async function completeChildPhases(store: MemoryRunStore): Promise<void> {
  const journal = new RunJournal(store);
  for (const phase of RUN_PHASES.slice(0, 7)) {
    await journal.append({
      runId: TEST_RUN_ID,
      type: "phase.queued",
      payload: {
        phase,
        attempt: 1,
        restartAction: `retry ${phase}`,
      },
      idempotencyKey: `phase:${phase}:queue`,
      sessionId: "session-1",
      message: `queue ${phase}`,
    });
    await journal.append({
      runId: TEST_RUN_ID,
      type: "phase.started",
      payload: {
        phase,
        attempt: 1,
        logicalNodeId: `child-${phase}-1`,
      },
      idempotencyKey: `phase:${phase}:start`,
      sessionId: "session-1",
      message: `start ${phase}`,
    });
    await journal.append({
      runId: TEST_RUN_ID,
      type: "phase.completed",
      payload: {
        phase,
        attempt: 1,
        evidence: [`${phase} complete`],
      },
      idempotencyKey: `phase:${phase}:complete`,
      sessionId: "session-1",
      message: `complete ${phase}`,
    });
  }
}

export function seedPreMergeAudit(github: MemoryGitHub, pullNumber: number): void {
  github.seedComments(
    TEST_ISSUE,
    "<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->\n<!-- FORGE:FAST_PATH -->",
    "<!-- FORGE:CONTRACT -->\n<!-- FORGE:CONTEXT -->\n<!-- FORGE:CONTEXT:COMPLETE -->",
    "<!-- FORGE:ARCHITECT -->\n<!-- FORGE:ARCHITECT:COMPLETE -->",
    "<!-- FORGE:BUILDER -->\n<!-- FORGE:BUILDER:COMPLETE -->\n<!-- FORGE:ACCEPTANCE_GATE -->\n<!-- FORGE:ACCEPTANCE_GATE:PASSED -->",
    "<!-- FORGE:REVIEW_STARTED -->",
  );
  github.seedComments(
    pullNumber,
    "<!-- FORGE:REVIEW_ROUTE mode=single-pr -->",
    "<!-- FORGE:REVIEW -->\n<!-- REVIEW-FINDINGS-START -->\n<!-- REVIEW-FINDINGS-END -->",
  );
}

export function reviewerResult(
  reviewer: "correctness" | "security",
): ForgeReviewerResult {
  return {
    schema: "forgedock.reviewer-result/v1",
    runId: TEST_RUN_ID,
    reviewer: `forge-review-${reviewer}`,
    headSha: TEST_HEAD_SHA,
    verdict: "pass",
    findings: [],
    filesReviewed: ["src/workflows/work-on.ts"],
    limitations: [],
  };
}

export function readyResult(): ForgeWorkOnResult {
  return {
    schema: "forgedock.work-on-result/v1",
    runId: TEST_RUN_ID,
    issueNumber: TEST_ISSUE,
    status: "ready-for-merge",
    branch: TEST_BRANCH,
    baseSha: TEST_BASE_SHA,
    headSha: TEST_HEAD_SHA,
    changedFiles: ["test/integration/work-on.test.ts", "src/workflows/work-on.ts"],
    verification: [{ name: "test", status: "passed", exitCode: 0 }],
    review: {
      headSha: TEST_HEAD_SHA,
      rounds: 1,
      completedReviewers: ["forge-review-correctness", "forge-review-security"],
      reviewerResults: [reviewerResult("correctness"), reviewerResult("security")],
      findings: [],
    },
    residualRisks: [],
  };
}

export function fakeTransport(): GitHubTransport {
  return {
    async request<T>(_request: GitHubRequest): Promise<GitHubResponse<T>> {
      return {
        status: 200,
        data: {} as T,
        headers: {},
      };
    },
  };
}

export function childServices(
  github: MemoryGitHub,
  store: MemoryRunStore,
  projector: MemoryProjector,
): ForgeChildRuntimeServices {
  return { github, store, projector };
}

export async function removeFixtureRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
