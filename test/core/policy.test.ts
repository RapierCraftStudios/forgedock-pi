import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLocalOverrides,
  canAutoMerge,
  isGitHubCiRequired,
  isProtectedBranch,
  parseForgePolicy,
  PolicyValidationError,
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

test("tracked policy enables only non-protected integration auto-merge", () => {
  const policy = parseForgePolicy(rawPolicy);
  assert.equal(canAutoMerge(policy, "staging"), true);
  assert.equal(canAutoMerge(policy, "milestone/auth"), true);
  assert.equal(canAutoMerge(policy, "release/1.0"), false);
  assert.equal(canAutoMerge(policy, "main"), false);
  assert.equal(isProtectedBranch(policy, "main"), true);
  assert.equal(isGitHubCiRequired(policy, "main"), true);
  assert.equal(isGitHubCiRequired(policy, "staging"), false);
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
