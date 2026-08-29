import assert from "node:assert/strict";
import test from "node:test";

import {
  forgeCapabilityDiagnostics,
  FORGE_COORDINATOR_CAPABILITY_PROFILE,
  validateForgeAgentCapabilityProfile,
} from "../../src/agents/profile.ts";

test("nested-review capability profiles fail closed before registration", () => {
  assert.doesNotThrow(() =>
    validateForgeAgentCapabilityProfile(FORGE_COORDINATOR_CAPABILITY_PROFILE),
  );
  assert.throws(
    () =>
      validateForgeAgentCapabilityProfile({
        name: "broken-coordinator",
        tools: ["read"],
        allowNestedSubagents: true,
        maxSubagentDepth: 2,
      }),
    /does not resolve the native subagent tool/,
  );
  assert.throws(
    () =>
      validateForgeAgentCapabilityProfile({
        name: "shallow-coordinator",
        tools: ["subagent"],
        allowNestedSubagents: true,
        maxSubagentDepth: 1,
      }),
    /depth ceiling/,
  );
});

test("capability diagnostics expose resolved tools and nesting without secrets", () => {
  const diagnostics = forgeCapabilityDiagnostics(["read", "subagent", "read"]);
  assert.deepEqual(diagnostics, [
    "nested reviewer: available",
    "nested depth ceiling: 2",
    "coordinator resolved tools: read, subagent",
  ]);
  assert.doesNotMatch(diagnostics.join("\n"), /token|secret|password|credential/i);
});
