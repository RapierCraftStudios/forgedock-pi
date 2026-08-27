import assert from "node:assert/strict";
import test from "node:test";

import {
  FetchGitHubTransport,
  GitHubApiError,
  type GitHubTransport,
  githubRequestRetryDelayMs,
  githubRetryDelayMs,
  readGitHubCoreRateLimit,
} from "../../src/adapters/github-api.ts";

test("GitHub transient retry honors rate-limit and server failures", () => {
  const now = 1_000_000;
  assert.equal(
    githubRetryDelayMs(
      {
        status: 403,
        data: { message: "API rate limit exceeded" },
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((now + 5_000) / 1_000),
        },
      },
      0,
      now,
    ),
    6_000,
  );
  assert.equal(
    githubRetryDelayMs(
      {
        status: 403,
        data: { message: "You have exceeded a secondary rate limit" },
        headers: { "retry-after": "3" },
      },
      0,
      now,
    ),
    3_000,
  );
  assert.equal(
    githubRetryDelayMs(
      {
        status: 403,
        data: { message: "API rate limit exceeded" },
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((now + 10 * 60_000) / 1_000),
        },
      },
      0,
      now,
    ),
    10 * 60_000 + 1_000,
  );
  assert.equal(
    githubRetryDelayMs({ status: 503, data: {}, headers: {} }, 2, now),
    8_000,
  );
});

test("GitHub transport retries only safe or explicitly reconciled methods", () => {
  const response = { status: 503, data: {}, headers: {} };
  assert.equal(
    githubRequestRetryDelayMs({ method: "POST" }, response, 0, Date.now()),
    undefined,
  );
  assert.equal(
    githubRequestRetryDelayMs(
      { method: "POST", retryTransient: true },
      response,
      0,
      Date.now(),
    ),
    2_000,
  );
  assert.equal(
    githubRequestRetryDelayMs(
      { method: "POST" },
      {
        status: 403,
        data: { message: "API rate limit exceeded" },
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1005",
        },
      },
      0,
      1_000_000,
    ),
    6_000,
  );
  assert.equal(
    githubRequestRetryDelayMs({ method: "GET" }, response, 0, Date.now()),
    2_000,
  );
});

test("GitHub transport refreshes provider authentication once after 401", async () => {
  let refreshes = 0;
  const authorizations: string[] = [];
  const transport = new FetchGitHubTransport({
    tokenProvider: {
      get: async () => "token-a",
      refresh: async () => {
        refreshes += 1;
        return "token-b";
      },
    },
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = String(
        (init?.headers as Record<string, string> | undefined)?.Authorization,
      );
      authorizations.push(authorization);
      return new Response(
        JSON.stringify(
          authorization === "Bearer token-a"
            ? { message: "Bad credentials" }
            : { ok: true },
        ),
        {
          status: authorization === "Bearer token-a" ? 401 : 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch,
  });

  const result = await transport.request<{ ok: boolean }>({
    method: "GET",
    path: "/user",
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(refreshes, 1);
  assert.deepEqual(authorizations, ["Bearer token-a", "Bearer token-b"]);
});

test("GitHub core rate-limit budget is parsed as scheduling authority", async () => {
  const transport: GitHubTransport = {
    async request<T>() {
      return {
        status: 200,
        data: {
          resources: {
            core: { limit: 5_000, remaining: 4_200, reset: 2_000_000_000 },
          },
        } as T,
        headers: {},
      };
    },
  };
  const budget = await readGitHubCoreRateLimit(transport);
  assert.deepEqual(budget, {
    limit: 5_000,
    remaining: 4_200,
    resetAt: 2_000_000_000_000,
  });
});

test("GitHub API errors expose bounded safe diagnostics", () => {
  const error = new GitHubApiError(422, "/issues/1/comments", {
    message: `Projection read-back mismatch ${"x".repeat(400)}`,
  });
  assert.match(error.message, /Projection read-back mismatch/);
  assert.ok(error.message.length < 380);

  const redacted = new GitHubApiError(401, "/user", {
    message: "Bad credentials Bearer ghp_secret-token",
  });
  assert.doesNotMatch(redacted.message, /ghp_secret-token/);
});

test("GitHub retry does not retry permission failures", () => {
  assert.equal(
    githubRetryDelayMs(
      {
        status: 403,
        data: { message: "Resource not accessible by integration" },
        headers: { "x-ratelimit-remaining": "100" },
      },
      0,
      Date.now(),
    ),
    undefined,
  );
});
