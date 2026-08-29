import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveStagingBundle,
  StagingBundleResolutionError,
  type FrozenStagingBundleRoute,
  type StagingBundleCandidate,
} from "../../src/core/staging-bundle-resolver.ts";

const route: FrozenStagingBundleRoute = {
  repository: "owner/repo",
  baseRef: "main",
  baseSha: "base-2026",
  headRef: "staging",
  headSha: "staging-2026",
  integrationPullNumber: 999,
};

const candidates: readonly StagingBundleCandidate[] = [
  // Historical merge commit whose subject could contain an issue reference.
  {
    repository: "owner/repo",
    number: 12,
    state: "closed",
    merged: true,
    baseRef: "staging",
    headSha: "historical-head",
    mergeCommitSha: "historical-merge",
  },
  // Squash merge: the branch head is gone, but GitHub's squash commit remains.
  {
    repository: "owner/repo",
    number: 14,
    state: "closed",
    merged: true,
    baseRef: "staging",
    headSha: "squash-branch-head",
    mergeCommitSha: "squash-merge",
  },
  // Rebase merge: there is no useful merge commit; the rebased head is present.
  {
    repository: "owner/repo",
    number: 15,
    state: "closed",
    merged: true,
    baseRef: "staging",
    headSha: "rebased-head",
  },
  // An issue number in a subject is not PR identity and is never consulted.
  {
    repository: "owner/repo",
    number: 16,
    state: "open",
    merged: false,
    baseRef: "staging",
    headSha: "unrelated-branch",
  },
];

function probe(sha: string, target: "base" | "head"): boolean {
  return (
    target === "head" &&
    ["historical-merge", "squash-merge", "rebased-head"].includes(sha)
  );
}

test("resolves historical, squash, and rebase PRs using frozen reachability", () => {
  const resolution = resolveStagingBundle({
    route,
    candidates,
    isReachable: probe,
  });

  assert.deepEqual(
    resolution.resolved.map((pull) => [pull.pullNumber, pull.evidence]),
    [
      [12, ["merge"]],
      [14, ["merge"]],
      [15, ["head"]],
    ],
  );
  assert.equal(resolution.schema, "forgedock.staging-bundle-resolution/v1");
  assert.equal(
    resolution.exclusions.find((entry) => entry.pullNumber === 16)?.reason,
    "no-reachable-merge-head-or-patch-evidence",
  );
  assert.equal(resolution.route.baseSha, "base-2026");
  assert.equal(resolution.route.headSha, "staging-2026");
});

test("excludes commits already reachable from frozen base and unrelated repository PRs", () => {
  const resolution = resolveStagingBundle({
    route,
    candidates: [
      {
        ...candidates[0]!,
        number: 22,
        headSha: "already-in-main",
        mergeCommitSha: "already-in-main",
      },
      {
        ...candidates[0]!,
        number: 23,
        repository: "other/repo",
        headSha: "foreign-head",
      },
    ],
    isReachable: (sha, target) =>
      (sha === "already-in-main" && (target === "head" || target === "base")) ||
      (sha === "foreign-head" && target === "head"),
  });

  assert.deepEqual(resolution.resolved, []);
  assert.deepEqual(
    resolution.exclusions.map((entry) => entry.reason),
    ["already-reachable-from-base", "repository-identity-mismatch"],
  );
});

test("does not infer PRs from issue IDs or commit-message-like fields", () => {
  const resolution = resolveStagingBundle({
    route,
    candidates: [
      {
        ...candidates[0]!,
        number: 31,
        headSha: "subject-says-#31",
        mergeCommitSha: null,
      },
    ],
    isReachable: () => false,
  });
  assert.equal(resolution.resolved.length, 0);
  assert.equal(resolution.derivations[0]?.evidence[0]?.sha, "subject-says-#31");
});

test("fails closed when paginated metadata repeats a PR identity", () => {
  assert.throws(
    () =>
      resolveStagingBundle({
        route,
        candidates: [candidates[0]!, { ...candidates[0]! }],
        isReachable: probe,
      }),
    (error) =>
      error instanceof StagingBundleResolutionError &&
      error.reason === "ambiguous" &&
      /duplicate pull request owner\/repo#12/.test(error.message),
  );
});

test("keeps unrelated open findings outside the resolved PR set", () => {
  const resolution = resolveStagingBundle({
    route,
    candidates: [candidates[0]!, candidates[3]!],
    isReachable: probe,
  });
  const findingSources = [12, 88];
  const blockingSources = findingSources.filter((source) =>
    resolution.resolved.some((pull) => pull.pullNumber === source),
  );
  assert.deepEqual(blockingSources, [12]);
});
