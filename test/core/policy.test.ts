import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLocalOverrides,
  canAutoMerge,
  humanAuthorityReasonFromText,
  isHumanAuthorityReason,
  isGitHubCiRequired,
  isProtectedBranch,
  parseForgePolicy,
  PolicyValidationError,
  resolveConcreteBranch,
} from "../../src/core/policy.ts";

const rawPolicy = {
  schema: "forgedock.config/v1",
  repository: { provider: "github", name: "owner/repo" },
  state: {
    branch: "forgedock/state/v1",
    leaseSeconds: 300,
    heartbeatSeconds: 60,
  },
  branches: {
    integration: ["staging", "milestone/*"],
    protected: ["main"],
    autoMergeIntegration: true,
  },
  verification: {
    github: {
      required: true,
      requiredBranches: ["main"],
      waitTimeoutMs: 1_800_000,
      pollIntervalMs: 10_000,
    },
    commands: {
      test: { argv: ["npm", "test"], required: true, timeoutMs: 600_000 },
    },
  },
  review: { required: ["correctness", "security"], maxRounds: 3 },
  subagents: { maxConcurrent: 4, maxDepth: 2 },
};

test("wildcard-first branch policies resolve concrete route defaults", () => {
  assert.equal(
    resolveConcreteBranch(["release/*", "staging"], "fallback-staging"),
    "staging",
  );
  assert.equal(
    resolveConcreteBranch(["production/*", "main"], "fallback-main"),
    "main",
  );
  assert.equal(resolveConcreteBranch(["release/*"], "staging"), "staging");
  assert.equal(resolveConcreteBranch(["production/*"], "main"), "main");
});

test("tracked policy enables only non-protected integration auto-merge", () => {
  const policy = parseForgePolicy(rawPolicy);
  assert.equal(canAutoMerge(policy, "staging"), true);
  assert.equal(canAutoMerge(policy, "milestone/auth"), true);
  assert.equal(canAutoMerge(policy, "release/1.0"), false);
  assert.equal(canAutoMerge(policy, "main"), false);
  assert.equal(isProtectedBranch(policy, "main"), true);
  assert.equal(isGitHubCiRequired(policy, "main"), true);
  assert.equal(isGitHubCiRequired(policy, "staging"), false);
  assert.equal(policy.verification.commands.test?.cwd, ".");
  assert.equal(policy.subagents.reviewerTimeoutMs, 900_000);
  assert.ok(policy.orchestration.maxIssues >= 25);
});

test("verification command cwd is portable, relative, and normalized", () => {
  const withCwd = (cwd: string) => ({
    ...structuredClone(rawPolicy),
    verification: {
      ...structuredClone(rawPolicy.verification),
      commands: {
        test: { ...rawPolicy.verification.commands.test, cwd },
      },
    },
  });
  assert.equal(
    parseForgePolicy(withCwd("./web")).verification.commands.test?.cwd,
    "web",
  );

  for (const cwd of ["/tmp", "C:/tmp", "\\\\server\\share", "../web", "web/../api", "web\\api", "bad\0path"])
    assert.throws(() => parseForgePolicy(withCwd(cwd)), PolicyValidationError);
});

test("human authority reasons are narrow and typed", () => {
  assert.equal(isHumanAuthorityReason("product-decision"), true);
  assert.equal(isHumanAuthorityReason("merge-conflict"), false);
  assert.equal(
    humanAuthorityReasonFromText("A legal approval is required."),
    "legal-approval",
  );
  assert.equal(
    humanAuthorityReasonFromText("Provider API timed out during retry."),
    undefined,
  );
});

test("local overrides can only tighten tracked policy", () => {
  const policy = parseForgePolicy(rawPolicy);
  const local = applyLocalOverrides(policy, {
    branches: { autoMergeIntegration: false },
    subagents: { maxConcurrent: 2 },
    verification: { commands: { test: { timeoutMs: 100_000 } } },
  });
  assert.equal(local.branches.autoMergeIntegration, false);
  assert.equal(local.subagents.maxConcurrent, 2);
  assert.equal(local.verification.commands.test?.timeoutMs, 100_000);
  assert.throws(
    () =>
      applyLocalOverrides(policy, {
        verification: { commands: { deploy: { timeoutMs: 1_000 } } },
      }),
    PolicyValidationError,
  );
});
