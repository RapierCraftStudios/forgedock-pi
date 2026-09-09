import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBuilderContractPaths,
  assertBuilderContractProofRows,
  BuilderContractViolationError,
  createBuilderPathContract,
  validateBuilderContract,
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

test("contract hashes bind normalized paths and revisions", () => {
  const first = createBuilderPathContract(["./src/a.ts", "test/**"]);
  const repeated = createBuilderPathContract(["test/**", "src/a.ts"]);
  const revised = createBuilderPathContract(["src/a.ts", "test/**"], 2);
  assert.equal(first.contractHash, repeated.contractHash);
  assert.notEqual(first.contractHash, revised.contractHash);
  assert.doesNotThrow(() => validateBuilderPathContract(first));
  assert.throws(() => validateBuilderContract(first), /immutable brief/);
  assert.throws(() =>
    validateBuilderPathContract({ ...first, contractHash: "tampered" }),
  );
});

test("full builder briefs are hash-bound and immutable", () => {
  const contract = createBuilderPathContract(["src/**"], 1, {
    objective: "Preserve the review decision.",
    allowedPaths: ["src/**"],
    forbiddenChanges: ["Review policy"],
    invariants: ["The decision remains stable."],
    deliverables: ["One implementation change."],
    acceptanceMapping: [
      {
        checkId: "AC-1",
        implementation: {
          proofKind: "behavioral",
          mechanism: "review gate",
          boundary: "protected branch",
          test: "test/review.test.ts",
          trigger: "unapproved merge",
          assertion: "returns needs-human",
          baseline: "fails before the test",
          passAfter: "passes after the test",
          prerequisite: "npm test",
          residualRisk: "none",
        },
      },
    ],
    outOfScope: [],
  });
  assert.ok(contract.brief);
  assert.doesNotThrow(() => validateBuilderContract(contract));
  assert.doesNotThrow(() => assertBuilderContractProofRows(contract));
  const tampered = structuredClone(contract);
  tampered.brief!.objective = "Changed by remediation context.";
  assert.throws(
    () => validateBuilderPathContract(tampered),
    /hash does not match|not canonical/,
  );
});

test("parent readiness rejects missing, generic, and static-only proof rows", () => {
  const contract = createBuilderPathContract(["src/**"], 1, {
    objective: "Preserve the review decision.",
    allowedPaths: ["src/**"],
    forbiddenChanges: ["Review policy"],
    invariants: ["The decision remains stable."],
    deliverables: ["One implementation change."],
    acceptanceMapping: [
      {
        checkId: "AC-1",
        implementation: {
          proofKind: "behavioral",
          mechanism: "evaluateReviewGate",
          boundary: "protected branch",
          test: "test/review.test.ts",
          trigger: "unapproved merge request",
          assertion: "returns needs-human",
          baseline: "fails before the test",
          passAfter: "passes after the test",
          prerequisite: "npm test",
          residualRisk: "none",
        },
      },
    ],
    outOfScope: [],
  });

  assert.doesNotThrow(() => assertBuilderContractProofRows(contract));
  assert.throws(
    () => assertBuilderContractProofRows(undefined),
    /Builder contract must be an object/,
  );

  for (const field of [
    "mechanism",
    "boundary",
    "test",
    "trigger",
    "assertion",
  ] as const) {
    const invalid = createBuilderPathContract(contract.allowedPaths, 1, {
      ...contract.brief!,
      acceptanceMapping: [
        {
          checkId: "AC-1",
          implementation: {
            ...contract.brief!.acceptanceMapping[0]!.implementation,
            [field]: field,
          },
        },
      ],
    });
    assert.throws(
      () => assertBuilderContractProofRows(invalid),
      new RegExp(`AC-1\\.${field} is generic`),
    );
  }

  const staticOnly = createBuilderPathContract(contract.allowedPaths, 1, {
    ...contract.brief!,
    acceptanceMapping: [
      {
        checkId: "AC-1",
        implementation: {
          ...contract.brief!.acceptanceMapping[0]!.implementation,
          proofKind: "inspection",
        },
      },
    ],
  });
  assert.throws(
    () => assertBuilderContractProofRows(staticOnly),
    /AC-1\.proofKind is static-only/,
  );
});
