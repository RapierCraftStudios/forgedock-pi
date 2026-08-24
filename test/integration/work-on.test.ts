import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  GitHubRequest,
  GitHubResponse,
  GitHubTransport,
} from "../../src/adapters/github-api.ts";
import { GitHubIssueProjector } from "../../src/adapters/github-projection.ts";
import { GitHubStateBranchStore } from "../../src/adapters/github-state.ts";
import forgeChildRuntime from "../../src/agents/child-runtime.ts";
import type {
  ForgeReviewerResult,
  ForgeWorkOnResult,
} from "../../src/agents/contracts.ts";
import type { RepositoryLease } from "../../src/core/lease.ts";
import { RunJournal } from "../../src/workflows/journal.ts";
import {
  ForgeWorkOnController,
  type ActiveRunLink,
} from "../../src/workflows/work-on.ts";

const execFileAsync = promisify(execFile);
const repository = "owner/repo";
const stateBranch = "forgedock/state/v1";
const issueNumber = 3;
const runId = "run-integration-3";
const sessionId = "session-integration-3";
const branch = "forge/issue-3-integration";
const baseSha = "base-sha-3";
const headSha = "head-sha-3";

interface JsonRecord {
  [key: string]: unknown;
}

interface TreeEntry {
  type: "blob";
  sha: string;
}

interface FakePull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  mergeable: boolean | null;
}

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Set<string>;
}

interface FakeComment {
  id: number;
  body: string;
}

interface InjectedFailure {
  method: GitHubRequest["method"];
  path: string;
  status: number;
}

class FakeGitHub implements GitHubTransport {
  readonly requests: GitHubRequest[] = [];
  readonly issues = new Map<number, FakeIssue>();
  readonly comments = new Map<number, FakeComment[]>();
  readonly pulls = new Map<number, FakePull>();
  readonly branchHeads = new Map<string, string>();
  readonly refs = new Map<string, string>();
  readonly blobs = new Map<string, string>();
  readonly trees = new Map<string, Map<string, TreeEntry>>();
  readonly commits = new Map<string, { tree: string; parents: string[] }>();
  readonly failures: InjectedFailure[] = [];
  nextPullNumber = 20;
  nextCommentId = 1;
  nextBlobId = 1;
  nextTreeId = 1;
  nextCommitId = 1;
  mergeCount = 0;
  issueCloseCount = 0;

  constructor() {
    this.issues.set(issueNumber, {
      number: issueNumber,
      title: "Add end-to-end tests for work-on finalization and recovery",
      body: "Deterministic integration fixture",
      state: "open",
      labels: new Set(["enhancement", "workflow"]),
    });
  }

  failNext(
    method: GitHubRequest["method"],
    path: string,
    status = 500,
  ): void {
    this.failures.push({ method, path, status });
  }

  addComment(number: number, body: string): void {
    const comments = this.comments.get(number) ?? [];
    comments.push({ id: this.nextCommentId++, body });
    this.comments.set(number, comments);
  }

  addPull(input: {
    number?: number;
    headSha: string;
    headRef?: string;
    baseSha?: string;
    baseRef?: string;
    mergeable?: boolean | null;
  }): number {
    const number = input.number ?? this.nextPullNumber++;
    this.pulls.set(number, {
      number,
      html_url: `https://github.com/${repository}/pull/${number}`,
      state: "open",
      merged: false,
      head: {
        sha: input.headSha,
        ref: input.headRef ?? branch,
      },
      base: {
        sha: input.baseSha ?? baseSha,
        ref: input.baseRef ?? "staging",
      },
      mergeable: input.mergeable ?? true,
    });
    return number;
  }

  commentsFor(number: number): readonly FakeComment[] {
    return this.comments.get(number) ?? [];
  }

  async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
    this.requests.push(request);
    const failureIndex = this.failures.findIndex(
      (failure) =>
        failure.method === request.method && request.path.includes(failure.path),
    );
    if (failureIndex >= 0) {
      const failure = this.failures.splice(failureIndex, 1)[0];
      return response(failure?.status ?? 500, {
        message: "deterministic injected failure",
      }) as GitHubResponse<T>;
    }

    const data = request.body;
    const cleanPath = request.path.split("?", 1)[0] ?? request.path;
    const apiRoot = `/repos/${repository}`;

    if (request.method === "GET" && cleanPath.startsWith(`${apiRoot}/git/ref/heads/`)) {
      const branchName = decodeURIComponent(
        cleanPath.slice(`${apiRoot}/git/ref/heads/`.length),
      );
      const sha = this.refs.get(branchName);
      return sha
        ? (response(200, { object: { sha } }) as GitHubResponse<T>)
        : (response(404, { message: "Not found" }) as GitHubResponse<T>);
    }

    if (request.method === "POST" && cleanPath === `${apiRoot}/git/refs`) {
      const body = record(data);
      const ref = stringValue(body.ref);
      const branchName = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
      if (this.refs.has(branchName))
        return response(422, { message: "Reference already exists" }) as GitHubResponse<T>;
      const sha = stringValue(body.sha);
      this.refs.set(branchName, sha);
      return response(201, { object: { sha } }) as GitHubResponse<T>;
    }

    if (request.method === "PATCH" && cleanPath.startsWith(`${apiRoot}/git/refs/heads/`)) {
      const branchName = decodeURIComponent(
        cleanPath.slice(`${apiRoot}/git/refs/heads/`.length),
      );
      const body = record(data);
      const sha = stringValue(body.sha);
      this.refs.set(branchName, sha);
      return response(200, { object: { sha } }) as GitHubResponse<T>;
    }

    if (request.method === "POST" && cleanPath === `${apiRoot}/git/blobs`) {
      const body = record(data);
      const sha = `blob-${this.nextBlobId++}`;
      this.blobs.set(sha, stringValue(body.content));
      return response(201, { sha }) as GitHubResponse<T>;
    }

    if (request.method === "POST" && cleanPath === `${apiRoot}/git/trees`) {
      const body = record(data);
      const baseTree = typeof body.base_tree === "string" ? body.base_tree : undefined;
      const entries = new Map<string, TreeEntry>(
        baseTree ? this.trees.get(baseTree) ?? [] : [],
      );
      const rawEntries = Array.isArray(body.tree) ? body.tree : [];
      for (const rawEntry of rawEntries) {
        const entry = record(rawEntry);
        const path = stringValue(entry.path);
        const sha = entry.sha;
        if (sha === null) entries.delete(path);
        else entries.set(path, { type: "blob", sha: stringValue(sha) });
      }
      const sha = `tree-${this.nextTreeId++}`;
      this.trees.set(sha, entries);
      return response(201, { sha }) as GitHubResponse<T>;
    }

    if (request.method === "POST" && cleanPath === `${apiRoot}/git/commits`) {
      const body = record(data);
      const sha = `commit-${this.nextCommitId++}`;
      this.commits.set(sha, {
        tree: stringValue(body.tree),
        parents: arrayOfStrings(body.parents),
      });
      return response(201, { sha }) as GitHubResponse<T>;
    }

    if (request.method === "GET" && cleanPath.startsWith(`${apiRoot}/git/commits/`)) {
      const sha = decodeURIComponent(cleanPath.slice(`${apiRoot}/git/commits/`.length));
      const commit = this.commits.get(sha);
      return commit
        ? (response(200, { sha, tree: { sha: commit.tree } }) as GitHubResponse<T>)
        : (response(404, { message: "Not found" }) as GitHubResponse<T>);
    }

    if (request.method === "GET" && cleanPath.startsWith(`${apiRoot}/git/trees/`)) {
      const sha = decodeURIComponent(cleanPath.slice(`${apiRoot}/git/trees/`.length));
      const entries = this.trees.get(sha);
      return entries
        ? (response(200, {
            sha,
            tree: [...entries.entries()].map(([path, entry]) => ({ path, ...entry })),
          }) as GitHubResponse<T>)
        : (response(404, { message: "Not found" }) as GitHubResponse<T>);
    }

    if (request.method === "GET" && cleanPath.startsWith(`${apiRoot}/git/blobs/`)) {
      const sha = decodeURIComponent(cleanPath.slice(`${apiRoot}/git/blobs/`.length));
      const content = this.blobs.get(sha);
      return content === undefined
        ? (response(404, { message: "Not found" }) as GitHubResponse<T>)
        : (response(200, {
            sha,
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
          }) as GitHubResponse<T>);
    }

    const commentMatch = cleanPath.match(new RegExp(`${apiRoot}/issues/(\\d+)/comments$`));
    if (commentMatch) {
      const number = Number(commentMatch[1]);
      if (request.method === "GET")
        return response(200, this.commentsFor(number)) as GitHubResponse<T>;
      if (request.method === "POST") {
        const body = record(data);
        const comment = { id: this.nextCommentId++, body: stringValue(body.body) };
        const comments = this.comments.get(number) ?? [];
        comments.push(comment);
        this.comments.set(number, comments);
        return response(201, comment) as GitHubResponse<T>;
      }
    }

    const commentPatchMatch = cleanPath.match(
      new RegExp(`${apiRoot}/issues/comments/(\\d+)$`),
    );
    if (commentPatchMatch && request.method === "PATCH") {
      const commentId = Number(commentPatchMatch[1]);
      const body = record(data);
      for (const comments of this.comments.values()) {
        const comment = comments.find((candidate) => candidate.id === commentId);
        if (comment) {
          comment.body = stringValue(body.body);
          return response(200, comment) as GitHubResponse<T>;
        }
      }
      return response(404, { message: "Comment not found" }) as GitHubResponse<T>;
    }

    const labelsMatch = cleanPath.match(new RegExp(`${apiRoot}/issues/(\\d+)/labels$`));
    if (labelsMatch && (request.method === "POST" || request.method === "PUT")) {
      const issue = this.issues.get(Number(labelsMatch[1]));
      if (!issue) return response(404, { message: "Issue not found" }) as GitHubResponse<T>;
      const body = record(data);
      const labels = arrayOfStrings(body.labels);
      if (request.method === "PUT") issue.labels = new Set(labels);
      else for (const label of labels) issue.labels.add(label);
      return response(200, [...issue.labels].map((name) => ({ name }))) as GitHubResponse<T>;
    }

    const issueMatch = cleanPath.match(new RegExp(`${apiRoot}/issues/(\\d+)$`));
    if (issueMatch) {
      const issue = this.issues.get(Number(issueMatch[1]));
      if (!issue) return response(404, { message: "Issue not found" }) as GitHubResponse<T>;
      if (request.method === "GET")
        return response(200, {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: [...issue.labels].map((name) => ({ name })),
        }) as GitHubResponse<T>;
      if (request.method === "PATCH") {
        issue.state = "closed";
        this.issueCloseCount += 1;
        return response(200, {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: [...issue.labels].map((name) => ({ name })),
        }) as GitHubResponse<T>;
      }
    }

    if (cleanPath === `${apiRoot}/pulls` && request.method === "GET") {
      const query = new URLSearchParams(request.path.split("?", 2)[1] ?? "");
      const head = query.get("head");
      const pull = [...this.pulls.values()].find(
        (candidate) => !head || candidate.head.ref === head,
      );
      return response(200, pull ? [pull] : []) as GitHubResponse<T>;
    }

    if (cleanPath === `${apiRoot}/pulls` && request.method === "POST") {
      const body = record(data);
      const headRef = stringValue(body.head);
      const baseRef = stringValue(body.base);
      const number = this.nextPullNumber++;
      const pull: FakePull = {
        number,
        html_url: `https://github.com/${repository}/pull/${number}`,
        state: "open",
        merged: false,
        head: { sha: this.branchHeads.get(headRef) ?? headSha, ref: headRef },
        base: { sha: baseSha, ref: baseRef },
        mergeable: true,
      };
      this.pulls.set(number, pull);
      return response(201, pull) as GitHubResponse<T>;
    }

    const mergeMatch = cleanPath.match(new RegExp(`${apiRoot}/pulls/(\\d+)/merge$`));
    if (mergeMatch && request.method === "PUT") {
      const pull = this.pulls.get(Number(mergeMatch[1]));
      if (!pull) return response(404, { message: "Pull request not found" }) as GitHubResponse<T>;
      const body = record(data);
      if (pull.head.sha !== stringValue(body.sha))
        return response(409, { message: "stale head" }) as GitHubResponse<T>;
      if (pull.merged)
        return response(200, { merged: true, sha: pull.head.sha, message: "Already merged" }) as GitHubResponse<T>;
      pull.merged = true;
      pull.state = "closed";
      this.mergeCount += 1;
      return response(200, {
        merged: true,
        sha: `merge-${pull.number}`,
        message: "Merged",
      }) as GitHubResponse<T>;
    }

    const pullMatch = cleanPath.match(new RegExp(`${apiRoot}/pulls/(\\d+)$`));
    if (pullMatch && request.method === "GET") {
      const pull = this.pulls.get(Number(pullMatch[1]));
      return pull
        ? (response(200, pull) as GitHubResponse<T>)
        : (response(404, { message: "Pull request not found" }) as GitHubResponse<T>);
    }

    throw new Error(`Unexpected fake GitHub request ${request.method} ${request.path}`);
  }
}

function response<T>(status: number, data: T): GitHubResponse<T> {
  return { status, data, headers: {} };
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected an object in fake request.");
  return value as JsonRecord;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a string in fake request.");
  return value;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new TypeError("Expected a string array in fake request.");
  return [...value] as string[];
}

function installFetch(server: FakeGitHub): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0)
      body = JSON.parse(init.body);
    const result = await server.request({
      method: (init?.method ?? "GET") as GitHubRequest["method"],
      path: `${url.pathname}${url.search}`,
      ...(body === undefined ? {} : { body }),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    return {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      headers: {
        forEach(callback: (value: string, key: string) => void): void {
          for (const [key, value] of Object.entries(result.headers)) callback(value, key);
        },
      },
      text: async () => (result.data === undefined ? "" : JSON.stringify(result.data)),
    } as unknown as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

async function createGitRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forgedock-work-on-"));
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "ForgeDock Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "forgedock-test@example.invalid"], {
    cwd: root,
  });
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

async function writePolicy(root: string): Promise<void> {
  await mkdir(join(root, ".forge"), { recursive: true });
  await writeFile(
    join(root, ".forge", "config.json"),
    `${JSON.stringify(
      {
        schema: "forgedock.config/v1",
        repository: { provider: "github", name: repository },
        state: { branch: stateBranch, leaseSeconds: 3600, heartbeatSeconds: 60 },
        branches: {
          integration: ["staging"],
          protected: ["main"],
          autoMergeIntegration: true,
        },
        verification: {
          commands: {
            test: {
              argv: ["node", "-e", "process.exit(0)"],
              required: true,
              timeoutMs: 30_000,
            },
          },
        },
        review: {
          required: ["forge-review-correctness", "forge-review-security"],
          maxRounds: 3,
        },
        subagents: { maxConcurrent: 2, maxDepth: 2 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function initializeRun(
  server: FakeGitHub,
  currentRunId = runId,
): Promise<{ store: GitHubStateBranchStore; journal: RunJournal }> {
  const store = new GitHubStateBranchStore(server, repository, stateBranch);
  const journal = new RunJournal(store);
  await journal.initialize({
    runId: currentRunId,
    repository,
    issueNumber,
    integrationBranch: "staging",
    protectedBranch: "main",
    sessionId,
    leaseSeconds: 3600,
    now: new Date("2099-01-01T00:00:00.000Z"),
  });
  return { store, journal };
}

const phases = [
  "resolve",
  "investigate",
  "plan",
  "prepare-worktree",
  "implement",
  "verify",
  "review",
] as const;

async function completeChildPhases(
  journal: RunJournal,
  currentRunId = runId,
): Promise<void> {
  for (const phase of phases) {
    await journal.append({
      runId: currentRunId,
      type: "phase.queued",
      payload: { phase, attempt: 1, restartAction: `resume ${phase}` },
      idempotencyKey: `phase:${phase}:1:queue`,
      sessionId,
      message: `Queue ${phase}`,
    });
    await journal.append({
      runId: currentRunId,
      type: "phase.started",
      payload: { phase, attempt: 1, logicalNodeId: `${phase}-1` },
      idempotencyKey: `phase:${phase}:1:start`,
      sessionId,
      message: `Start ${phase}`,
    });
    await journal.append({
      runId: currentRunId,
      type: "phase.completed",
      payload: { phase, attempt: 1, evidence: [`${phase} complete`] },
      idempotencyKey: `phase:${phase}:1:complete`,
      sessionId,
      message: `Complete ${phase}`,
    });
  }
}

async function replaceLease(
  store: GitHubStateBranchStore,
  currentRunId: string,
  lease: RepositoryLease,
): Promise<void> {
  const current = await store.readRun(currentRunId);
  assert.ok(current.state);
  await store.commitRunState({
    expectedTip: current.tip,
    events: current.events,
    state: current.state,
    lease,
    message: "Inject deterministic lease state",
  });
}

interface ToolRegistration {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown,
  ) => Promise<unknown>;
}

class EventBus {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload);
  }
}

class ControllerEventBus extends EventBus {
  statusPayload: unknown;

  constructor(statusPayload: unknown) {
    super();
    this.statusPayload = statusPayload;
  }

  override emit(event: string, payload: unknown): void {
    if (event === "subagents:rpc:v1:request") {
      const request = record(payload);
      const method = stringValue(request.method);
      const data =
        method === "ping"
          ? { events: { asyncComplete: "subagents:async-complete" }, capabilities: {} }
          : method === "status"
            ? this.statusPayload
            : {};
      super.emit(`subagents:rpc:v1:reply:${stringValue(request.requestId)}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data,
      });
      return;
    }
    super.emit(event, payload);
  }
}

function childPi(root: string, tools: Map<string, ToolRegistration>): {
  pi: ExtensionAPI;
  handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
} {
  const bus = new EventBus();
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const pi = {
    events: bus,
    on(event: string, handler: (...args: unknown[]) => unknown): () => void {
      const entries = handlers.get(event) ?? [];
      entries.push(handler);
      handlers.set(event, entries);
      return () => undefined;
    },
    registerTool(tool: unknown): void {
      const registration = tool as ToolRegistration;
      tools.set(registration.name, registration);
    },
    exec: async (
      command: string,
      args: readonly string[],
      options?: { cwd?: string },
    ): Promise<{ stdout: string; stderr: string; code: number }> => {
      if (command === "gh") return { stdout: "deterministic-token\n", stderr: "", code: 0 };
      if (command === "git" && args.some((argument) => argument === "push"))
        return { stdout: "pushed\n", stderr: "", code: 0 };
      try {
        const result = await execFileAsync(command, [...args], {
          cwd: options?.cwd ?? root,
          encoding: "utf8",
        });
        return {
          stdout: String(result.stdout),
          stderr: String(result.stderr),
          code: 0,
        };
      } catch (error) {
        const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
        return {
          stdout: String(failure.stdout ?? ""),
          stderr: String(failure.stderr ?? error),
          code: typeof failure.code === "number" ? failure.code : 1,
        };
      }
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function phaseContext(): { sessionManager: { getSessionId: () => string } } {
  return { sessionManager: { getSessionId: () => sessionId } };
}

async function checkpoint(
  tool: ToolRegistration,
  phase: string,
  action: string,
  extras: Record<string, unknown> = {},
): Promise<unknown> {
  return tool.execute(
    `${phase}-${action}`,
    { phase, attempt: 1, action, ...extras },
    undefined,
    undefined,
    phaseContext(),
  );
}

function reviewerResult(
  reviewer: string,
  currentRunId: string,
  currentHeadSha: string,
): ForgeReviewerResult {
  return {
    schema: "forgedock.reviewer-result/v1",
    runId: currentRunId,
    reviewer,
    headSha: currentHeadSha,
    verdict: "pass",
    findings: [],
    filesReviewed: ["change.txt"],
    limitations: [],
  };
}

function childReports(): Record<string, string> {
  return {
    investigate: `<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: CONFIRMED
**Confidence**: High
**Severity**: Medium
**Task Type**: Enhancement

### What Was Claimed

The lifecycle needed deterministic coverage.

### What We Found

The composed boundary was untested.

### Root Cause

No integration fixture existed.

### Affected Files

- \`src/workflows/work-on.ts\`

### Evidence

- Deterministic fake request trace.

### History Findings

- Existing tests were unit and adapter scoped.

### Recommendation

Compose child and parent boundaries.

### Related Issues

None.

### Decomposition Assessment

Single concern.

### Acceptance Spec

- [ ] State and side effects are asserted.

<!-- INVESTIGATION:COMPLETE -->`,
    plan: `<!-- FORGE:CONTRACT -->
## Builder Contract

Bounded integration coverage.

<!-- FORGE:CONTEXT -->
## Implementation Context

Deterministic fake dependencies.

<!-- FORGE:CONTEXT:COMPLETE -->
<!-- FORGE:ARCHITECT -->
## Implementation Plan

Drive the registered Forge tools.

<!-- FORGE:ARCHITECT:COMPLETE -->`,
    implement: `<!-- FORGE:BUILDER -->
## Implementation Complete

**Branch**: \`forge/test\`
**Commits**: \`test\`
**Files changed**: \`test/integration/work-on.test.ts\`

### Approach

Use deterministic adapters and disposable files.

### Changes

- Added lifecycle assertions.

### Acceptance Criteria Status

- [x] Child and parent paths covered.

### Testing Checklist

- [x] No live GitHub dependency.
`,
    verify: `<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — PASSED

- [x] Required deterministic checks passed.
- [x] Result identity is bound to the run.

<!-- FORGE:ACCEPTANCE_GATE:PASSED -->`,
  };
}

function issueAuditMarkers(): string[] {
  return [
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
  ];
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

interface ControllerFixture {
  server: FakeGitHub;
  store: GitHubStateBranchStore;
  root: string;
  worktreePath: string;
  controller: ForgeWorkOnController;
  bus: ControllerEventBus;
  link: ActiveRunLink;
  notifications: string[];
  gitCalls: string[][];
}

async function controllerFixture(options: {
  pullHeadSha?: string;
  expiredLease?: boolean;
  failPullArtifact?: boolean;
} = {}): Promise<ControllerFixture & { restoreFetch: () => void }> {
  const root = await createGitRepository();
  await writePolicy(root);
  const worktreePath = join(root, "owned-worktree");
  await mkdir(worktreePath, { recursive: true });
  const server = new FakeGitHub();
  server.branchHeads.set(branch, headSha);
  const restoreFetch = installFetch(server);
  const { store, journal } = await initializeRun(server);
  await completeChildPhases(journal);
  for (const marker of issueAuditMarkers()) server.addComment(issueNumber, marker);
  const pullNumber = server.addPull({
    number: 19,
    headSha: options.pullHeadSha ?? headSha,
    headRef: branch,
    baseSha,
    baseRef: "staging",
  });
  server.addComment(pullNumber, "<!-- FORGE:REVIEW_ROUTE mode=single-pr sha=head-sha-3 -->");
  if (options.failPullArtifact)
    server.failNext("POST", `/issues/${pullNumber}/comments`);

  if (options.expiredLease) {
    const current = await store.readRun(runId);
    assert.ok(current.lease);
    await replaceLease(store, runId, {
      ...current.lease,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
  }

  const result: ForgeWorkOnResult = {
    schema: "forgedock.work-on-result/v1",
    runId,
    issueNumber,
    status: "ready-for-merge",
    branch,
    baseSha,
    headSha,
    changedFiles: ["src/example.ts"],
    verification: [{ name: "test", status: "passed", exitCode: 0 }],
    review: {
      headSha,
      rounds: 1,
      completedReviewers: ["forge-review-correctness", "forge-review-security"],
      reviewerResults: [
        reviewerResult("forge-review-correctness", runId, headSha),
        reviewerResult("forge-review-security", runId, headSha),
      ],
      findings: [],
    },
    residualRisks: [],
  };
  const bus = new ControllerEventBus(result);
  const notifications: string[] = [];
  const gitCalls: string[][] = [];
  const pi = {
    events: bus,
    on: () => () => undefined,
    appendEntry: () => undefined,
    exec: async (command: string, args: readonly string[]) => {
      if (command === "gh") return { stdout: "deterministic-token\n", stderr: "", code: 0 };
      gitCalls.push([command, ...args]);
      if (args.includes("status")) return { stdout: "", stderr: "", code: 0 };
      if (args.includes("rev-parse")) return { stdout: `${headSha}\n`, stderr: "", code: 0 };
      if (args.includes("diff")) return { stdout: "src/example.ts\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  } as unknown as ExtensionAPI;
  const controller = new ForgeWorkOnController(pi);
  const link: ActiveRunLink = {
    forgeRunId: runId,
    subagentRunId: "child-run-3",
    issueNumber,
    repository,
    stateBranch,
    resultPath: join(worktreePath, ".pi", "forge", "result.json"),
    prepared: {
      repositoryRoot: root,
      worktreePath,
      branch,
      baseBranch: "staging",
      baseSha,
    },
    status: "running",
  };
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [
        { type: "custom", customType: "forgedock-run-link/v1", data: link },
      ],
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => undefined,
    },
  } as unknown as ExtensionContext;
  await controller.attach(ctx);
  return { server, store, root, worktreePath, controller, bus, link, notifications, gitCalls, restoreFetch };
}

async function finishControllerFixture(
  fixture: ControllerFixture & { restoreFetch: () => void },
  duplicate = false,
): Promise<void> {
  fixture.bus.emit("subagents:async-complete", { runId: fixture.link.subagentRunId });
  if (duplicate)
    fixture.bus.emit("subagents:async-complete", { runId: fixture.link.subagentRunId });
  await waitFor(
    () => fixture.controller.listRuns()[0]?.status !== "running",
    "controller finalization",
  );
}

test("child runtime drives checkpoints, verification, PR preparation, and result persistence", async () => {
  const root = await createGitRepository();
  const server = new FakeGitHub();
  const restoreFetch = installFetch(server);
  const tools = new Map<string, ToolRegistration>();
  const { pi, handlers } = childPi(root, tools);
  const binding = {
    runId,
    resultPath: join(root, ".pi", "forge", `${runId}-work-on.json`),
    repository,
    issueNumber,
    leaseEpoch: 1,
    stateBranch,
    worktreeRoot: root,
    branch,
    baseBranch: "staging",
    baseSha,
    maxReviewRounds: 3,
    verificationCommands: {
      test: {
        argv: [process.execPath, "-e", "process.exit(0)"],
        required: true,
        timeoutMs: 30_000,
      },
    },
  };
  const previousBinding = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "forgedock.pi/1": binding });
  try {
    const { store } = await initializeRun(server);
    forgeChildRuntime(pi);
    const startHandlers = handlers.get("session_start") ?? [];
    for (const handler of startHandlers)
      await handler(undefined, { cwd: root, sessionManager: { getSessionId: () => sessionId } });
    const checkpointTool = tools.get("forge_checkpoint");
    assert.ok(checkpointTool);

    await checkpoint(checkpointTool, "resolve", "queue", {
      restartAction: "resume resolve",
    });
    await checkpoint(checkpointTool, "resolve", "start", {
      logicalNodeId: "resolve-1",
    });
    await checkpoint(checkpointTool, "resolve", "complete", {
      report: "## Resolve Complete\n\nDeterministic fixture resolved.",
      evidence: ["fixture"],
    });

    await checkpoint(checkpointTool, "investigate", "queue", {
      restartAction: "resume investigate",
    });
    await checkpoint(checkpointTool, "investigate", "start", {
      logicalNodeId: "investigate-1",
    });
    await checkpoint(checkpointTool, "investigate", "complete", {
      report: childReports().investigate,
      evidence: ["investigation report"],
    });

    await checkpoint(checkpointTool, "plan", "queue", {
      restartAction: "resume plan",
    });
    await checkpoint(checkpointTool, "plan", "start", {
      logicalNodeId: "plan-1",
    });
    await assert.rejects(
      checkpoint(checkpointTool, "plan", "complete", { report: "malformed" }),
      /missing canonical ForgeDock fields/,
    );
    const malformedState = await store.readRun(runId);
    assert.equal(malformedState.state?.phases.plan?.attempts.at(-1)?.status, "running");
    await checkpoint(checkpointTool, "plan", "complete", {
      report: childReports().plan,
      evidence: ["builder contract", "architecture plan"],
    });

    const reports = childReports();
    for (const phase of ["prepare-worktree", "implement", "verify", "review"] as const) {
      await checkpoint(checkpointTool, phase, "queue", {
        restartAction: `resume ${phase}`,
      });
      await checkpoint(checkpointTool, phase, "start", {
        logicalNodeId: `${phase}-1`,
      });
      await checkpoint(checkpointTool, phase, "complete", {
        report:
          phase === "implement"
            ? reports.implement
            : phase === "verify"
              ? reports.verify
              : `## ${phase} Complete\n\nFixture phase completed.`,
        evidence: [`${phase} evidence`],
      });
    }

    const verifyTool = tools.get("forge_verify");
    assert.ok(verifyTool);
    const verification = (await verifyTool.execute("verify", { name: "test" })) as {
      details?: { status?: string; exitCode?: number };
    };
    assert.equal(verification.details?.status, "passed");

    await writeFile(join(root, "change.txt"), "deterministic change\n", "utf8");
    const commitTool = tools.get("forge_commit");
    assert.ok(commitTool);
    const commit = (await commitTool.execute("commit", { kind: "implementation" })) as {
      details?: { headSha?: string };
    };
    assert.match(commit.details?.headSha ?? "", /^[0-9a-f]{40}$/);
    server.branchHeads.set(branch, commit.details?.headSha ?? headSha);

    const prepareTool = tools.get("forge_prepare_review");
    assert.ok(prepareTool);
    const prepared = (await prepareTool.execute("prepare", {})) as {
      details?: { pullNumber?: number; headSha?: string };
    };
    assert.equal(prepared.details?.headSha, commit.details?.headSha);
    assert.equal(server.pulls.size, 1);
    assert.equal(
      server.commentsFor(issueNumber).some((comment) => comment.body.includes("<!-- FORGE:REVIEW_STARTED -->")),
      true,
    );

    const resultTool = tools.get("forge_finalize_work_on");
    assert.ok(resultTool);
    const childResult = {
      schema: "forgedock.work-on-result/v1",
      runId,
      issueNumber,
      status: "ready-for-merge",
      branch,
      baseSha,
      headSha: commit.details?.headSha ?? headSha,
      changedFiles: ["change.txt"],
      verification: [{ name: "test", status: "passed", exitCode: 0 }],
      review: {
        headSha: commit.details?.headSha ?? headSha,
        rounds: 1,
        completedReviewers: ["forge-review-correctness", "forge-review-security"],
        reviewerResults: [
          reviewerResult("forge-review-correctness", runId, commit.details?.headSha ?? headSha),
          reviewerResult("forge-review-security", runId, commit.details?.headSha ?? headSha),
        ],
        findings: [],
      },
      residualRisks: [],
    };
    await resultTool.execute("result", { value: childResult });
    const persisted = JSON.parse(await readFile(binding.resultPath, "utf8")) as JsonRecord;
    assert.equal(persisted.schema, "forgedock.work-on-result/v1");
    assert.equal(persisted.runId, runId);

    const current = await store.readRun(runId);
    assert.equal(current.state?.phases.plan?.attempts.at(-1)?.status, "completed");
    assert.equal(current.state?.phases.review?.attempts.at(-1)?.status, "completed");
    const beforeStaleCheckpoint = current.state?.sequence;
    assert.ok(current.lease);
    await replaceLease(store, runId, { ...current.lease, epoch: 2 });
    await assert.rejects(
      checkpoint(checkpointTool, "merge", "queue", { restartAction: "resume merge" }),
      /lease epoch 1 no longer owns/,
    );
    const afterStaleCheckpoint = await store.readRun(runId);
    assert.equal(afterStaleCheckpoint.state?.sequence, beforeStaleCheckpoint);
  } finally {
    if (previousBinding === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previousBinding;
    restoreFetch();
    await rm(root, { recursive: true, force: true });
  }
});

test("controller finalization reuses a PR and serializes duplicate completion notifications", async () => {
  const fixture = await controllerFixture();
  try {
    await finishControllerFixture(fixture, true);
    assert.equal(fixture.controller.listRuns()[0]?.status, "completed");
    assert.equal(fixture.server.mergeCount, 1);
    assert.equal(fixture.server.issueCloseCount, 1);
    assert.equal(fixture.server.requests.filter((request) => request.method === "POST" && request.path.endsWith("/pulls")).length, 0);
    assert.equal(fixture.gitCalls.filter((call) => call.includes("--set-upstream")).length, 1);
    assert.equal(fixture.gitCalls.filter((call) => call.includes("--delete")).length, 1);
    assert.equal(fixture.server.issues.get(issueNumber)?.state, "closed");
    assert.equal(fixture.server.issues.get(issueNumber)?.labels.has("workflow:merged"), true);

    const state = await fixture.store.readRun(runId);
    assert.equal(state.state?.status, "completed");
    assert.equal(state.state?.outcome, "merged");
    assert.equal(state.lease, undefined);
    for (const phase of ["merge", "close", "cleanup"] as const)
      assert.equal(state.state?.phases[phase]?.attempts.at(-1)?.status, "completed");
    assert.equal(state.state?.effects[`branch:${branch}`]?.effectType, "push");
    assert.equal(state.state?.effects[`pr:19`]?.effectType, "pull-request");
    assert.equal(state.state?.effects[`pr:19:merge`]?.effectType, "merge");
    assert.equal(state.state?.effects[`issue:${issueNumber}:close`]?.effectType, "issue-close");
    assert.equal(state.state?.effects[`worktree:${runId}`]?.effectType, "cleanup");
    assert.equal(
      fixture.server.commentsFor(19).filter((comment) => comment.body.includes("<!-- FORGE:REVIEW-AGENT:correctness -->")).length,
      1,
    );
    assert.equal(
      fixture.server.commentsFor(19).filter((comment) => comment.body.includes("<!-- FORGE:DECISION_RECORD -->")).length,
      1,
    );
    assert.equal(fixture.notifications.some((message) => message.includes("merged through PR #19")), true);
  } finally {
    fixture.restoreFetch();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("controller blocks an expired lease before merge and preserves the owned worktree", async () => {
  const fixture = await controllerFixture({ expiredLease: true });
  try {
    await finishControllerFixture(fixture);
    assert.equal(fixture.controller.listRuns()[0]?.status, "failed");
    assert.equal(fixture.server.mergeCount, 0);
    assert.equal(fixture.server.issueCloseCount, 0);
    assert.equal(fixture.server.issues.get(issueNumber)?.state, "open");
    const state = await fixture.store.readRun(runId);
    assert.equal(state.state?.phases.merge?.attempts.at(-1)?.status, "blocked");
    assert.equal(state.state?.phases.close, undefined);
    assert.equal(state.state?.phases.cleanup, undefined);
    assert.equal(fixture.notifications.some((message) => message.includes("not merged")), true);
  } finally {
    fixture.restoreFetch();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("controller fails closed when the reviewed PR head is stale", async () => {
  const fixture = await controllerFixture({ pullHeadSha: "different-head" });
  try {
    await finishControllerFixture(fixture);
    assert.equal(fixture.controller.listRuns()[0]?.status, "failed");
    assert.equal(fixture.server.mergeCount, 0);
    const state = await fixture.store.readRun(runId);
    assert.equal(state.state?.phases.merge?.attempts.at(-1)?.status, "blocked");
    assert.match(fixture.notifications.find((message) => message.includes("not merged")) ?? "", /stale/);
  } finally {
    fixture.restoreFetch();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("finalization records push and PR effects before a transient review projection failure", async () => {
  const fixture = await controllerFixture({ failPullArtifact: true });
  try {
    await finishControllerFixture(fixture);
    assert.equal(fixture.controller.listRuns()[0]?.status, "failed");
    assert.equal(fixture.server.mergeCount, 0);
    assert.equal(fixture.server.issueCloseCount, 0);
    const state = await fixture.store.readRun(runId);
    assert.equal(state.state?.effects[`branch:${branch}`]?.effectType, "push");
    assert.equal(state.state?.effects[`pr:19`]?.effectType, "pull-request");
    assert.equal(state.state?.phases.merge?.attempts.at(-1)?.status, "running");
    assert.equal(state.state?.phases.close, undefined);
  } finally {
    fixture.restoreFetch();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("projection retry is marker-idempotent after a transient GitHub failure", async () => {
  const server = new FakeGitHub();
  const restoreFetch = installFetch(server);
  try {
    server.failNext("POST", `/issues/${issueNumber}/comments`);
    const projector = new GitHubIssueProjector(server, repository);
    await assert.rejects(
      projector.postArtifact({
        issueNumber,
        runId,
        eventId: "event-retry",
        artifactKey: "retry-evidence",
        markdown: "Retryable artifact",
      }),
      /GitHub API 500/,
    );
    const first = await projector.postArtifact({
      issueNumber,
      runId,
      eventId: "event-retry",
      artifactKey: "retry-evidence",
      markdown: "Retryable artifact",
    });
    const second = await projector.postArtifact({
      issueNumber,
      runId,
      eventId: "event-retry",
      artifactKey: "retry-evidence",
      markdown: "Retryable artifact",
    });
    assert.equal(first, second);
    assert.equal(
      server.commentsFor(issueNumber).filter((comment) => comment.body.includes("retry-evidence")).length,
      1,
    );
  } finally {
    restoreFetch();
  }
});
