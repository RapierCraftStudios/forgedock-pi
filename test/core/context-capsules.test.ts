import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPSULE_SCHEMAS,
  sealCapsule,
  validateCapsule,
} from "../../src/core/context-capsules.ts";

const base = {
  schema: CAPSULE_SCHEMAS.investigation,
  runId: "run-1",
  issueNumber: 42,
  repository: "owner/repo",
  baseBranch: "staging",
  baseSha: "abcdef1234567890",
  provenance: {
    producerRole: "forge-investigator",
    runId: "run-1",
    sourceHash: "sha256:source",
    createdAt: "2026-08-26T00:00:00.000Z",
  },
  issueSnapshotHash: "sha256:issue",
  taskType: "bug" as const,
  facts: [{ statement: "The failure reproduces.", evidence: ["test:a"] }],
  acceptanceCriteria: ["Fix the failure."],
  decomposition: [],
  hazards: [],
  unresolvedAmbiguities: [],
  context: [],
};

test("capsules are deterministic, sealed, and tamper-evident", () => {
  const first = sealCapsule(base);
  const second = sealCapsule(structuredClone(base));
  assert.equal(first.digest, second.digest);
  assert.doesNotThrow(() => validateCapsule(first));
  assert.throws(
    () => validateCapsule({ ...first, taskType: "feature" }),
    /digest does not match/,
  );
});

test("capsule validation enforces identity and size", () => {
  const capsule = sealCapsule(base);
  assert.throws(() => validateCapsule(capsule, { maxBytes: 10 }), /size limit/);
  assert.throws(
    () => validateCapsule({ ...capsule, issueNumber: 0 }),
    /issueNumber/,
  );
});
