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

interface IssueApiResponse {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<string | { name: string }>;
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

export class GitHubWorkflowAdapter {
  readonly #transport: GitHubTransport;
  readonly #apiRoot: string;

  constructor(transport: GitHubTransport, repository: string) {
    this.#transport = transport;
    this.#apiRoot = repositoryApiPath(repository);
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
    };
  }

  async findPullRequest(
    headRef: string,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestData | undefined> {
    const path = `${this.#apiRoot}/pulls?state=all&head=${encodeURIComponent(headRef)}&per_page=20`;
    const response = await this.#transport.request<PullApiResponse[]>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    const pulls = requireGitHubSuccess(response, path, [200]);
    const pull = pulls[0];
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
    if (existing && existing.state === "open") return existing;
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

  async mergePullRequest(input: {
    pullNumber: number;
    expectedHeadSha: string;
    method?: "merge" | "squash" | "rebase";
    signal?: AbortSignal;
  }): Promise<MergeResult> {
    assertNumber(input.pullNumber, "pull request");
    const current = await this.getPullRequest(input.pullNumber, input.signal);
    if (current.merged)
      return { merged: true, sha: current.headSha, message: "Already merged" };
    if (current.headSha !== input.expectedHeadSha) {
      throw new GitHubApiError(
        409,
        `${this.#apiRoot}/pulls/${input.pullNumber}/merge`,
        {
          message: `Stale reviewed SHA ${input.expectedHeadSha}; current head is ${current.headSha}`,
        },
      );
    }
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
    assertNumber(issueOrPullNumber, "issue or pull request");
    const path = `${this.#apiRoot}/issues/${issueOrPullNumber}/comments?per_page=100`;
    const response = await this.#transport.request<CommentApiResponse[]>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    return requireGitHubSuccess(response, path, [200]).map(
      (comment) => comment.body,
    );
  }

  async postPullArtifact(input: {
    pullNumber: number;
    marker: string;
    body: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<number> {
    assertNumber(input.pullNumber, "pull request");
    const existing = await this.getComments(input.pullNumber, input.signal);
    const existingIndex = existing.findIndex((body) =>
      body.includes(input.marker),
    );
    if (existingIndex >= 0) return existingIndex + 1;
    const path = `${this.#apiRoot}/issues/${input.pullNumber}/comments`;
    const response = await this.#transport.request<CommentApiResponse>({
      method: "POST",
      path,
      body: {
        body: `${input.marker}\n${input.runId ? `<!-- FORGEDOCK-RUN:${input.runId} -->\n` : ""}${input.body.trim()}\n`,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const comment = requireGitHubSuccess(response, path, [201]);
    const readBack = await this.getComments(input.pullNumber, input.signal);
    if (!readBack.some((body) => body.includes(input.marker))) {
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

function assertNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${label} number must be positive.`);
}
