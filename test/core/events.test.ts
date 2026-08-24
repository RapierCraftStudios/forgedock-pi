import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  createRunEvent,
  hashRunEvent,
} from "../../src/core/events.ts";

test("canonical JSON and event hashes are key-order stable", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { d: 2, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 2 }, z: 1 }),
  );
  const common = {
    runId: "run-1",
    repository: "owner/repo",
    sequence: 1,
    previousEventHash: null,
    type: "run.created" as const,
    actor: {
      kind: "extension" as const,
      sessionId: "session-1",
      leaseEpoch: 0,
    },
    idempotencyKey: "run:create",
    eventId: "event-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
  };
  const left = createRunEvent({
    ...common,
    payload: {
      issueNumber: 1,
      integrationBranch: "staging",
      protectedBranch: "main",
    },
  });
  const right = createRunEvent({
    ...common,
    payload: {
      protectedBranch: "main",
      integrationBranch: "staging",
      issueNumber: 1,
    },
  });
  assert.equal(hashRunEvent(left), hashRunEvent(right));
});
