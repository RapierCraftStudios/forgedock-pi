import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBuilderContractPaths,
  assertProofClosure,
  BuilderContractViolationError,
  createBuilderPathContract,
  createProofClosureContract,
  validateBuilderPathContract,
} from "../../src/core/builder-contract.ts";

test("builder path contracts accept exact paths and directory patterns", () => {
  const contract = createBuilderPathContract([
    "src/exact.ts",
    "test/**",
    "docs/*.md",
  ]);
  assert.doesNotThrow(() =>
    assertBuilderContractPaths(contract, [
      "src/exact.ts",
      "test/core/example.test.ts",
      "docs/guide.md",
    ]),
  );
  assert.throws(
    () => assertBuilderContractPaths(contract, ["src/other.ts"]),
    (error: unknown) =>
      error instanceof BuilderContractViolationError &&
      error.violations[0] === "src/other.ts",
  );
});

test("builder contracts cover both sides of renames and deletions", () => {
  const contract = createBuilderPathContract(["src/old.ts", "src/new.ts"]);
  assert.doesNotThrow(() =>
    assertBuilderContractPaths(contract, ["src/old.ts", "src/new.ts"]),
  );
  assert.throws(() =>
    assertBuilderContractPaths(contract, ["src/old.ts", "secrets/new.ts"]),
  );
});

test("proof closure binds identity and rejects incomplete required obligations", () => {
  const row = {
    criterion: "AC-1",
    invariant: "No data loss",
    counterexample: "Concurrent mutation between reads",
    boundaryConsumers: "queue producer and cursor consumer",
    testCommand: "npm test -- proof",
    failingBefore: "fixture loses the item",
    passingAfter: "fixture preserves the item",
    state: "PASS" as const,
    required: true,
  };
  const contract = createProofClosureContract({
    repository: "owner/repo",
    issueNumber: 505,
    target: "staging",
    baseSha: "a".repeat(40),
    risk: "high",
    riskSignals: ["concurrency"],
    obligations: [row],
  });
  assert.doesNotThrow(() =>
    assertProofClosure(contract, {
      repository: "owner/repo",
      issueNumber: 505,
      target: "staging",
      baseSha: "a".repeat(40),
    }),
  );
  const pathContract = createBuilderPathContract(["src/**"], 1, contract);
  assert.doesNotThrow(() => validateBuilderPathContract(pathContract));
  for (const state of ["FAIL", "MISSING", "UNKNOWN", "CONTRADICTED", "SKIPPED"] as const)
    assert.throws(() =>
      assertProofClosure({ ...contract, obligations: [{ ...row, state }] }, contract),
      /not closed/,
    );
  assert.doesNotThrow(() =>
    assertProofClosure(
      { ...contract, risk: "low", riskSignals: [], obligations: [{ ...row, required: false, state: "SKIPPED" }] },
      contract,
    ),
  );
  assert.throws(() =>
    assertProofClosure(contract, { ...contract, issueNumber: 506 }),
    /identity/,
  );
  assert.throws(() =>
    validateBuilderPathContract({
      ...pathContract,
      proofClosure: { ...contract, unknown: true },
    }),
    /shape/,
  );
  assert.throws(() =>
    validateBuilderPathContract({
      ...pathContract,
      proofClosure: {
        ...contract,
        obligations: [{ ...row, invariant: " " }],
      },
    }),
    /shape/,
  );
  assert.throws(() =>
    assertProofClosure({ ...contract, risk: "low" }, contract),
    /shape/,
  );
  assert.throws(
    () => createProofClosureContract({
      ...contract,
      obligations: [row, { ...row, criterion: row.criterion }],
    }),
    /unique/,
  );
});

test("contract hashes bind normalized paths and revisions", () => {
  const first = createBuilderPathContract(["./src/a.ts", "test/**"]);
  const repeated = createBuilderPathContract(["test/**", "src/a.ts"]);
  const revised = createBuilderPathContract(["src/a.ts", "test/**"], 2);
  assert.equal(first.contractHash, repeated.contractHash);
  assert.notEqual(first.contractHash, revised.contractHash);
  assert.doesNotThrow(() => validateBuilderPathContract(first));
  assert.throws(() =>
    validateBuilderPathContract({ ...first, contractHash: "tampered" }),
  );
});
