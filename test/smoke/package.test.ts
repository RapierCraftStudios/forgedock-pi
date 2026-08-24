import assert from "node:assert/strict";
import test from "node:test";

import {
  FORGEDOCK_EVENT_SCHEMA,
  FORGEDOCK_LEASE_SCHEMA,
  FORGEDOCK_PI_VERSION,
} from "../../src/core/version.ts";

test("exports stable initial schema identifiers", () => {
  assert.equal(FORGEDOCK_PI_VERSION, "0.1.0");
  assert.equal(FORGEDOCK_EVENT_SCHEMA, "forgedock.run-event/v1");
  assert.equal(FORGEDOCK_LEASE_SCHEMA, "forgedock.repository-lease/v1");
});
