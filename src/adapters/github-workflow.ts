import {
  GitHubApiError,
  type GitHubTransport,
  nextGitHubPagePath,
  repositoryApiPath,
  requireGitHubSuccess,
} from "./github-api.ts";
import { commentBodySignalsInvalidVerdict } from "../core/comment-contract.ts";
import { assertReviewFindingReadbackPaths } from "../core/review-integrity.ts";
import {
  resolveStagingBundleAsync,
  type FrozenStagingBundleRoute,
  type StagingBundleCandidate,
  type AsyncStagingBundleReachability,
  type StagingBundleResolution,
} from "../core/staging-bundle-resolver.ts";

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
  /** Present when GitHub supplied the merge_commit_sha field. */
  mergeCommitSha?: string;
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
  route?: { headRef: string; baseRef: string } | { from: string; to: string };
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

export type GitHubReviewEvent = "APPROVE" | "COMMENT";

export interface GitHubReviewPublication {
  id: number;
  url: string;
  actor: string;
  event: GitHubReviewEvent;
  state: string;
  commitId: string;
  body: string;
}

export interface PublishPullRequestReviewInput {
  pullNumber: number;
  commitId: string;
  body: string;
  signal?: AbortSignal;
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

/** The REST blocked_by endpoint returns issue-shaped records, not free-form
 * issue text. Keep this narrow so orchestration can only persist typed edges
 * observed from that endpoint. */
interface BlockedByApiResponse {
  number: number;
  dependency_type?: string;
  pull_request?: unknown;
}

interface PullApiResponse {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha?: string | null;
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

interface ReviewApiResponse {
  id: number;
  html_url?: string;
  user?: { login?: string } | null;
  state?: string;
  body?: string | null;
  commit_id?: string;
  event?: string;
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

  async listIssueBlockedBy(
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<number[]> {
    assertNumber(issueNumber, "issue");
    const blockers: number[] = [];
    const seen = new Set<string>();
    let path: string | undefined =
      `${this.#apiRoot}/issues/${issueNumber}/dependencies/blocked_by?per_page=100`;
    for (let pageNumber = 0; path && pageNumber < 100; pageNumber += 1) {
      const pagePath = path;
      if (seen.has(pagePath))
        throw new GitHubApiError(422, pagePath, {
          message: "GitHub issue-dependency pagination repeated a page.",
        });
      seen.add(pagePath);
      const response = await this.#transport.request<IssueApiResponse[]>({
        method: "GET",
        path: pagePath,
        ...(signal ? { signal } : {}),
      });
      if (response.status === 404 && isBlockedByEndpointUnsupported(response))
        return [];
      const dependencies = requireGitHubSuccess(response, pagePath, [200]);
      if (!Array.isArray(dependencies))
        throw new GitHubApiError(422, pagePath, {
          message: "GitHub returned a non-array blocked_by dependency page.",
        });
      blockers.push(
        ...dependencies.map((issue) => parseBlockedByIssue(issue, pagePath)),
      );
      path = nextGitHubPagePath(response.headers);
    }
    if (path)
      throw new GitHubApiError(422, path, {
        message: "GitHub issue-dependency pagination exceeded 100 pages.",
      });
    return [...new Set(blockers)];
  }

  async listIssuesByLabel(
    label: string,
    state: "open" | "closed" | "all" = "all",
    signal?: AbortSignal,
  ): Promise<GitHubIssueData[]> {
    const issues: IssueApiResponse[] = [];
    const seen = new Set<string>();
    let path: string | undefined =
      `${this.#apiRoot}/issues?state=${state}&labels=${encodeURIComponent(label)}&per_page=100`;
    for (let page = 0; path && page < 100; page += 1) {
      if (seen.has(path))
        throw new GitHubApiError(422, path, {
          message: "GitHub issue pagination repeated a page.",
        });
      seen.add(path);
      const response = await this.#transport.request<IssueApiResponse[]>({
        method: "GET",
        path,
        ...(signal ? { signal } : {}),
      });
      issues.push(...requireGitHubSuccess(response, path, [200]));
      path = nextGitHubPagePath(response.headers);
    }
    if (path)
      throw new GitHubApiError(422, path, {
        message: "GitHub issue pagination exceeded 100 pages.",
      });
    return issues
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
    /** Structured path authority checked after GitHub readback. */
    expectedAffectedPaths?: readonly string[];
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
    if (
      readBack.title !== input.title ||
      readBack.body !== input.body ||
      !sameLabels(readBack.labels, input.labels)
    )
      throw new GitHubApiError(422, path, {
        message: "Review-finding issue read-back did not match the requested payload.",
      });
    if (input.expectedAffectedPaths)
      assertReviewFindingReadbackPaths(readBack.body, input.expectedAffectedPaths);
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
    const comment = requireGitHubSuccess(response, path, [201]);
    const readBack = await this.#getCommentRecord(comment.id, signal);
    if (readBack.id !== comment.id || readBack.body !== body)
      throw new GitHubApiError(422, path, {
        message: "Issue comment read-back did not match the requested payload.",
        commentId: comment.id,
      });
    return comment.id;
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
    const route =
      selector && isReviewRouteSelector(selector)
        ? this.configuredReviewRoute(selector)
        : undefined;
    const state = options.state ?? (selector === "all" ? "all" : "open");
    const requestedHeadRef = options.headRef ?? options.head;
    const requestedBaseRef = options.baseRef ?? options.base;
    const headRef = route?.headRef ?? requestedHeadRef;
    const baseRef = route?.baseRef ?? requestedBaseRef;
    if (
      options.headRef !== undefined &&
      options.head !== undefined &&
      options.headRef !== options.head
    )
      throw new Error(
        "Conflicting pull request head selectors are not allowed.",
      );
    if (
      options.baseRef !== undefined &&
      options.base !== undefined &&
      options.baseRef !== options.base
    )
      throw new Error(
        "Conflicting pull request base selectors are not allowed.",
      );
    if (
      route &&
      ((requestedHeadRef !== undefined && requestedHeadRef !== route.headRef) ||
        (requestedBaseRef !== undefined && requestedBaseRef !== route.baseRef))
    )
      throw new Error(
        "Explicit pull request refs conflict with the configured review route.",
      );
    if (selector && selector !== "open" && selector !== "all" && !route)
      throw new Error(
        `Unknown pull request collection selector '${selector}'.`,
      );
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
      nextPath = nextGitHubPagePath(response.headers);
    }
    return pulls.sort(comparePullRequests);
  }

  /**
   * Return all PR metadata that could have contributed to the frozen
   * integration branch. This intentionally requests all states and paginates
   * through the adapter rather than deriving PR numbers from commit subjects.
   */
  async listStagingBundleCandidates(
    signal?: AbortSignal,
  ): Promise<StagingBundleCandidate[]> {
    const pulls = await this.listPullRequests(
      { state: "all", baseRef: this.#stagingBranch, signal },
      signal,
    );
    return pulls.map((pull) => ({
      repository: this.#repository,
      number: pull.number,
      state: pull.state,
      merged: pull.merged,
      baseRef: pull.baseRef,
      headSha: pull.headSha,
      ...(pull.mergeCommitSha
        ? { mergeCommitSha: pull.mergeCommitSha }
        : {}),
    }));
  }

  /**
   * Resolve a frozen staging bundle from GitHub PR identity plus a caller's
   * commit graph probe (normally `git merge-base --is-ancestor`). No refs are
   * read here, so callers cannot accidentally mix moving base/head values.
   */
  async resolveStagingBundle(input: {
    route: Omit<FrozenStagingBundleRoute, "repository"> & {
      repository?: string;
    };
    isReachable: AsyncStagingBundleReachability;
    signal?: AbortSignal;
  }): Promise<StagingBundleResolution> {
    const route: FrozenStagingBundleRoute = {
      ...input.route,
      repository: input.route.repository ?? this.#repository,
    };
    return resolveStagingBundleAsync({
      route,
      candidates: await this.listStagingBundleCandidates(input.signal),
      isReachable: input.isReachable,
    });
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
    return this.listPullRequests(
      selector as PullRequestCollectionSelector,
      signal,
    );
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
      const checks = await this.#checksForCommit(input.headSha, input.signal);
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

  /**
   * Publish one official review after the semantic gate has passed. GitHub
   * rejects self-approval; only its exact owner-only rejection permits the
   * equivalent COMMENT evidence, never any other provider failure.
   */
  async publishPullRequestReview(
    input: PublishPullRequestReviewInput,
  ): Promise<GitHubReviewPublication> {
    assertNumber(input.pullNumber, "pull request");
    assertNonEmptyRefOrSha(input.commitId, "review commit");
    if (!input.body.trim()) throw new TypeError("Review body is required.");
    const path = `${this.#apiRoot}/pulls/${input.pullNumber}/reviews`;
    const approve = await this.#transport.request<ReviewApiResponse>({
      method: "POST",
      path,
      body: { body: input.body, event: "APPROVE", commit_id: input.commitId },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    let event: GitHubReviewEvent = "APPROVE";
    let created: ReviewApiResponse;
    if (approve.status >= 200 && approve.status < 300) {
      created = approve.data;
    } else if (isExactOwnerSelfApprovalRejection(approve)) {
      const fallback = await this.#transport.request<ReviewApiResponse>({
        method: "POST",
        path,
        body: { body: input.body, event: "COMMENT", commit_id: input.commitId },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      created = requireGitHubSuccess(fallback, path, [201]);
      event = "COMMENT";
    } else {
      throw new GitHubApiError(approve.status, path, approve.data);
    }
    return this.#readBackReview(
      input.pullNumber,
      input.commitId,
      input.body,
      event,
      created,
      input.signal,
    );
  }

  async #readBackReview(
    pullNumber: number,
    commitId: string,
    body: string,
    event: GitHubReviewEvent,
    created: ReviewApiResponse,
    signal?: AbortSignal,
  ): Promise<GitHubReviewPublication> {
    if (!Number.isSafeInteger(created?.id) || created.id < 1)
      throw new GitHubApiError(422, `${this.#apiRoot}/pulls/${pullNumber}/reviews`, { message: "Review creation response lacked an id." });
    const readPath = `${this.#apiRoot}/pulls/${pullNumber}/reviews/${created.id}`;
    const response = await this.#transport.request<ReviewApiResponse>({
      method: "GET",
      path: readPath,
      ...(signal ? { signal } : {}),
    });
    const review = requireGitHubSuccess(response, readPath, [200]);
    const actor = review.user?.login;
    const state = review.state;
    const actualBody = review.body ?? "";
    const actualCommit = review.commit_id;
    if (
      review.id !== created.id ||
      typeof review.html_url !== "string" ||
      !review.html_url.trim() ||
      typeof actor !== "string" ||
      !actor.trim() ||
      typeof state !== "string" ||
      actualCommit !== commitId ||
      actualBody !== body
    )
      throw new GitHubApiError(422, readPath, { message: "Review read-back did not match the requested frozen evidence." });
    return { id: review.id, url: review.html_url, actor, event, state, commitId, body };
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
    // A replay may observe a PR merged after the original route snapshot. Its
    // base SHA is expected to have moved, so reconcile this terminal side
    // effect before rejecting the stale pre-merge route.
    if (current.merged)
      return { merged: true, sha: current.headSha, message: "Already merged" };
    if (input.expectedRoute) {
      assertPullRequestRouteSnapshot(
        input.expectedRoute,
        current,
        this.#apiRoot,
      );
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
    const expectedHeadSha =
      input.expectedRoute?.headSha ?? input.expectedHeadSha;
    if (!expectedHeadSha)
      throw new TypeError("merge requires an expected head SHA.");
    if (current.headSha !== expectedHeadSha) {
      throw new GitHubApiError(409, path, {
        message: `Stale reviewed SHA ${expectedHeadSha}; current head is ${current.headSha}`,
      });
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
    const comments: CommentApiResponse[] = [];
    const seen = new Set<string>();
    let path: string | undefined =
      `${this.#apiRoot}/issues/${issueOrPullNumber}/comments?per_page=100&cache_bust=${Date.now()}`;
    for (let page = 0; path && page < 100; page += 1) {
      if (seen.has(path))
        throw new GitHubApiError(422, path, {
          message: "GitHub comment pagination repeated a page.",
        });
      seen.add(path);
      const response = await this.#transport.request<CommentApiResponse[]>({
        method: "GET",
        path,
        ...(signal ? { signal } : {}),
      });
      comments.push(...requireGitHubSuccess(response, path, [200]));
      path = nextGitHubPagePath(response.headers);
    }
    if (path)
      throw new GitHubApiError(422, path, {
        message: "GitHub comment pagination exceeded 100 pages.",
      });
    return comments;
  }

  async #getCommentRecord(
    commentId: number,
    signal?: AbortSignal,
  ): Promise<CommentApiResponse> {
    const path = `${this.#apiRoot}/issues/comments/${commentId}`;
    const response = await this.#transport.request<CommentApiResponse>({
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
    const body = `${input.marker}\n${input.body.trim()}\n`;
    const existingComment = existing.find((comment) =>
      comment.body.includes(input.marker),
    );
    if (existingComment) {
      // The marker is the artifact's durable identity: the published comment
      // is authoritative even when a re-render differs byte-for-byte (dynamic
      // ordering, formatting drift). Recovery must reuse it — a payload
      // mismatch deadlock here failed whole lanes at integration (live:
      // support-ticket campaign 742ff83d, issues #33136/#29461).
      return existingComment.id;
    }
    const path = `${this.#apiRoot}/issues/${input.pullNumber}/comments`;
    const response = await this.#transport.request<CommentApiResponse>({
      method: "POST",
      path,
      body: { body },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const comment = requireGitHubSuccess(response, path, [201]);
    const readBack = await this.#getCommentRecord(comment.id, input.signal);
    if (readBack.id !== comment.id || readBack.body !== body)
      throw new GitHubApiError(422, path, {
        message: `Pull request artifact read-back mismatch for ${input.marker}.`,
        commentId: comment.id,
      });
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

  /**
   * True when the issue carries a durable prior invalid/no-change verdict
   * (FORGE:INVALID or FORGE:COMMIT:NO-CHANGE markers in any comment).
   */
  async hasInvalidVerdictMarker(
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const comments = await this.#getCommentRecords(issueNumber, signal);
    return comments.some((comment) =>
      commentBodySignalsInvalidVerdict(comment.body ?? ""),
    );
  }

  /** Post an issue comment (invalid-closure and adoption evidence). */
  async postIssueComment(
    issueNumber: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertNumber(issueNumber, "issue number");
    const path = `${this.#apiRoot}/issues/${issueNumber}/comments`;
    const response = await this.#transport.request<{ id: number }>({
      method: "POST",
      path,
      body: { body },
      ...(signal ? { signal } : {}),
    });
    requireGitHubSuccess(response, path, [201]);
  }

  /** Remove issue labels; 404s (already absent) are tolerated. */
  async removeIssueLabels(
    issueNumber: number,
    labels: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    assertNumber(issueNumber, "issue number");
    for (const label of labels) {
      const path = `${this.#apiRoot}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;
      const response = await this.#transport.request<unknown>({
        method: "DELETE",
        path,
        ...(signal ? { signal } : {}),
      });
      if (response.status === 404) continue;
      requireGitHubSuccess(response, path, [200]);
    }
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
      const required = requireGitHubSuccess(protection, protectionPath, [200]);
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
    return workflows.workflows.filter((workflow) => workflow.state === "active")
      .length;
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

function isBlockedByEndpointUnsupported(
  response: { status: number; data: unknown; headers: Readonly<Record<string, string>> },
): boolean {
  if (response.status !== 404) return false;
  const headers = response.headers;
  if (
    headers["x-github-endpoint-unsupported"]?.toLowerCase() === "true" ||
    headers["x-forgedock-endpoint-unsupported"]?.toLowerCase() === "true"
  )
    return true;
  if (!response.data || typeof response.data !== "object" || Array.isArray(response.data))
    return false;
  const body = response.data as Record<string, unknown>;
  return (
    body.endpoint_unsupported === true ||
    (typeof body.message === "string" &&
      /^(?:GitHub )?endpoint (?:(?:not )?supported|unsupported)$/i.test(body.message.trim()))
  );
}

function sameLabels(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((label, index) => label === expected[index]);
}

function parseBlockedByIssue(value: unknown, path: string): number {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GitHubApiError(422, path, {
      message: "GitHub returned a malformed blocked_by dependency.",
    });
  const issue = value as Partial<BlockedByApiResponse>;
  if (
    issue.dependency_type !== undefined &&
    issue.dependency_type !== "blocked_by"
  )
    throw new GitHubApiError(422, path, {
      message: "GitHub returned a dependency with the wrong type.",
    });
  if (issue.pull_request !== undefined)
    throw new GitHubApiError(422, path, {
      message: "GitHub returned a pull request as a blocked_by dependency.",
    });
  if (!Number.isSafeInteger(issue.number) || (issue.number as number) < 1)
    throw new GitHubApiError(422, path, {
      message: "GitHub returned a blocked_by dependency without a valid issue number.",
    });
  return issue.number as number;
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
  if (
    !match ||
    `${decodeURIComponent(match[1] as string)}/${decodeURIComponent(match[2] as string)}` !==
      repository
  )
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

function isExactOwnerSelfApprovalRejection(
  response: { status: number; data: unknown },
): boolean {
  if (response.status !== 422 || !response.data || typeof response.data !== "object")
    return false;
  const message = (response.data as { message?: unknown }).message;
  return typeof message === "string" &&
    /^(?:can(?:not|'t| not) approve your own pull request|cannot approve your own pull request)\.?$/i.test(message.trim());
}

function normalizePull(pull: PullApiResponse): GitHubPullRequestData {
  return {
    number: pull.number,
    htmlUrl: pull.html_url,
    state: pull.state,
    merged: pull.merged,
    ...(pull.merge_commit_sha
      ? { mergeCommitSha: pull.merge_commit_sha }
      : {}),
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

function collectRequiredContexts(value: unknown, contexts: Set<string>): void {
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
