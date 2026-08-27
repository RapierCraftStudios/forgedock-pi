import assert from "node:assert/strict";
import test from "node:test";

import {
  parseReviewArguments,
  parseReviewFlags,
  parseReviewSelector,
} from "../../src/ui/forge-command-parser.ts";

test("review parser accepts exact selectors and typed flags", () => {
  assert.deepEqual(parseReviewSelector("#42"), {
    kind: "pull-request",
    pullNumber: 42,
  });
  assert.deepEqual(parseReviewSelector("https://github.com/acme/app/pull/7"), {
    kind: "pull-request-url",
    pullNumber: 7,
    url: "https://github.com/acme/app/pull/7",
  });
  assert.deepEqual(parseReviewSelector("open"), {
    kind: "collection",
    state: "open",
  });
  assert.deepEqual(parseReviewSelector("all"), {
    kind: "collection",
    state: "all",
  });
  assert.deepEqual(parseReviewSelector("staging:feature"), {
    kind: "route",
    route: "staging:feature",
  });
  assert.deepEqual(parseReviewArguments("staging --auto-merge"), {
    selector: { kind: "route", route: "staging" },
    autoMerge: true,
    ghFlags: [],
    thorough: false,
  });

  assert.deepEqual(
    parseReviewArguments(
      "42 --auto-merge --issue=19 --base=feature/fix --gh-flag=--json --gh-flag=--paginate --worktree=.forge/review --thorough --model=claude-sonnet-4-6",
    ),
    {
      selector: { kind: "pull-request", pullNumber: 42 },
      autoMerge: true,
      issueNumber: 19,
      base: "feature/fix",
      ghFlags: ["--json", "--paginate"],
      worktree: ".forge/review",
      thorough: true,
      model: "claude-sonnet-4-6",
    },
  );
});

test("review parser rejects duplicate/conflicting and unsafe arguments", () => {
  for (const input of [
    "1 2",
    "open all",
    "1 --base=one --base=two",
    "1 --gh-flag=--repo=other/repo",
    "1 --gh-flag=--method=POST",
    "1 --worktree=../outside",
    "1 --worktree=/tmp/review",
    "1 --worktree=review\\tree",
    "1; rm -rf .",
    "1 --auto-merge --auto-merge",
    "1 --gh-flag=--json --gh-flag=--json",
    "open --auto-merge",
  ]) {
    assert.throws(() => parseReviewArguments(input), input);
  }
  assert.throws(() => parseReviewFlags("--model=../unsafe"), /Unsafe review model/);
  assert.throws(
    () => parseReviewSelector("https://evil.example/pull/1"),
    /exact GitHub pull request URL/,
  );
});
