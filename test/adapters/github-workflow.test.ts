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
    assert.match(
      request.path,
      /head=owner%3Aforge%2Fissue-2&per_page=20$/,
    );
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

test("merge rejects a retargeted or advanced pull base", async (t) => {
  for (const current of [
    { headSha: "reviewed-head", baseSha: "advanced-base", baseRef: "staging" },
    { headSha: "reviewed-head", baseSha: "reviewed-base", baseRef: "main" },
  ]) {
    await t.test(`${current.baseRef}@${current.baseSha}`, async () => {
      const transport = new MockTransport((request) => {
        if (request.method === "GET" && request.path.endsWith("/pulls/7"))
          return response(200, {
            number: 7,
            html_url: "https://example.test/pr/7",
            state: "open",
            merged: false,
            head: { sha: current.headSha, ref: "forge/issue-7" },
            base: { sha: current.baseSha, ref: current.baseRef },
            mergeable: true,
          });
        throw new Error(`Unexpected request ${request.method} ${request.path}`);
      });
      const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
      await assert.rejects(
        adapter.mergePullRequest({
          pullNumber: 7,
          expectedHeadSha: "reviewed-head",
          expectedBaseSha: "reviewed-base",
          expectedBaseRef: "staging",
        }),
        (error: unknown) =>
          error instanceof GitHubApiError &&
          error.status === 409 &&
          JSON.stringify(error.response).includes("Stale reviewed pull identity"),
      );
      assert.equal(
        transport.requests.some((request) => request.method === "PUT"),
        false,
      );
    });
  }
});

test("merge sends the reviewed identity only after exact pull revalidation", async () => {
  const transport = new MockTransport((request) => {
    if (request.method === "GET" && request.path.endsWith("/pulls/7"))
      return response(200, {
        number: 7,
        html_url: "https://example.test/pr/7",
        state: "open",
        merged: false,
        head: { sha: "reviewed-head", ref: "forge/issue-7" },
        base: { sha: "reviewed-base", ref: "staging" },
        mergeable: true,
      });
    if (request.method === "PUT" && request.path.endsWith("/pulls/7/merge"))
      return response(200, {
        merged: true,
        sha: "merge-sha",
        message: "merged",
      });
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const adapter = new GitHubWorkflowAdapter(transport, "owner/repo");
  const result = await adapter.mergePullRequest({
    pullNumber: 7,
    expectedHeadSha: "reviewed-head",
    expectedBaseSha: "reviewed-base",
    expectedBaseRef: "staging",
  });
  assert.equal(result.sha, "merge-sha");
  assert.deepEqual(
    transport.requests.find((request) => request.method === "PUT")?.body,
    { sha: "reviewed-head", merge_method: "squash" },
  );
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
