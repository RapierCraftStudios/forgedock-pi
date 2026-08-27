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

/**
 * The route identity reviewed by a standalone review run.
 *
 * Keep this separate from the mutable pull-request representation: callers
 * can persist this value and use it as the authority for the final merge or
 * other side effect.  Every ref and SHA is intentionally captured.
 */
export interface GitHubPullRequestRouteSnapshot {
  pullNumber: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
}

/** Historical spelling retained for integrations that call this a PR route. */
export type PullRequestRouteSnapshot = GitHubPullRequestRouteSnapshot;

export interface GitHubWorkflowRouteConfig {
  /** The configured staging/integration branch. */
  stagingBranch?: string;
  /** The configured production/default branch. */
  mainBranch?: string;
  /** Equivalent policy-oriented names accepted by callers. */
  integrationBranch?: string;
  defaultBranch?: string;
  /** Explicit route form, useful when names are loaded from policy. */
  stagingToMain?: { headRef: string; baseRef: string };
  /** Explicit route aliases used by older command integrations. */
  route?:
    | { headRef: string; baseRef: string }
    | { from: string; to: string };
}

export type PullRequestCollectionSelector =
  | "open"
  | "all"
  | "staging"
  | "feature"
  | "staging:feature";

export interface ListPullRequestsInput {
  selector?: PullRequestCollectionSelector;
  state?: "open" | "closed" | "all";
  headRef?: string;
  baseRef?: string;
  /** Short aliases matching GitHub's API vocabulary. */
  head?: string;
  base?: string;
  signal?: AbortSignal;
}

export type PullRequestExactSelector = number | `#${number}` | string;

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

interface GitRefApiResponse {
  ref: string;
  object: { sha: string };
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
  readonly #repository: string;
  readonly #stagingBranch: string;
  readonly #mainBranch: string;

  constructor(
    transport: GitHubTransport,
    repository: string,
    routeConfig: GitHubWorkflowRouteConfig = {},
  ) {
    this.#transport = transport;
    this.#apiRoot = repositoryApiPath(repository);
    this.#repository = repository;
    this.#repositoryOwner = repository.split("/")[0] as string;
    const configuredRoute = routeConfig.stagingToMain ?? routeConfig.route;
    const explicitHead = configuredRoute
      ? "headRef" in configuredRoute
        ? configuredRoute.headRef
        : configuredRoute.from
      : undefined;
    const explicitBase = configuredRoute
      ? "baseRef" in configuredRoute
        ? configuredRoute.baseRef
        : configuredRoute.to
      : undefined;
    this.#stagingBranch =
      explicitHead ??
      routeConfig.stagingBranch ??
      routeConfig.integrationBranch ??
      "staging";
    this.#mainBranch =
      explicitBase ??
      routeConfig.mainBranch ??
      routeConfig.defaultBranch ??
      "main";
    assertBranchRef(this.#stagingBranch, "staging branch");
    assertBranchRef(this.#mainBranch, "main branch");
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

  /**
   * List pull requests through one deterministic API shape. GitHub's list
   * endpoint is not ordered by contract, so results are sorted locally by
   * number and then by route identity before returning.
   */
  async listPullRequests(
    input: ListPullRequestsInput | PullRequestCollectionSelector = "open",
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestData[]> {
    const options: ListPullRequestsInput =
      typeof input === "string" ? { selector: input } : input;
    const selector = options.selector;
    const route = selector && isReviewRouteSelector(selector)
      ? this.configuredReviewRoute(selector)
      : undefined;
    const state = options.state ?? (selector === "all" ? "all" : "open");
    const requestedHeadRef = options.headRef ?? options.head;
    const requestedBaseRef = options.baseRef ?? options.base;
    const headRef = route?.headRef ?? requestedHeadRef;
    const baseRef = route?.baseRef ?? requestedBaseRef;
    if (options.headRef !== undefined && options.head !== undefined && options.headRef !== options.head)
      throw new Error("Conflicting pull request head selectors are not allowed.");
    if (options.baseRef !== undefined && options.base !== undefined && options.baseRef !== options.base)
      throw new Error("Conflicting pull request base selectors are not allowed.");
    if (
      route &&
      ((requestedHeadRef !== undefined && requestedHeadRef !== route.headRef) ||
        (requestedBaseRef !== undefined && requestedBaseRef !== route.baseRef))
    )
      throw new Error("Explicit pull request refs conflict with the configured review route.");
    if (selector && selector !== "open" && selector !== "all" && !route)
      throw new Error(`Unknown pull request collection selector '${selector}'.`);
    if (state !== "open" && state !== "closed" && state !== "all")
      throw new TypeError("Pull request state must be open, closed, or all.");
    if (headRef !== undefined) assertBranchRef(headRef, "pull request head");
    if (baseRef !== undefined) assertBranchRef(baseRef, "pull request base");

    const query = new URLSearchParams({ state, per_page: "100" });
    // URLSearchParams encodes spaces as '+'; GitHub accepts that, and keeping
    // parameter insertion order makes request traces deterministic.
    if (headRef !== undefined)
      query.set("head", `${this.#repositoryOwner}:${headRef}`);
    if (baseRef !== undefined) query.set("base", baseRef);
    const path = `${this.#apiRoot}/pulls?${query.toString()}`;
    const requestSignal = options.signal ?? signal;
    const pulls: GitHubPullRequestData[] = [];
    const visitedPaths = new Set<string>();
    let nextPath: string | undefined = path;
    while (nextPath) {
      if (visitedPaths.has(nextPath))
        throw new GitHubApiError(502, nextPath, {
          message: "GitHub pull request pagination repeated a page.",
        });
      visitedPaths.add(nextPath);
      const response = await this.#transport.request<PullApiResponse[]>({
        method: "GET",
        path: nextPath,
        ...(requestSignal ? { signal: requestSignal } : {}),
      });
      const page = requireGitHubSuccess(response, nextPath, [200]);
      pulls.push(
        ...page
          .map(normalizePull)
          .filter((pull) => headRef === undefined || pull.headRef === headRef)
          .filter((pull) => baseRef === undefined || pull.baseRef === baseRef),
      );
      nextPath = nextPagePath(response.headers);
    }
    return pulls.sort(comparePullRequests);
  }

  /** Resolve one exact PR number or canonical GitHub PR URL. */
  async resolvePullRequest(
    selector: PullRequestExactSelector,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestData> {
    const pullNumber = pullNumberFromSelector(selector, this.#repository);
    return this.getPullRequest(pullNumber, signal);
  }

  /** Resolve either an exact selector or a named collection/route. */
  async resolvePullRequests(
    selector: PullRequestExactSelector | PullRequestCollectionSelector,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestData[]> {
    if (typeof selector === "number" || isExactPullRequestString(selector))
      return [await this.resolvePullRequest(selector, signal)];
    return this.listPullRequests(selector as PullRequestCollectionSelector, signal);
  }

  /** Alias with an explicit selector-oriented name for command adapters. */
  async resolveReviewSelector(
    selector: PullRequestExactSelector | PullRequestCollectionSelector,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestData[]> {
    return this.resolvePullRequests(selector, signal);
  }

  /** Return the configured staging-to-main route without mutating branches. */
  configuredStagingToMainRoute(): { headRef: string; baseRef: string } {
    return Object.freeze({
      headRef: this.#stagingBranch,
      baseRef: this.#mainBranch,
    });
  }

  /** Resolve all legacy route aliases to the configured staging-to-main pair. */
  configuredReviewRoute(
    selector: PullRequestCollectionSelector,
  ): { headRef: string; baseRef: string } | undefined {
    if (!isReviewRouteSelector(selector)) return undefined;
    return this.configuredStagingToMainRoute();
  }

  async getBranchHeadSha(
    branch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    assertBranchRef(branch, "branch");
    const path = `${this.#apiRoot}/git/ref/heads/${encodeURIComponent(branch)}`;
    const response = await this.#transport.request<GitRefApiResponse>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    const ref = requireGitHubSuccess(response, path, [200]);
    assertNonEmptyRefOrSha(ref.object.sha, "branch head SHA");
    return ref.object.sha;
  }

  async #withCurrentBase(
    pull: GitHubPullRequestData,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestData> {
    return {
      ...pull,
      baseSha: await this.getBranchHeadSha(pull.baseRef, signal),
    };
  }

  /** Freeze the exact route identity observed for a pull request. */
  snapshotPullRequestRoute(
    pull: Pick<
      GitHubPullRequestData,
      "number" | "headRef" | "headSha" | "baseRef" | "baseSha"
    >,
  ): GitHubPullRequestRouteSnapshot {
    assertNumber(pull.number, "pull request");
    assertNonEmptyRefOrSha(pull.headRef, "pull request head ref");
    assertNonEmptyRefOrSha(pull.headSha, "pull request head SHA");
    assertNonEmptyRefOrSha(pull.baseRef, "pull request base ref");
    assertNonEmptyRefOrSha(pull.baseSha, "pull request base SHA");
    return Object.freeze({
      pullNumber: pull.number,
      headRef: pull.headRef,
      headSha: pull.headSha,
      baseRef: pull.baseRef,
      baseSha: pull.baseSha,
    });
  }

  snapshotPullRequest(
    pull: Pick<
      GitHubPullRequestData,
      "number" | "headRef" | "headSha" | "baseRef" | "baseSha"
    >,
  ): GitHubPullRequestRouteSnapshot {
    return this.snapshotPullRequestRoute(pull);
  }

  async getPullRequestRouteSnapshot(
    selector: PullRequestExactSelector,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRouteSnapshot> {
    const pull = await this.resolvePullRequest(selector, signal);
    return this.snapshotPullRequestRoute(
      await this.#withCurrentBase(pull, signal),
    );
  }

  async getPullRequestSnapshot(
    selector: PullRequestExactSelector,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRouteSnapshot> {
    return this.getPullRequestRouteSnapshot(selector, signal);
  }

  async listPullRequestRouteSnapshots(
    input: ListPullRequestsInput | PullRequestCollectionSelector = "open",
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRouteSnapshot[]> {
    const pulls = await this.listPullRequests(input, signal);
    return Promise.all(
      pulls.map(async (pull) =>
        this.snapshotPullRequestRoute(
          await this.#withCurrentBase(pull, signal),
        ),
      ),
    );
  }

  async resolvePullRequestRoute(
    selector: PullRequestExactSelector,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRouteSnapshot> {
    return this.getPullRequestRouteSnapshot(selector, signal);
  }

  /**
   * Re-read and compare every route field immediately before a side effect.
   * The returned PR is the final validated read, not the stale snapshot.
   */
  async revalidatePullRequestRoute(
    snapshot: GitHubPullRequestRouteSnapshot,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestData> {
    const current = await this.#withCurrentBase(
      await this.getPullRequest(snapshot.pullNumber, signal),
      signal,
    );
    assertPullRequestRouteSnapshot(snapshot, current, this.#apiRoot);
    return current;
  }

  async revalidatePullRequestRouteSnapshot(
    snapshot: GitHubPullRequestRouteSnapshot,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestRouteSnapshot> {
    return this.snapshotPullRequestRoute(
      await this.revalidatePullRequestRoute(snapshot, signal),
    );
  }

  /** Compatibility alias for callers that name this operation validation. */
  async validatePullRequestRoute(
    snapshot: GitHubPullRequestRouteSnapshot,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestData> {
    return this.revalidatePullRequestRoute(snapshot, signal);
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
        throw new Error(
          `Open PR #${existing.number} for ${input.head} targets ${existing.baseRef}, not requested base ${input.base}. Close or retarget it before retrying.`,
        );
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
    const path = `${this.#apiRoot}/pulls/${pullNumber}?cache_bust=${Date.now()}`;
    const response = await this.#transport.request<PullApiResponse>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    return normalizePull(requireGitHubSuccess(response, path, [200]));
  }

  async waitForPullRequestHead(input: {
    pullNumber: number;
    headSha: string;
    headRef: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  }): Promise<GitHubPullRequestData> {
    const deadline = Date.now() + (input.timeoutMs ?? 30_000);
    while (true) {
      const pull = await this.getPullRequest(input.pullNumber, input.signal);
      if (pull.headRef !== input.headRef)
        throw new Error(
          `PR #${input.pullNumber} head ref ${pull.headRef} does not match ${input.headRef}.`,
        );
      if (pull.headSha === input.headSha) return pull;
      if (Date.now() >= deadline)
        throw new Error(
          `PR #${input.pullNumber} did not observe pushed head ${input.headSha}; latest was ${pull.headSha}.`,
        );
      await abortableDelay(input.pollIntervalMs ?? 1_000, input.signal);
    }
  }

  async waitForPullRequestChecks(input: {
    headSha: string;
    baseBranch: string;
    timeoutMs: number;
    pollIntervalMs: number;
    signal?: AbortSignal;
  }): Promise<GitHubCiResult> {
    const startedAt = Date.now();
    const [requiredContexts, configuredWorkflowCount] = await Promise.all([
      this.#requiredStatusContexts(input.baseBranch, input.signal),
      this.#configuredWorkflowCount(input.signal),
    ]);
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
    expectedHeadSha?: string;
    expectedBaseRef?: string;
    expectedRoute?: GitHubPullRequestRouteSnapshot;
    method?: "merge" | "squash" | "rebase";
    signal?: AbortSignal;
  }): Promise<MergeResult> {
    assertNumber(input.pullNumber, "pull request");
    const current = await this.#withCurrentBase(
      await this.getPullRequest(input.pullNumber, input.signal),
      input.signal,
    );
    const path = `${this.#apiRoot}/pulls/${input.pullNumber}/merge`;
    if (input.expectedRoute) {
      assertPullRequestRouteSnapshot(input.expectedRoute, current, this.#apiRoot);
    } else {
      if (!input.expectedBaseRef || !input.expectedHeadSha)
        throw new TypeError(
          "merge requires expectedRoute or both expectedHeadSha and expectedBaseRef",
        );
      if (current.baseRef !== input.expectedBaseRef)
        throw new GitHubApiError(409, path, {
          message: `Pull request targets ${current.baseRef}; expected ${input.expectedBaseRef}`,
        });
    }
    const expectedHeadSha = input.expectedRoute?.headSha ?? input.expectedHeadSha;
    if (!expectedHeadSha)
      throw new TypeError("merge requires an expected head SHA.");
    if (current.merged)
      return { merged: true, sha: current.headSha, message: "Already merged" };
    if (current.headSha !== expectedHeadSha) {
      throw new GitHubApiError(
        409,
        path,
        {
          message: `Stale reviewed SHA ${expectedHeadSha}; current head is ${current.headSha}`,
        },
      );
    }
    const response = await this.#transport.request<MergeApiResponse>({
      method: "PUT",
      path,
      body: {
        sha: expectedHeadSha,
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
    const path = `${this.#apiRoot}/issues/${issueOrPullNumber}/comments?per_page=100&cache_bust=${Date.now()}`;
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

  async deleteBranch(branch: string, signal?: AbortSignal): Promise<void> {
    if (!branch.trim()) throw new TypeError("branch must be non-empty");
    const path = `${this.#apiRoot}/git/refs/heads/${encodeURIComponent(branch)}`;
    const response = await this.#transport.request<unknown>({
      method: "DELETE",
      path,
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) return;
    if (response.status === 422) {
      const readPath = `${this.#apiRoot}/git/ref/heads/${encodeURIComponent(branch)}`;
      const readBack = await this.#transport.request<unknown>({
        method: "GET",
        path: readPath,
        ...(signal ? { signal } : {}),
      });
      if (readBack.status === 404) return;
    }
    requireGitHubSuccess(response, path, [204]);
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
    const rulesPath = `${this.#apiRoot}/rules/branches/${encodeURIComponent(baseBranch)}`;
    const [protection, rules] = await Promise.all([
      this.#transport.request<RequiredStatusChecksApiResponse>({
        method: "GET",
        path: protectionPath,
        ...(signal ? { signal } : {}),
      }),
      this.#transport.request<unknown>({
        method: "GET",
        path: rulesPath,
        ...(signal ? { signal } : {}),
      }),
    ]);
    if (protection.status !== 404) {
      const required = requireGitHubSuccess(
        protection,
        protectionPath,
        [200],
      );
      for (const context of required.contexts ?? []) contexts.add(context);
      for (const check of required.checks ?? []) contexts.add(check.context);
    }
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
    const statusPath = `${this.#apiRoot}/commits/${encodeURIComponent(headSha)}/status?per_page=100`;
    const [checkRunsResponse, statusResponse] = await Promise.all([
      this.#transport.request<CheckRunsApiResponse>({
        method: "GET",
        path: checkRunsPath,
        ...(signal ? { signal } : {}),
      }),
      this.#transport.request<CombinedStatusApiResponse>({
        method: "GET",
        path: statusPath,
        ...(signal ? { signal } : {}),
      }),
    ]);
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

function nextPagePath(headers: Readonly<Record<string, string>>): string | undefined {
  const link = headers.link ?? headers.Link;
  if (!link) return undefined;
  const match = link.match(/<([^>]+)>;\s*rel="next"/i);
  if (!match?.[1]) return undefined;
  try {
    const url = new URL(match[1], "https://api.github.com");
    if (url.origin !== "https://api.github.com") return undefined;
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

function isReviewRouteSelector(
  selector: string,
): selector is "staging" | "feature" | "staging:feature" {
  return (
    selector === "staging" ||
    selector === "feature" ||
    selector === "staging:feature"
  );
}

function isExactPullRequestString(selector: string): boolean {
  return /^#?[1-9]\d*$/.test(selector) || isGitHubPullRequestUrl(selector);
}

function isGitHubPullRequestUrl(selector: string): boolean {
  try {
    const url = new URL(selector);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function pullNumberFromSelector(
  selector: PullRequestExactSelector,
  repository: string,
): number {
  if (typeof selector === "number") {
    assertNumber(selector, "pull request");
    return selector;
  }
  const numberMatch = selector.match(/^#?([1-9]\d*)$/);
  if (numberMatch) {
    const value = Number(numberMatch[1]);
    assertNumber(value, "pull request");
    return value;
  }
  if (!isGitHubPullRequestUrl(selector))
    throw new Error(
      "Pull request selector must be a positive number or an exact GitHub pull request URL.",
    );
  // SAFETY: isGitHubPullRequestUrl already validated that URL() parses; the local
  // try/catch keeps this path total even if the guard above changes.
  let url: URL;
  try {
    url = new URL(selector);
  } catch {
    throw new Error(
      "Pull request selector must be a positive number or an exact GitHub pull request URL.",
    );
  }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (!match || `${decodeURIComponent(match[1] as string)}/${decodeURIComponent(match[2] as string)}` !== repository)
    throw new Error(`Pull request URL must address ${repository}.`);
  const value = Number(match[3]);
  assertNumber(value, "pull request");
  return value;
}

function comparePullRequests(
  left: GitHubPullRequestData,
  right: GitHubPullRequestData,
): number {
  return (
    left.number - right.number ||
    left.headRef.localeCompare(right.headRef) ||
    left.baseRef.localeCompare(right.baseRef) ||
    left.headSha.localeCompare(right.headSha)
  );
}

function assertBranchRef(value: string, label: string): void {
  if (
    !value ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.split("/").some((part) => !part || part.startsWith("."))
  )
    throw new TypeError(`${label} must be a safe Git branch reference.`);
}

function assertNonEmptyRefOrSha(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${label} must be non-empty.`);
}

function assertPullRequestRouteSnapshot(
  snapshot: GitHubPullRequestRouteSnapshot,
  current: GitHubPullRequestData,
  apiRoot: string,
): void {
  const mismatches: string[] = [];
  if (current.number !== snapshot.pullNumber) mismatches.push("number");
  if (current.headRef !== snapshot.headRef) mismatches.push("head ref");
  if (current.headSha !== snapshot.headSha) mismatches.push("head SHA");
  if (current.baseRef !== snapshot.baseRef) mismatches.push("base ref");
  if (current.baseSha !== snapshot.baseSha) mismatches.push("base SHA");
  if (mismatches.length === 0) return;
  throw new GitHubApiError(409, `${apiRoot}/pulls/${snapshot.pullNumber}`, {
    message: `Pull request route changed after review: ${mismatches.join(", ")}`,
  });
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
