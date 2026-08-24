import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireLease,
  heartbeatLease,
  isLeaseExpired,
  LeaseConflictError,
  takeoverLease,
} from "../../src/core/lease.ts";

const repository = "owner/repo";
const firstOwner = { runId: "run-1", sessionId: "session-1" };
const secondOwner = { runId: "run-1", sessionId: "session-2" };
const start = new Date("2026-01-01T00:00:00.000Z");

test("lease acquisition, heartbeat, expiry, and human takeover", () => {
  const acquired = acquireLease(undefined, {
    repository,
    owner: firstOwner,
    now: start,
    ttlSeconds: 60,
  });
  assert.equal(acquired.epoch, 1);
  assert.equal(acquired.expiresAt, "2026-01-01T00:01:00.000Z");
  assert.equal(
    isLeaseExpired(acquired, new Date("2026-01-01T00:00:59.999Z")),
    false,
  );

  const heartbeat = heartbeatLease(acquired, {
    repository,
    owner: firstOwner,
    epoch: 1,
    now: new Date("2026-01-01T00:00:30.000Z"),
    ttlSeconds: 60,
  });
  assert.equal(heartbeat.expiresAt, "2026-01-01T00:01:30.000Z");

  assert.throws(
    () =>
      acquireLease(heartbeat, {
        repository,
        owner: secondOwner,
        now: new Date("2026-01-01T00:02:00.000Z"),
        ttlSeconds: 60,
      }),
    (error) =>
      error instanceof LeaseConflictError && error.code === "takeover-required",
  );

  const takenOver = takeoverLease(heartbeat, {
    repository,
    owner: secondOwner,
    now: new Date("2026-01-01T00:02:00.000Z"),
    ttlSeconds: 60,
    authorizedBy: "operator",
  });
  assert.equal(takenOver.epoch, 2);
  assert.equal(takenOver.ownerSessionId, "session-2");
  assert.equal(takenOver.takeoverAuthorizedBy, "operator");
});

test("active leases and stale epochs fail closed", () => {
  const acquired = acquireLease(undefined, {
    repository,
    owner: firstOwner,
    now: start,
    ttlSeconds: 60,
  });
  assert.throws(
    () =>
      acquireLease(acquired, {
        repository,
        owner: secondOwner,
        now: start,
        ttlSeconds: 60,
      }),
    (error) =>
      error instanceof LeaseConflictError && error.code === "active-lease",
  );
  assert.throws(
    () =>
      heartbeatLease(acquired, {
        repository,
        owner: firstOwner,
        epoch: 2,
        now: start,
        ttlSeconds: 60,
      }),
    (error) =>
      error instanceof LeaseConflictError && error.code === "stale-epoch",
  );
  assert.throws(
    () =>
      takeoverLease(acquired, {
        repository,
        owner: secondOwner,
        now: start,
        ttlSeconds: 60,
        authorizedBy: "operator",
      }),
    (error) =>
      error instanceof LeaseConflictError && error.code === "not-expired",
  );
});
