import assert from "node:assert/strict";
import test from "node:test";

import {
  FORGEDOCK_EVENT_SCHEMA,
  FORGEDOCK_LEASE_SCHEMA,
  FORGEDOCK_PI_VERSION,
} from "../../src/core/version.ts";
import {
  ORCHESTRATION_EVENT_SCHEMA,
  ORCHESTRATION_RECOVERY_SCHEMA,
  ORCHESTRATION_STATE_SCHEMA,
  orchestrationChildKey,
  renderOrchestrationReloadReport,
} from "../../src/index.ts";
import type {
  OrchestrationBatchState,
  OrchestrationState,
} from "../../src/index.ts";

test("exports stable initial schema identifiers", () => {
  assert.equal(FORGEDOCK_PI_VERSION, "0.1.0");
  assert.equal(FORGEDOCK_EVENT_SCHEMA, "forgedock.run-event/v1");
  assert.equal(FORGEDOCK_LEASE_SCHEMA, "forgedock.repository-lease/v1");
});

test("exports durable orchestration contracts from the package root", () => {
  assert.equal(ORCHESTRATION_EVENT_SCHEMA, "forgedock.orchestration-event/v1");
  assert.equal(ORCHESTRATION_STATE_SCHEMA, "forgedock.orchestration-state/v1");
  assert.equal(ORCHESTRATION_RECOVERY_SCHEMA, "forgedock.orchestration-recovery/v1");
  assert.equal(orchestrationChildKey("batch-1", 42), "batch-1:issue:42");
  assert.match(
    renderOrchestrationReloadReport({
      classifications: { 42: "IN_PROGRESS" },
      resume: [42],
      reconcile: [],
      paused: false,
    }),
    /#42=IN_PROGRESS/,
  );

  const stateContract: Pick<OrchestrationState, "schema"> = {
    schema: ORCHESTRATION_STATE_SCHEMA,
  };
  const recoveryContract: Pick<OrchestrationBatchState, "schema"> = {
    schema: ORCHESTRATION_RECOVERY_SCHEMA,
  };
  assert.equal(stateContract.schema, ORCHESTRATION_STATE_SCHEMA);
  assert.equal(recoveryContract.schema, ORCHESTRATION_RECOVERY_SCHEMA);
});
