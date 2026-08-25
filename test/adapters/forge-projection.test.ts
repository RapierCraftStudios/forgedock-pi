import assert from "node:assert/strict";
import test from "node:test";

import { validatePhaseReport } from "../../src/adapters/forge-projection.ts";

test("phase projection validator keeps the acceptance-gate wire contract", () => {
  const report = [
    "<!-- FORGE:ACCEPTANCE_GATE -->",
    "## Acceptance Gate — PASSED",
    "<!-- FORGE:LOCAL_VERIFICATION -->",
    "No local commands configured; GitHub CI is deferred.",
    "<!-- FORGE:IMPLEMENTATION_READY_FOR_CI -->",
    "<!-- FORGE:ACCEPTANCE_GATE:PASSED -->",
  ].join("\n");
  assert.doesNotThrow(() => validatePhaseReport("verify", report));
  assert.throws(
    () => validatePhaseReport("verify", "<!-- FORGE:ACCEPTANCE_GATE -->"),
    /missing canonical ForgeDock fields/,
  );
});
