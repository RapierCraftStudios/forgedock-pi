import {
  GitHubApiError,
  type GitHubTransport,
  repositoryApiPath,
  requireGitHubSuccess,
} from "./github-api.ts";

export interface GitHubIssueData {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: readonly string[];
  htmlUrl?: string;
}

export interface GitHubPullRequestData {
  number: number;
  htmlUrl: string;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  mergeability: "mergeable" | "conflicting" | "unknown";
}

export interface MergeResult {
  merged: boolean;
  sha: string;
  message: string;
}

export interface GitHubCiCheck {
  name: string;
  required: boolean;
  status: "passed" | "failed" | "unknown";
  detailsUrl?: string;
}

export interface GitHubCiResult {
  headSha: string;
  checks: readonly GitHubCiCheck[];
  requiredContexts: readonly string[];
  configuredWorkflowCount: number;
  timedOut: boolean;
}

interface IssueApiResponse {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<string | { name: string }>;
  html_url?: string;
  pull_request?: unknown;
}

interface PullApiResponse {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  mergeable: boolean | null;
}

interface MergeApiResponse {
  merged: boolean;
  sha: string | null;
  message: string;
}

interface CommentApiResponse {
  id: number;
  body: string;
}

interface CheckRunsApiResponse {
  total_count: number;
  check_runs: Array<{
    name: string;
    status: "queued" | "in_progress" | "completed" | string;
    conclusion: string | null;
    details_url: string | null;
  }>;
}

interface CombinedStatusApiResponse {
  state: "pending" | "success" | "failure" | "error" | string;
  statuses: Array<{
    context: string;
    state: "pending" | "success" | "failure" | "error" | string;
    target_url: string | null;
  }>;
}

interface RequiredStatusChecksApiResponse {
  contexts?: string[];
  checks?: Array<{ context: string }>;
}

interface WorkflowsApiResponse {
  total_count: number;
  workflows: Array<{ state: string }>;
}

export class GitHubWorkflowAdapter {
  readonly #transport: GitHubTransport;
  readonly #apiRoot: string;
  readonly #repositoryOwner: string;

  constructor(transport: GitHubTransport, repository: string) {
    this.#transport = transport;
    this.#apiRoot = repositoryApiPath(repository);
    this.#repositoryOwner = repository.split("/")[0] as string;
  }

  async getIssue(
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<GitHubIssueData> {
    assertNumber(issueNumber, "issue");
    const path = `${this.#apiRoot}/issues/${issueNumber}`;
    const response = await this.#transport.request<IssueApiResponse>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    const issue = requireGitHubSuccess(response, path, [200]);
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      labels: issue.labels.map((label) =>
        typeof label === "string" ? label : label.name,
      ),
      ...(issue.html_url ? { htmlUrl: issue.html_url } : {}),
    };
  }

  async listIssuesByLabel(
    label: string,
    state: "open" | "closed" | "all" = "all",
    signal?: AbortSignal,
  ): Promise<GitHubIssueData[]> {
    const path = `${this.#apiRoot}/issues?state=${state}&labels=${encodeURIComponent(label)}&per_page=100`;
    const response = await this.#transport.request<IssueApiResponse[]>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    return requireGitHubSuccess(response, path, [200])
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        state: issue.state,
        labels: issue.labels.map((entry) =>
          typeof entry === "string" ? entry : entry.name,
        ),
        ...(issue.html_url ? { htmlUrl: issue.html_url } : {}),
      }));
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: readonly string[];
    signal?: AbortSignal;
  }): Promise<GitHubIssueData> {
    const path = `${this.#apiRoot}/issues`;
    const response = await this.#transport.request<IssueApiResponse>({
      method: "POST",
      path,
      body: {
        title: input.title,
        body: input.body,
        labels: [...input.labels],
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const issue = requireGitHubSuccess(response, path, [201]);
    const readBack = await this.getIssue(issue.number, input.signal);
    if (!readBack.body.includes("<!-- FORGE:REVIEW_FINDING"))
      throw new GitHubApiError(422, path, {
        message: "Review-finding issue read-back marker missing",
      });
    return readBack;
  }

  async commentOnIssue(
    issueNumber: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<number> {
    assertNumber(issueNumber, "issue");
    const path = `${this.#apiRoot}/issues/${issueNumber}/comments`;
    const response = await this.#transport.request<CommentApiResponse>({
      method: "POST",
      path,
      body: { body },
      ...(signal ? { signal } : {}),
    });
    return requireGitHubSuccess(response, path, [201]).id;
  }

  async findPullRequest(
    headRef: string,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestData | undefined> {
    const qualifiedHead = `${this.#repositoryOwner}:${headRef}`;
    const path = `${this.#apiRoot}/pulls?state=all&head=${encodeURIComponent(qualifiedHead)}&per_page=20`;
    const response = await this.#transport.request<PullApiResponse[]>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    const pulls = requireGitHubSuccess(response, path, [200]);
    const pull = pulls.find((candidate) => candidate.head.ref === headRef);
    return pull ? normalizePull(pull) : undefined;
  }

  async createPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    signal?: AbortSignal;
  }): Promise<GitHubPullRequestData> {
    const existing = await this.findPullRequest(input.head, input.signal);
    if (existing && existing.state === "open") {
      if (existing.baseRef !== input.base)
        throw new GitHubApiError(409, `${this.#apiRoot}/pulls/${existing.number}`, {
          message: `Existing pull request targets ${existing.baseRef}; expected ${input.base}.`,
        });
      return existing;
    }
    const path = `${this.#apiRoot}/pulls`;
    const response = await this.#transport.request<PullApiResponse>({
      method: "POST",
      path,
      body: {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: false,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return normalizePull(requireGitHubSuccess(response, path, [201]));
  }

  async getPullRequest(
    pullNumber: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestData> {
    assertNumber(pullNumber, "pull request");
    const path = `${this.#apiRoot}/pulls/${pullNumber}`;
    const response = await this.#transport.request<PullApiResponse>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    return normalizePull(requireGitHubSuccess(response, path, [200]));
  }

  async waitForPullRequestChecks(input: {
    headSha: string;
    baseBranch: string;
    timeoutMs: number;
    pollIntervalMs: number;
    signal?: AbortSignal;
  }): Promise<GitHubCiResult> {
    const startedAt = Date.now();
    const requiredContexts = await this.#requiredStatusContexts(
      input.baseBranch,
      input.signal,
    );
    const configuredWorkflowCount = await this.#configuredWorkflowCount(
      input.signal,
    );
    while (true) {
      const checks = await this.#checksForCommit(
        input.headSha,
        input.signal,
      );
      const missingRequired = requiredContexts.filter(
        (context) => !checks.some((check) => check.name === context),
      );
      const hasPending = checks.some((check) => check.status === "unknown");
      const hasFailure = checks.some((check) => check.status === "failed");
      const awaitingDiscovery =
        checks.length === 0 && configuredWorkflowCount > 0;
      if (
        hasFailure ||
        (!hasPending && missingRequired.length === 0 && !awaitingDiscovery)
      ) {
        return {
          headSha: input.headSha,
          checks: [
            ...checks,
            ...missingRequired.map((name) => ({
              name,
              required: true,
              status: "unknown" as const,
            })),
          ],
          requiredContexts,
          configuredWorkflowCount,
          timedOut: false,
        };
      }
      if (Date.now() - startedAt >= input.timeoutMs) {
        return {
          headSha: input.headSha,
          checks: [
            ...checks,
            ...missingRequired.map((name) => ({
              name,
              required: true,
              status: "unknown" as const,
            })),
            ...(checks.length === 0 && configuredWorkflowCount > 0
              ? [
                  {
                    name: "github-ci-discovery",
                    required: true,
                    status: "unknown" as const,
                  },
                ]
              : []),
          ],
          requiredContexts,
          configuredWorkflowCount,
          timedOut: true,
        };
      }
      await abortableDelay(input.pollIntervalMs, input.signal);
    }
  }

  async mergePullRequest(input: {
    pullNumber: number;
    expectedHeadSha: string;
    expectedBaseSha: string;
    expectedBaseRef: string;
    method?: "merge" | "squash" | "rebase";
    signal?: AbortSignal;
  }): Promise<MergeResult> {
    assertNumber(input.pullNumber, "pull request");
    const current = await this.getPullRequest(input.pullNumber, input.signal);
    if (
      current.headSha !== input.expectedHeadSha ||
      current.baseSha !== input.expectedBaseSha ||
      current.baseRef !== input.expectedBaseRef
    ) {
      throw new GitHubApiError(
        409,
        `${this.#apiRoot}/pulls/${input.pullNumber}/merge`,
        {
          message: `Stale reviewed pull identity ${input.expectedHeadSha}/${input.expectedBaseRef}@${input.expectedBaseSha}; current identity is ${current.headSha}/${current.baseRef}@${current.baseSha}`,
        },
      );
    }
    if (current.merged)
      return { merged: true, sha: current.headSha, message: "Already merged" };
    const path = `${this.#apiRoot}/pulls/${input.pullNumber}/merge`;
    const response = await this.#transport.request<MergeApiResponse>({
      method: "PUT",
      path,
      body: {
        sha: input.expectedHeadSha,
        merge_method: input.method ?? "squash",
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const result = requireGitHubSuccess(response, path, [200, 405, 409]);
    if (!result.merged || !result.sha)
      throw new GitHubApiError(response.status, path, result);
    return { merged: true, sha: result.sha, message: result.message };
  }

  async getComments(
    issueOrPullNumber: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return (await this.#getCommentRecords(issueOrPullNumber, signal)).map(
      (comment) => comment.body,
    );
  }

  async #getCommentRecords(
    issueOrPullNumber: number,
    signal?: AbortSignal,
  ): Promise<CommentApiResponse[]> {
    assertNumber(issueOrPullNumber, "issue or pull request");
    const path = `${this.#apiRoot}/issues/${issueOrPullNumber}/comments?per_page=100`;
    const response = await this.#transport.request<CommentApiResponse[]>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    return requireGitHubSuccess(response, path, [200]);
  }

  async postPullArtifact(input: {
    pullNumber: number;
    marker: string;
    body: string;
    signal?: AbortSignal;
  }): Promise<number> {
    assertNumber(input.pullNumber, "pull request");
    const existing = await this.#getCommentRecords(
      input.pullNumber,
      input.signal,
    );
    const existingComment = existing.find((comment) =>
      comment.body.includes(input.marker),
    );
    if (existingComment) return existingComment.id;
    const path = `${this.#apiRoot}/issues/${input.pullNumber}/comments`;
    const response = await this.#transport.request<CommentApiResponse>({
      method: "POST",
      path,
      body: { body: `${input.marker}\n${input.body.trim()}\n` },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const comment = requireGitHubSuccess(response, path, [201]);
    const readBack = await this.#getCommentRecords(
      input.pullNumber,
      input.signal,
    );
    if (
      !readBack.some(
        (candidate) =>
          candidate.id === comment.id && candidate.body.includes(input.marker),
      )
    ) {
      throw new GitHubApiError(422, path, {
        message: `Pull request artifact read-back missing ${input.marker}`,
      });
    }
    return comment.id;
  }

  async closeIssue(issueNumber: number, signal?: AbortSignal): Promise<void> {
    assertNumber(issueNumber, "issue");
    const path = `${this.#apiRoot}/issues/${issueNumber}`;
    const response = await this.#transport.request<IssueApiResponse>({
      method: "PATCH",
      path,
      body: { state: "closed", state_reason: "completed" },
      ...(signal ? { signal } : {}),
    });
    requireGitHubSuccess(response, path, [200]);
    const readBack = await this.getIssue(issueNumber, signal);
    if (readBack.state !== "closed")
      throw new GitHubApiError(422, path, {
        message: "Issue close read-back failed",
      });
  }

  async #requiredStatusContexts(
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const contexts = new Set<string>();
    const protectionPath = `${this.#apiRoot}/branches/${encodeURIComponent(baseBranch)}/protection/required_status_checks`;
    const protection =
      await this.#transport.request<RequiredStatusChecksApiResponse>({
        method: "GET",
        path: protectionPath,
        ...(signal ? { signal } : {}),
      });
    if (protection.status !== 404) {
      const required = requireGitHubSuccess(
        protection,
        protectionPath,
        [200],
      );
      for (const context of required.contexts ?? []) contexts.add(context);
      for (const check of required.checks ?? []) contexts.add(check.context);
    }

    const rulesPath = `${this.#apiRoot}/rules/branches/${encodeURIComponent(baseBranch)}`;
    const rules = await this.#transport.request<unknown>({
      method: "GET",
      path: rulesPath,
      ...(signal ? { signal } : {}),
    });
    if (rules.status !== 404) {
      const value = requireGitHubSuccess(rules, rulesPath, [200]);
      collectRequiredContexts(value, contexts);
    }
    return [...contexts].sort((left, right) => left.localeCompare(right));
  }

  async #configuredWorkflowCount(signal?: AbortSignal): Promise<number> {
    const path = `${this.#apiRoot}/actions/workflows?per_page=100`;
    const response = await this.#transport.request<WorkflowsApiResponse>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) return 0;
    const workflows = requireGitHubSuccess(response, path, [200]);
    return workflows.workflows.filter(
      (workflow) => workflow.state === "active",
    ).length;
  }

  async #checksForCommit(
    headSha: string,
    signal?: AbortSignal,
  ): Promise<GitHubCiCheck[]> {
    const checks = new Map<string, GitHubCiCheck>();
    const checkRunsPath = `${this.#apiRoot}/commits/${encodeURIComponent(headSha)}/check-runs?filter=latest&per_page=100`;
    const checkRunsResponse =
      await this.#transport.request<CheckRunsApiResponse>({
        method: "GET",
        path: checkRunsPath,
        ...(signal ? { signal } : {}),
      });
    const checkRuns = requireGitHubSuccess(
      checkRunsResponse,
      checkRunsPath,
      [200],
    );
    for (const run of checkRuns.check_runs) {
      checks.set(run.name, {
        name: run.name,
        required: true,
        status: checkRunStatus(run.status, run.conclusion),
        ...(run.details_url ? { detailsUrl: run.details_url } : {}),
      });
    }

    const statusPath = `${this.#apiRoot}/commits/${encodeURIComponent(headSha)}/status?per_page=100`;
    const statusResponse =
      await this.#transport.request<CombinedStatusApiResponse>({
        method: "GET",
        path: statusPath,
        ...(signal ? { signal } : {}),
      });
    const statuses = requireGitHubSuccess(statusResponse, statusPath, [200]);
    for (const status of statuses.statuses) {
      if (checks.has(status.context)) continue;
      checks.set(status.context, {
        name: status.context,
        required: true,
        status: legacyStatus(status.state),
        ...(status.target_url ? { detailsUrl: status.target_url } : {}),
      });
    }
    return [...checks.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }
}

function normalizePull(pull: PullApiResponse): GitHubPullRequestData {
  return {
    number: pull.number,
    htmlUrl: pull.html_url,
    state: pull.state,
    merged: pull.merged,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
    mergeability:
      pull.mergeable === true
        ? "mergeable"
        : pull.mergeable === false
          ? "conflicting"
          : "unknown",
  };
}

function checkRunStatus(
  status: string,
  conclusion: string | null,
): GitHubCiCheck["status"] {
  if (status !== "completed") return "unknown";
  if (["success", "neutral", "skipped"].includes(conclusion ?? ""))
    return "passed";
  return "failed";
}

function legacyStatus(state: string): GitHubCiCheck["status"] {
  if (state === "success") return "passed";
  if (state === "failure" || state === "error") return "failed";
  return "unknown";
}

function collectRequiredContexts(
  value: unknown,
  contexts: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectRequiredContexts(entry, contexts);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "required_status_checks") {
    const parameters = record.parameters;
    if (parameters && typeof parameters === "object") {
      const required = (parameters as Record<string, unknown>)
        .required_status_checks;
      if (Array.isArray(required)) {
        for (const entry of required) {
          if (!entry || typeof entry !== "object") continue;
          const context = (entry as Record<string, unknown>).context;
          if (typeof context === "string" && context.trim())
            contexts.add(context.trim());
        }
      }
    }
  }
  for (const entry of Object.values(record))
    collectRequiredContexts(entry, contexts);
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function assertNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${label} number must be positive.`);
}
