import assert from "node:assert/strict";
import test from "node:test";

import { githubRetryDelayMs } from "../../src/adapters/github-api.ts";

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
