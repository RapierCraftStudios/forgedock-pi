import assert from "node:assert/strict";
import test from "node:test";

import { parseForgePolicy } from "../../src/core/policy.ts";
import { isAllowedFinalizationBase } from "../../src/workflows/finalization.ts";

const policy = parseForgePolicy({
  schema: "forgedock.config/v1",
  repository: { provider: "github", name: "owner/repo" },
  state: {
    branch: "forgedock/state/v1",
    leaseSeconds: 300,
    heartbeatSeconds: 60,
  },
  branches: {
    integration: ["staging"],
    protected: ["main"],
    autoMergeIntegration: true,
  },
  verification: { commands: {} },
  review: { required: ["correctness", "security"], maxRounds: 3 },
  subagents: { maxConcurrent: 2, maxDepth: 2 },
});

test("finalization base authority stays outside UI rendering", () => {
  assert.equal(isAllowedFinalizationBase(policy, "staging"), true);
  assert.equal(isAllowedFinalizationBase(policy, "main"), false);
});
