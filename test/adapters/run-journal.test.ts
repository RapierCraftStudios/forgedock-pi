import assert from "node:assert/strict";
import test from "node:test";

import { assertCurrentAuthority } from "../../src/adapters/run-journal.ts";
import { FORGEDOCK_LEASE_SCHEMA } from "../../src/core/version.ts";
import type { RepositoryLease } from "../../src/core/lease.ts";
import type { RunState } from "../../src/core/state.ts";

const expiredLease: RepositoryLease = {
  schema: FORGEDOCK_LEASE_SCHEMA,
  repository: "owner/repo",
  ownerRunId: "orchestration-1",
  ownerSessionId: "session-1",
  epoch: 2,
  acquiredAt: "2026-08-25T00:00:00.000Z",
  lastHeartbeatAt: "2026-08-25T00:00:00.000Z",
  expiresAt: "2026-08-25T00:01:00.000Z",
  takeoverRequired: false,
};
const boundState = {
  runId: "run-1",
  leaseBinding: { ownerRunId: "orchestration-1", epoch: 2 },
} as RunState;

test("only explicit human takeover cancellation may use an expired matching lease", () => {
  assert.throws(
    () => assertCurrentAuthority(boundState, expiredLease),
    /binding is stale/,
  );
  assert.doesNotThrow(() =>
    assertCurrentAuthority(boundState, expiredLease, true),
  );
  assert.throws(
    () =>
      assertCurrentAuthority(
        boundState,
        { ...expiredLease, epoch: 3 },
        true,
      ),
    /binding is stale/,
  );
});
