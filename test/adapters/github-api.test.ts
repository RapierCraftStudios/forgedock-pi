import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthorityGuardedGitHubTransport,
  githubRetryDelayMs,
  type GitHubRequest,
  type GitHubResponse,
  type GitHubTransport,
} from "../../src/adapters/github-api.ts";

test("GitHub mutation transport revalidates authority for every write", async () => {
  const requests: GitHubRequest[] = [];
  const inner: GitHubTransport = {
    async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
      requests.push(request);
      return { status: 200, data: {} as T, headers: {} };
    },
  };
  let checks = 0;
  const transport = new AuthorityGuardedGitHubTransport(inner, async () => {
    checks += 1;
    if (checks === 2) throw new Error("authority revoked");
  });

  await transport.request({ method: "GET", path: "/read" });
  await transport.request({ method: "POST", path: "/first-write" });
  await assert.rejects(
    transport.request({ method: "PATCH", path: "/stale-write" }),
    /authority revoked/,
  );
  assert.equal(checks, 2);
  assert.deepEqual(
    requests.map((request) => request.path),
    ["/read", "/first-write"],
  );
});

test("GitHub mutation retries revalidate authority after backoff", async () => {
  let retrySent = false;
  const inner: GitHubTransport = {
    async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
      await request.beforeRetry?.();
      retrySent = true;
      return { status: 200, data: {} as T, headers: {} };
    },
  };
  let checks = 0;
  const transport = new AuthorityGuardedGitHubTransport(inner, async () => {
    checks += 1;
    if (checks > 1) throw new Error("authority revoked during backoff");
  });
  await assert.rejects(
    transport.request({ method: "POST", path: "/write" }),
    /authority revoked during backoff/,
  );
  assert.equal(checks, 2);
  assert.equal(retrySent, false);
});

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
      { status: 503, data: {}, headers: {} },
      2,
      now,
    ),
    8_000,
  );
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
