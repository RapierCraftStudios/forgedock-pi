import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBuilderContractPaths,
  BuilderContractViolationError,
  createBuilderPathContract,
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
  assert.throws(() =>
    validateBuilderPathContract({ ...first, contractHash: "tampered" }),
  );
});
