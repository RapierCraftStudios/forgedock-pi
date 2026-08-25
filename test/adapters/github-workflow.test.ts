import assert from "node:assert/strict";
import test from "node:test";

import type {
  GitHubRequest,
  GitHubResponse,
  GitHubTransport,
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
