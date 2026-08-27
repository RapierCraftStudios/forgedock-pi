import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubApiError,
  type GitHubRequest,
  type GitHubResponse,
  type GitHubTransport,
} from "../../src/adapters/github-api.ts";
import { GitHubWorkflowAdapter } from "../../src/adapters/github-workflow.ts";

class MockTransport implements GitHubTransport {
  readonly requests: GitHubRequest[] = [];
  readonly #handler: (request: GitHubRequest) => GitHubResponse<unknown>;

  constructor(handler: (request: GitHubRequest) => GitHubResponse<unknown>) {
    this.#handler = handler;
  }

  async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
    this.requests.push(request);
    return this.#handler(request) as GitHubResponse<T>;
  }
}

function response(status: number, data: unknown): GitHubResponse<unknown> {
  return { status, data, headers: {} };
}

function pullData(
  input: {
    number?: number;
    headRef?: string;
    baseRef?: string;
    state?: "open" | "closed";
  } = {},
) {
  return {
    number: input.number ?? 6,
    html_url: `https://example.test/pr/${input.number ?? 6}`,
    state: input.state ?? "open",
    merged: false,
    head: { sha: "head-sha", ref: input.headRef ?? "forge/issue-2" },
    base: { sha: "base-sha", ref: input.baseRef ?? "staging" },
    mergeable: true,
  };
}

function common(request: GitHubRequest): GitHubResponse<unknown> | undefined {
  if (request.path.includes("/protection/required_status_checks"))
    return response(200, { contexts: ["CI / test"], checks: [] });
  if (request.path.includes("/rules/branches/")) return response(200, []);
  if (request.path.includes("/actions/workflows"))
    return response(200, {
      total_count: 1,
      workflows: [{ state: "active" }],
    });
  if (request.path.includes("/status?"))
    return response(200, { state: "success", statuses: [] });
  return undefined;
}

test("PR lookup qualifies and exactly matches the bound head branch", async () => {
  const transport = new MockTransport((request) => {
    assert.match(request.path, /head=owner%3Aforge%2Fissue-2&per_page=20$/);
    return response(200, [
      {
        number: 5,
        html_url: "https://example.test/pr/5",
        state: "open",
        merged: false,
        head: { sha: "wrong-sha", ref: "forge/issue-1" },
        base: { sha: "base-sha", ref: "staging" },
        mergeable: true,
      },
      {
        number: 6,
        html_url: "https://example.test/pr/6",
        state: "open",
        merged: false,
        head: { sha: "right-sha", ref: "forge/issue-2" },
        base: { sha: "base-sha", ref: "staging" },
        mergeable: true,
      },
    ]);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const pull = await adapter.findPullRequest("forge/issue-2");
  assert.equal(pull?.number, 6);
  assert.equal(pull?.headSha, "right-sha");
});

test("PR creation reuses an open PR only on the requested base", async () => {
  const transport = new MockTransport((request) => {
    assert.equal(request.method, "GET");
    return response(200, [pullData()]);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const pull = await adapter.createPullRequest({
    title: "Fix issue 2",
    body: "Body",
    head: "forge/issue-2",
    base: "staging",
  });
  assert.equal(pull.number, 6);
  assert.equal(transport.requests.length, 1);
});

test("PR creation rejects an open head PR targeting another base", async () => {
  const transport = new MockTransport((request) => {
    assert.equal(request.method, "GET");
    return response(200, [pullData({ baseRef: "main" })]);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  await assert.rejects(
    adapter.createPullRequest({
      title: "Fix issue 2",
      body: "Body",
      head: "forge/issue-2",
      base: "staging",
    }),
    /PR #6.*targets main.*requested base staging/,
  );
  assert.equal(transport.requests.length, 1);
});

test("PR creation creates a new PR when the head has no open PR", async () => {
  const transport = new MockTransport((request) => {
    if (request.method === "GET") return response(200, []);
    assert.equal(request.method, "POST");
    assert.deepEqual(request.body, {
      title: "Fix issue 2",
      body: "Body",
      head: "forge/issue-2",
      base: "staging",
      draft: false,
    });
    return response(201, pullData());
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const pull = await adapter.createPullRequest({
    title: "Fix issue 2",
    body: "Body",
    head: "forge/issue-2",
    base: "staging",
  });
  assert.equal(pull.number, 6);
  assert.equal(transport.requests.length, 2);
});

test("PR head polling waits for the pushed commit to become visible", async () => {
  let reads = 0;
  const transport = new MockTransport((request) => {
    assert.equal(request.method, "GET");
    assert.match(request.path, /\/pulls\/6\?cache_bust=\d+$/);
    reads += 1;
    return response(200, {
      number: 6,
      html_url: "https://example.test/pr/6",
      state: "open",
      merged: false,
      head: {
        sha: reads < 3 ? "stale-sha" : "fresh-sha",
        ref: "forge/issue-2",
      },
      base: { sha: "base-sha", ref: "staging" },
      mergeable: true,
    });
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const pull = await adapter.waitForPullRequestHead({
    pullNumber: 6,
    headSha: "fresh-sha",
    headRef: "forge/issue-2",
    timeoutMs: 1_000,
    pollIntervalMs: 1,
  });
  assert.equal(pull.headSha, "fresh-sha");
  assert.equal(reads, 3);
});

test("merge rejects a PR retargeted from the reviewed base", async () => {
  const transport = new MockTransport((request) => {
    assert.equal(request.method, "GET");
    if (request.path.includes("/git/ref/heads/"))
      return response(200, { object: { sha: "main-sha" } });
    return response(200, pullData({ baseRef: "main" }));
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  await assert.rejects(
    adapter.mergePullRequest({
      pullNumber: 6,
      expectedHeadSha: "head-sha",
      expectedBaseRef: "staging",
    }),
    (error) =>
      error instanceof GitHubApiError &&
      error.status === 409 &&
      (error.response as { message?: string }).message ===
        "Pull request targets main; expected staging",
  );
  assert.equal(transport.requests.length, 2);
});

test("merge binds both the reviewed head and base", async () => {
  const transport = new MockTransport((request) => {
    if (request.method === "GET" && request.path.includes("/git/ref/heads/"))
      return response(200, { object: { sha: "base-sha" } });
    if (request.method === "GET") return response(200, pullData());
    assert.equal(request.method, "PUT");
    assert.deepEqual(request.body, {
      sha: "head-sha",
      merge_method: "squash",
    });
    return response(200, {
      merged: true,
      sha: "merge-sha",
      message: "Pull Request successfully merged",
    });
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const merged = await adapter.mergePullRequest({
    pullNumber: 6,
    expectedHeadSha: "head-sha",
    expectedBaseRef: "staging",
  });
  assert.equal(merged.sha, "merge-sha");
  assert.equal(transport.requests.length, 3);
});

test("branch deletion reconciles a missing auto-deleted ref", async () => {
  const transport = new MockTransport((request) => {
    if (request.method === "DELETE")
      return response(422, { message: "Reference does not exist" });
    if (request.method === "GET" && request.path.includes("/git/ref/heads/"))
      return response(404, { message: "Not Found" });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  await assert.doesNotReject(adapter.deleteBranch("forge/issue-2-run"));
  assert.equal(transport.requests.length, 2);
});

test("branch deletion keeps a real 422 failure", async () => {
  const transport = new MockTransport((request) => {
    if (request.method === "DELETE")
      return response(422, { message: "Validation Failed" });
    if (request.method === "GET" && request.path.includes("/git/ref/heads/"))
      return response(200, { object: { sha: "still-present" } });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  await assert.rejects(
    adapter.deleteBranch("forge/issue-2-run"),
    /GitHub API 422/,
  );
});

test("GitHub CI gate follows required checks on the exact reviewed SHA", async () => {
  const transport = new MockTransport((request) => {
    const shared = common(request);
    if (shared) return shared;
    if (request.path.includes("/commits/reviewed-sha/check-runs"))
      return response(200, {
        total_count: 1,
        check_runs: [
          {
            name: "CI / test",
            status: "completed",
            conclusion: "success",
            details_url: "https://example.test/check/1",
          },
        ],
      });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const result = await adapter.waitForPullRequestChecks({
    headSha: "reviewed-sha",
    baseBranch: "staging",
    timeoutMs: 100,
    pollIntervalMs: 1,
  });
  assert.equal(result.headSha, "reviewed-sha");
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.requiredContexts, ["CI / test"]);
  assert.deepEqual(result.checks, [
    {
      name: "CI / test",
      required: true,
      status: "passed",
      detailsUrl: "https://example.test/check/1",
    },
  ]);
});

test("GitHub CI gate fails closed on a configured check failure", async () => {
  const transport = new MockTransport((request) => {
    const shared = common(request);
    if (shared) return shared;
    if (request.path.includes("/check-runs"))
      return response(200, {
        total_count: 1,
        check_runs: [
          {
            name: "CI / test",
            status: "completed",
            conclusion: "failure",
            details_url: null,
          },
        ],
      });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const result = await adapter.waitForPullRequestChecks({
    headSha: "failed-sha",
    baseBranch: "staging",
    timeoutMs: 100,
    pollIntervalMs: 1,
  });
  assert.deepEqual(result.checks, [
    { name: "CI / test", required: true, status: "failed" },
  ]);
});

test("GitHub CI gate reports a missing required context as unknown", async () => {
  const transport = new MockTransport((request) => {
    const shared = common(request);
    if (shared) return shared;
    if (request.path.includes("/check-runs"))
      return response(200, { total_count: 0, check_runs: [] });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const result = await adapter.waitForPullRequestChecks({
    headSha: "missing-sha",
    baseBranch: "staging",
    timeoutMs: 1,
    pollIntervalMs: 1,
  });
  assert.equal(result.timedOut, true);
  assert.ok(
    result.checks.some(
      (check) => check.name === "CI / test" && check.status === "unknown",
    ),
  );
});

test("blocked_by dependency reads are typed, paginated, and deduplicated", async () => {
  const transport = new MockTransport((request) => {
    const url = new URL(request.path, "https://api.github.com");
    const page = Number(url.searchParams.get("page") ?? "1");
    if (page === 1)
      return {
        status: 200,
        data: [{ number: 7 }, { number: 8 }],
        headers: {
          link: '<https://api.github.com/repos/owner/repo/issues/9/dependencies/blocked_by?per_page=100&page=2>; rel="next"',
        },
      };
    return response(200, [{ number: 7, dependency_type: "blocked_by" }]);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");

  assert.deepEqual(await adapter.listIssueBlockedBy(9), [7, 8]);
  assert.equal(transport.requests.length, 2);
  assert.match(transport.requests[0]?.path ?? "", /blocked_by\?per_page=100$/);
  assert.match(transport.requests[1]?.path ?? "", /blocked_by\?.*page=2$/);
});

test("blocked_by dependency reads reject untyped dependency records", async () => {
  const transport = new MockTransport(() =>
    response(200, [{ number: 7, pull_request: {} }]),
  );
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  await assert.rejects(
    adapter.listIssueBlockedBy(9),
    (error) => error instanceof GitHubApiError && error.status === 422,
  );
});

test("issue label lookup follows pagination and excludes pull requests", async () => {
  const transport = new MockTransport((request) => {
    const url = new URL(request.path, "https://api.github.com");
    const page = Number(url.searchParams.get("page") ?? "1");
    const issue = (number: number) => ({
      number,
      title: `Issue ${number}`,
      body: "body",
      state: "open",
      labels: [{ name: "review-finding" }],
      html_url: `https://example.test/issues/${number}`,
    });
    if (page === 1)
      return {
        status: 200,
        data: [issue(1), { ...issue(99), pull_request: {} }],
        headers: {
          link: '<https://api.github.com/repos/owner/repo/issues?state=open&labels=review-finding&per_page=100&page=2>; rel="next"',
        },
      };
    return response(200, [issue(2)]);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");

  const issues = await adapter.listIssuesByLabel("review-finding", "open");
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [1, 2],
  );
});

test("PR collection helpers sort results and resolve route aliases", async () => {
  const transport = new MockTransport((request) => {
    assert.equal(request.method, "GET");
    assert.equal(
      request.path,
      "/repos/owner/repo/pulls?state=open&per_page=100&head=owner%3Astaging&base=main",
    );
    return response(200, [
      pullData({ number: 9, headRef: "staging", baseRef: "main" }),
      pullData({ number: 3, headRef: "staging", baseRef: "main" }),
    ]);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const pulls = await adapter.listPullRequests("feature");
  assert.deepEqual(
    pulls.map((pull) => pull.number),
    [3, 9],
  );
  assert.deepEqual(adapter.configuredStagingToMainRoute(), {
    headRef: "staging",
    baseRef: "main",
  });
});

test("pull artifacts paginate markers and read back the exact created comment", async () => {
  const comments = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    body: `Historical comment ${index + 1}`,
  }));
  let posts = 0;
  const transport = new MockTransport((request) => {
    const exact = request.path.match(/\/issues\/comments\/(\d+)$/);
    if (request.method === "GET" && exact) {
      const comment = comments.find((entry) => entry.id === Number(exact[1]));
      return response(comment ? 200 : 404, comment ?? {});
    }
    if (
      request.method === "GET" &&
      request.path.includes("/issues/6/comments")
    ) {
      const url = new URL(request.path, "https://api.github.com");
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * 100;
      const headers: Record<string, string> =
        start + 100 < comments.length
          ? {
              link: `<https://api.github.com/repos/owner/repo/issues/6/comments?per_page=100&page=${page + 1}>; rel="next"`,
            }
          : {};
      return {
        status: 200,
        data: comments.slice(start, start + 100),
        headers,
      };
    }
    if (
      request.method === "POST" &&
      request.path.endsWith("/issues/6/comments")
    ) {
      const comment = {
        id: Math.max(...comments.map((entry) => entry.id)) + 1,
        body: (request.body as { body: string }).body,
      };
      comments.push(comment);
      posts += 1;
      return response(201, comment);
    }
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");

  const created = await adapter.postPullArtifact({
    pullNumber: 6,
    marker: "<!-- FORGE:REVIEW_SUMMARY id=review-1 -->",
    body: "Review summary",
  });
  const repeated = await adapter.postPullArtifact({
    pullNumber: 6,
    marker: "<!-- FORGE:REVIEW_SUMMARY id=review-1 -->",
    body: "Review summary",
  });

  assert.equal(created, 101);
  assert.equal(repeated, created);
  assert.equal(posts, 1);
  assert.equal(comments.length, 101);
});

test("PR URL resolution is repository-bound and route snapshots revalidate all refs and SHAs", async () => {
  let reads = 0;
  const transport = new MockTransport((request) => {
    assert.equal(request.method, "GET");
    if (request.path.includes("/git/ref/heads/"))
      return response(200, { object: { sha: "base-sha" } });
    reads += 1;
    return response(200, {
      ...pullData({ number: 6 }),
      head: {
        ref: "forge/issue-2",
        sha: reads === 1 ? "head-sha" : "changed-head",
      },
      base: { ref: "staging", sha: "base-sha" },
    });
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const snapshot = await adapter.getPullRequestRouteSnapshot(
    "https://github.com/owner/repo/pull/6",
  );
  assert.deepEqual(snapshot, {
    pullNumber: 6,
    headRef: "forge/issue-2",
    headSha: "head-sha",
    baseRef: "staging",
    baseSha: "base-sha",
  });
  assert.throws(() => {
    (snapshot as { headSha: string }).headSha = "tampered";
  }, TypeError);
  await assert.rejects(
    adapter.revalidatePullRequestRoute(snapshot),
    (error) => error instanceof GitHubApiError && error.status === 409,
  );
  await assert.rejects(
    adapter.resolvePullRequest("https://github.com/other/repo/pull/6"),
    /must address owner\/repo/,
  );
});
