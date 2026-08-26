import {
  canonicalJson,
  type RunEvent,
  validateRunEvent,
} from "../core/events.ts";
import {
  type RepositoryLease,
  validateRepositoryLease,
} from "../core/lease.ts";
import {
  replayOrchestrationEvents,
  type OrchestrationEvent,
  type OrchestrationState,
} from "../core/orchestration.ts";
import { replayRunEvents, type RunState } from "../core/state.ts";
import {
  GitHubApiError,
  type GitHubResponse,
  type GitHubTransport,
  repositoryApiPath,
  requireGitHubSuccess,
} from "./github-api.ts";

const STATE_ROOT = ".forgedock";

interface GitRefResponse {
  object: { sha: string };
}

interface GitCommitResponse {
  sha: string;
  tree: { sha: string };
}

interface GitBlobResponse {
  sha: string;
  content?: string;
  encoding?: string;
}

interface GitTreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
}

interface GitTreeResponse {
  sha: string;
  tree: GitTreeEntry[];
  truncated?: boolean;
}

interface CreatedShaResponse {
  sha: string;
}

export interface RepositoryStateManifest {
  schema: "forgedock.repository-state/v1";
  repository: string;
  createdAt: string;
}

export interface ReadRunStateResult {
  tip: string;
  events: readonly RunEvent[];
  state?: RunState;
  snapshotMatchesJournal: boolean;
  lease?: RepositoryLease;
}

export interface CommitRunStateInput {
  expectedTip: string;
  events: readonly RunEvent[];
  state: RunState;
  lease?: RepositoryLease;
  preserveRepositoryLease?: boolean;
  message: string;
  signal?: AbortSignal;
}

export interface ReadOrchestrationStateResult {
  tip: string;
  events: readonly OrchestrationEvent[];
  state?: OrchestrationState;
  snapshotMatchesJournal: boolean;
  lease?: RepositoryLease;
}

export interface CommitOrchestrationStateInput {
  expectedTip: string;
  events: readonly OrchestrationEvent[];
  state: OrchestrationState;
  leaseUpdate?: RepositoryLease | null;
  message: string;
  signal?: AbortSignal;
}

export class StateBranchConflictError extends Error {
  readonly expectedTip: string;

  constructor(expectedTip: string) {
    super(`State branch changed after ${expectedTip}; reload before retrying.`);
    this.name = "StateBranchConflictError";
    this.expectedTip = expectedTip;
  }
}

export class GitHubStateBranchStore {
  readonly #transport: GitHubTransport;
  readonly #repository: string;
  readonly #apiRoot: string;
  readonly #branch: string;

  constructor(
    transport: GitHubTransport,
    repository: string,
    branch = "forgedock/state/v1",
  ) {
    if (!branch.trim()) throw new TypeError("State branch must be non-empty.");
    this.#transport = transport;
    this.#repository = repository;
    this.#apiRoot = repositoryApiPath(repository);
    this.#branch = branch;
  }

  async getTip(signal?: AbortSignal): Promise<string | undefined> {
    const path = `${this.#apiRoot}/git/ref/heads/${encodePath(this.#branch)}`;
    const response = await this.#transport.request<GitRefResponse>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) return undefined;
    return requireGitHubSuccess(response, path, [200]).object.sha;
  }

  async ensureBranch(now = new Date(), signal?: AbortSignal): Promise<string> {
    const existing = await this.getTip(signal);
    if (existing) return existing;

    const manifest: RepositoryStateManifest = {
      schema: "forgedock.repository-state/v1",
      repository: this.#repository,
      createdAt: now.toISOString(),
    };
    const blobSha = await this.#createBlob(
      `${JSON.stringify(manifest, null, 2)}\n`,
      signal,
    );
    const treeSha = await this.#createTree(
      undefined,
      [{ path: `${STATE_ROOT}/repository.json`, sha: blobSha }],
      signal,
    );
    const commitSha = await this.#createCommit(
      "Initialize ForgeDock state branch",
      treeSha,
      [],
      signal,
    );
    const path = `${this.#apiRoot}/git/refs`;
    const response = await this.#transport.request<GitRefResponse>({
      method: "POST",
      path,
      body: { ref: `refs/heads/${this.#branch}`, sha: commitSha },
      ...(signal ? { signal } : {}),
    });
    if (response.status === 201) return response.data.object.sha;
    if (response.status === 422) {
      const concurrent = await this.getTip(signal);
      if (concurrent) return concurrent;
    }
    throw new GitHubApiError(response.status, path, response.data);
  }

  async listRunIds(signal?: AbortSignal): Promise<string[]> {
    const tip = await this.getTip(signal);
    if (!tip)
      throw new GitHubApiError(
        404,
        `${this.#apiRoot}/git/ref/heads/${this.#branch}`,
        { message: "State branch missing" },
      );
    const entries = await this.#readTree(tip, signal);
    return runIdsFromTree(entries);
  }

  async listRunStates(signal?: AbortSignal): Promise<RunState[]> {
    const tip = await this.getTip(signal);
    if (!tip)
      throw new GitHubApiError(
        404,
        `${this.#apiRoot}/git/ref/heads/${this.#branch}`,
        { message: "State branch missing" },
      );
    const entries = await this.#readTree(tip, signal);
    const states: RunState[] = [];
    for (const runId of runIdsFromTree(entries)) {
      const eventText = await this.#readPath(
        entries,
        runEventsPath(runId),
        signal,
      );
      const events = parseEventJournal(eventText ?? "");
      if (events.length > 0) states.push(replayRunEvents(events));
    }
    return states;
  }

  async listOrchestrationRunStates(
    orchestrationId: string,
    leaseEpoch: number,
    signal?: AbortSignal,
  ): Promise<RunState[]> {
    assertRunId(orchestrationId);
    if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1)
      throw new TypeError("Lease epoch must be a positive safe integer.");
    const tip = await this.getTip(signal);
    if (!tip)
      throw new GitHubApiError(
        404,
        `${this.#apiRoot}/git/ref/heads/${this.#branch}`,
        { message: "State branch missing" },
      );
    const entries = await this.#readTree(tip, signal);
    const states: RunState[] = [];
    for (const runId of runIdsFromTree(entries)) {
      const eventText = await this.#readPath(
        entries,
        runEventsPath(runId),
        signal,
      );
      const events = parseEventJournal(eventText ?? "");
      const created = events[0];
      const payload = created?.payload as
        | { orchestrationRunId?: unknown; leaseEpoch?: unknown }
        | undefined;
      if (
        created?.type !== "run.created" ||
        payload?.orchestrationRunId !== orchestrationId ||
        payload.leaseEpoch !== leaseEpoch
      )
        continue;
      states.push(replayRunEvents(events));
    }
    return states;
  }

  async readRun(
    runId: string,
    signal?: AbortSignal,
  ): Promise<ReadRunStateResult> {
    assertRunId(runId);
    const tip = await this.getTip(signal);
    if (!tip)
      throw new GitHubApiError(
        404,
        `${this.#apiRoot}/git/ref/heads/${this.#branch}`,
        { message: "State branch missing" },
      );
    const entries = await this.#readTree(tip, signal);
    const eventText = await this.#readPath(
      entries,
      runEventsPath(runId),
      signal,
    );
    const snapshotText = await this.#readPath(
      entries,
      runSnapshotPath(runId),
      signal,
    );
    const leaseText = await this.#readPath(entries, leasePath(), signal);
    const events = parseEventJournal(eventText ?? "");
    const state = events.length > 0 ? replayRunEvents(events) : undefined;
    const snapshot = snapshotText
      ? parseJson(snapshotText, "run snapshot")
      : undefined;
    const snapshotMatchesJournal =
      state !== undefined && snapshot !== undefined
        ? canonicalJson(snapshot) === canonicalJson(state)
        : state === undefined && snapshot === undefined;
    let lease: RepositoryLease | undefined;
    if (leaseText) {
      const parsedLease = parseJson(leaseText, "repository lease");
      validateRepositoryLease(parsedLease);
      lease = parsedLease;
    }
    return {
      tip,
      events,
      snapshotMatchesJournal,
      ...(state ? { state } : {}),
      ...(lease ? { lease } : {}),
    };
  }

  async readOrchestration(
    orchestrationId: string,
    signal?: AbortSignal,
  ): Promise<ReadOrchestrationStateResult> {
    assertRunId(orchestrationId);
    const tip = await this.getTip(signal);
    if (!tip)
      throw new GitHubApiError(
        404,
        `${this.#apiRoot}/git/ref/heads/${this.#branch}`,
        { message: "State branch missing" },
      );
    const entries = await this.#readTree(tip, signal);
    const eventText = await this.#readPath(
      entries,
      orchestrationEventsPath(orchestrationId),
      signal,
    );
    const snapshotText = await this.#readPath(
      entries,
      orchestrationSnapshotPath(orchestrationId),
      signal,
    );
    const leaseText = await this.#readPath(entries, leasePath(), signal);
    const events = parseOrchestrationJournal(eventText ?? "");
    const state =
      events.length > 0 ? replayOrchestrationEvents(events) : undefined;
    const snapshot = snapshotText
      ? parseJson(snapshotText, "orchestration snapshot")
      : undefined;
    const snapshotMatchesJournal =
      state !== undefined && snapshot !== undefined
        ? canonicalJson(snapshot) === canonicalJson(state)
        : state === undefined && snapshot === undefined;
    let lease: RepositoryLease | undefined;
    if (leaseText) {
      const parsedLease = parseJson(leaseText, "repository lease");
      validateRepositoryLease(parsedLease);
      lease = parsedLease;
    }
    return {
      tip,
      events,
      snapshotMatchesJournal,
      ...(state ? { state } : {}),
      ...(lease ? { lease } : {}),
    };
  }

  async commitOrchestrationState(
    input: CommitOrchestrationStateInput,
  ): Promise<string> {
    if (!input.expectedTip.trim())
      throw new TypeError("expectedTip must be non-empty.");
    if (!input.message.trim())
      throw new TypeError("State commit message must be non-empty.");
    if (input.events.length === 0)
      throw new TypeError("Cannot commit an empty orchestration journal.");
    const reduced = replayOrchestrationEvents(input.events);
    if (canonicalJson(reduced) !== canonicalJson(input.state))
      throw new TypeError(
        "Orchestration snapshot does not match the supplied journal.",
      );
    if (input.state.repository !== this.#repository)
      throw new TypeError(
        "Orchestration repository does not match this store.",
      );
    if (input.leaseUpdate) {
      validateRepositoryLease(input.leaseUpdate);
      if (
        input.leaseUpdate.repository !== this.#repository ||
        input.leaseUpdate.ownerRunId !== input.state.orchestrationId ||
        input.leaseUpdate.epoch !== input.state.leaseEpoch
      ) {
        throw new TypeError(
          "Orchestration does not own the supplied repository lease.",
        );
      }
    }

    const commit = await this.#getCommit(input.expectedTip, input.signal);
    const orchestrationId = input.state.orchestrationId;
    assertRunId(orchestrationId);
    const journal = `${input.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const files = [
      { path: orchestrationEventsPath(orchestrationId), content: journal },
      {
        path: orchestrationSnapshotPath(orchestrationId),
        content: `${JSON.stringify(input.state, null, 2)}\n`,
      },
      ...(input.leaseUpdate
        ? [
            {
              path: leasePath(),
              content: `${JSON.stringify(input.leaseUpdate, null, 2)}\n`,
            },
          ]
        : []),
    ];
    const treeEntries: Array<{ path: string; sha: string | null }> =
      await Promise.all(
        files.map(async (file) => ({
          path: file.path,
          sha: await this.#createBlob(file.content, input.signal),
        })),
      );
    if (input.leaseUpdate === null)
      treeEntries.push({ path: leasePath(), sha: null });
    const treeSha = await this.#createTree(
      commit.tree.sha,
      treeEntries,
      input.signal,
    );
    const newCommit = await this.#createCommit(
      input.message,
      treeSha,
      [input.expectedTip],
      input.signal,
    );
    const refPath = `${this.#apiRoot}/git/refs/heads/${encodePath(this.#branch)}`;
    const response = await this.#transport.request<GitRefResponse>({
      method: "PATCH",
      path: refPath,
      body: { sha: newCommit, force: false },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (response.status === 409 || response.status === 422)
      throw new StateBranchConflictError(input.expectedTip);
    return requireGitHubSuccess(response, refPath, [200]).object.sha;
  }

  async commitRunState(input: CommitRunStateInput): Promise<string> {
    if (!input.expectedTip.trim())
      throw new TypeError("expectedTip must be non-empty.");
    if (!input.message.trim())
      throw new TypeError("State commit message must be non-empty.");
    if (input.events.length === 0)
      throw new TypeError("Cannot commit an empty event journal.");
    const reduced = replayRunEvents(input.events);
    if (canonicalJson(reduced) !== canonicalJson(input.state)) {
      throw new TypeError(
        "Snapshot does not match the supplied event journal.",
      );
    }
    if (
      input.state.repository !== this.#repository ||
      (input.lease && input.lease.repository !== this.#repository)
    ) {
      throw new TypeError("State/lease repository does not match this store.");
    }
    if (input.preserveRepositoryLease && input.lease)
      throw new TypeError(
        "A run cannot preserve and update the repository lease together.",
      );
    if (input.lease && input.state.runId !== input.lease.ownerRunId) {
      throw new TypeError(
        "Run state does not own the supplied repository lease.",
      );
    }
    if (input.lease) validateRepositoryLease(input.lease);
    if (Boolean(input.state.lease) !== Boolean(input.lease)) {
      throw new TypeError(
        "Snapshot lease and supplied lease presence must match.",
      );
    }
    if (input.preserveRepositoryLease && !input.state.leaseBinding)
      throw new TypeError(
        "Only an orchestration-bound run may preserve the repository lease.",
      );

    const commit = await this.#getCommit(input.expectedTip, input.signal);
    const runId = input.state.runId;
    assertRunId(runId);
    const journal = `${input.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const files = [
      { path: runEventsPath(runId), content: journal },
      {
        path: runSnapshotPath(runId),
        content: `${JSON.stringify(input.state, null, 2)}\n`,
      },
      ...(input.lease
        ? [
            {
              path: leasePath(),
              content: `${JSON.stringify(input.lease, null, 2)}\n`,
            },
          ]
        : []),
    ];
    const treeEntries: Array<{ path: string; sha: string | null }> =
      await Promise.all(
        files.map(async (file) => ({
          path: file.path,
          sha: await this.#createBlob(file.content, input.signal),
        })),
      );
    if (!input.lease && !input.preserveRepositoryLease)
      treeEntries.push({ path: leasePath(), sha: null });
    const treeSha = await this.#createTree(
      commit.tree.sha,
      treeEntries,
      input.signal,
    );
    const newCommit = await this.#createCommit(
      input.message,
      treeSha,
      [input.expectedTip],
      input.signal,
    );
    const refPath = `${this.#apiRoot}/git/refs/heads/${encodePath(this.#branch)}`;
    const response = await this.#transport.request<GitRefResponse>({
      method: "PATCH",
      path: refPath,
      body: { sha: newCommit, force: false },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (response.status === 409 || response.status === 422)
      throw new StateBranchConflictError(input.expectedTip);
    return requireGitHubSuccess(response, refPath, [200]).object.sha;
  }

  async #getCommit(
    sha: string,
    signal?: AbortSignal,
  ): Promise<GitCommitResponse> {
    const path = `${this.#apiRoot}/git/commits/${encodeURIComponent(sha)}`;
    const response = await this.#transport.request<GitCommitResponse>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    return requireGitHubSuccess(response, path, [200]);
  }

  async #createBlob(content: string, signal?: AbortSignal): Promise<string> {
    const path = `${this.#apiRoot}/git/blobs`;
    const response = await this.#transport.request<CreatedShaResponse>({
      method: "POST",
      path,
      body: { content, encoding: "utf-8" },
      ...(signal ? { signal } : {}),
    });
    return requireGitHubSuccess(response, path, [201]).sha;
  }

  async #createTree(
    baseTree: string | undefined,
    entries: readonly { path: string; sha: string | null }[],
    signal?: AbortSignal,
  ): Promise<string> {
    const path = `${this.#apiRoot}/git/trees`;
    const response = await this.#transport.request<CreatedShaResponse>({
      method: "POST",
      path,
      body: {
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: entries.map((entry) => ({
          path: entry.path,
          mode: "100644",
          type: "blob",
          sha: entry.sha,
        })),
      },
      ...(signal ? { signal } : {}),
    });
    return requireGitHubSuccess(response, path, [201]).sha;
  }

  async #createCommit(
    message: string,
    tree: string,
    parents: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const path = `${this.#apiRoot}/git/commits`;
    const response = await this.#transport.request<CreatedShaResponse>({
      method: "POST",
      path,
      body: { message: sanitizeStateCommitMessage(message), tree, parents },
      ...(signal ? { signal } : {}),
    });
    return requireGitHubSuccess(response, path, [201]).sha;
  }

  async #readTree(
    commitSha: string,
    signal?: AbortSignal,
  ): Promise<GitTreeEntry[]> {
    const commit = await this.#getCommit(commitSha, signal);
    const path = `${this.#apiRoot}/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`;
    const response = await this.#transport.request<GitTreeResponse>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    const tree = requireGitHubSuccess(response, path, [200]);
    if (tree.truncated)
      throw new GitHubApiError(422, path, {
        message: "State tree response was truncated",
      });
    return tree.tree;
  }

  async #readPath(
    entries: readonly GitTreeEntry[],
    pathName: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const entry = entries.find(
      (candidate) => candidate.path === pathName && candidate.type === "blob",
    );
    if (!entry) return undefined;
    const path = `${this.#apiRoot}/git/blobs/${encodeURIComponent(entry.sha)}`;
    const response = await this.#transport.request<GitBlobResponse>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    const blob = requireGitHubSuccess(response, path, [200]);
    if (blob.encoding !== "base64" || typeof blob.content !== "string") {
      throw new GitHubApiError(422, path, {
        message: "Expected a base64 Git blob",
      });
    }
    return Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString(
      "utf8",
    );
  }
}

function parseEventJournal(text: string): RunEvent[] {
  if (!text.trim()) return [];
  return text
    .trimEnd()
    .split("\n")
    .map((line, index) => {
      const value = parseJson(line, `event journal line ${index + 1}`);
      validateRunEvent(value);
      return value;
    });
}

function parseOrchestrationJournal(text: string): OrchestrationEvent[] {
  if (!text.trim()) return [];
  return text
    .trimEnd()
    .split("\n")
    .map((line, index) => {
      const value = parseJson(
        line,
        `orchestration journal line ${index + 1}`,
      );
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value as { schema?: unknown }).schema !==
          "forgedock.orchestration-event/v1"
      ) {
        throw new TypeError("Invalid orchestration event journal entry.");
      }
      return value as unknown as OrchestrationEvent;
    });
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function parseJson(text: string, label: string): JsonValue {
  try {
    const value: unknown = JSON.parse(text);
    if (!isJsonValue(value)) throw new TypeError("value is not plain JSON");
    return value;
  } catch (error) {
    throw new TypeError(
      `Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function sanitizeStateCommitMessage(message: string): string {
  return message.replace(/#(?=\d)/g, "");
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId))
    throw new TypeError("Run ID contains unsafe path characters.");
}

function runIdsFromTree(entries: readonly GitTreeEntry[]): string[] {
  const runIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const match = /^\.forgedock\/runs\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/events\.ndjson$/.exec(
      entry.path,
    );
    if (match?.[1]) runIds.add(match[1]);
  }
  return [...runIds].sort();
}

function runEventsPath(runId: string): string {
  return `${STATE_ROOT}/runs/${runId}/events.ndjson`;
}

function runSnapshotPath(runId: string): string {
  return `${STATE_ROOT}/runs/${runId}/snapshot.json`;
}

function orchestrationEventsPath(orchestrationId: string): string {
  return `${STATE_ROOT}/orchestrations/${orchestrationId}/events.ndjson`;
}

function orchestrationSnapshotPath(orchestrationId: string): string {
  return `${STATE_ROOT}/orchestrations/${orchestrationId}/snapshot.json`;
}

function leasePath(): string {
  return `${STATE_ROOT}/locks/repository.json`;
}

export type { GitHubResponse };
