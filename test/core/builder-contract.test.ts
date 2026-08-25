import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBuilderContractPaths,
  BuilderContractScopeError,
  hashBuilderContract,
  makeBuilderContractRevision,
  normalizeBuilderContract,
  parseBuilderContractReport,
  validateBuilderContractPaths,
} from "../../src/core/builder-contract.ts";

const contract = normalizeBuilderContract({
  schema: "forgedock.builder-contract/v1",
  revision: 1,
  allowedPaths: [
    { kind: "directory", path: "src/core" },
    { kind: "exact", path: "README.md" },
  ],
});

test("builder contracts canonicalize exact and directory rules", () => {
  const reordered = normalizeBuilderContract({
    schema: "forgedock.builder-contract/v1",
    revision: 1,
    allowedPaths: [
      { path: "README.md", kind: "exact" },
      { path: "src/core/**", kind: "directory" },
    ],
  });
  assert.equal(hashBuilderContract(contract), hashBuilderContract(reordered));
  assert.equal(
    validateBuilderContractPaths(contract, ["README.md", "src/core/state.ts"])
      .valid,
    true,
  );
  assert.deepEqual(
    validateBuilderContractPaths(contract, ["README.txt", "src/other.ts"])
      .violations,
    ["README.txt", "src/other.ts"],
  );
});

test("builder contracts reject traversal and fail closed for out-of-scope paths", () => {
  assert.throws(
    () =>
      normalizeBuilderContract({
        schema: "forgedock.builder-contract/v1",
        revision: 1,
        allowedPaths: [{ kind: "exact", path: "src/../secret.ts" }],
      }),
    /unsafe segment/,
  );
  assert.throws(
    () => assertBuilderContractPaths(contract, ["src/other.ts"]),
    (error) =>
      error instanceof BuilderContractScopeError &&
      error.violations[0] === "src/other.ts",
  );
});

test("builder contract reports carry a typed machine-readable artifact", () => {
  const report = `<!-- FORGE:CONTRACT -->\n## Builder Contract\n<!-- FORGE:CONTRACT:JSON -->\n\`\`\`json\n${JSON.stringify(contract)}\n\`\`\`\n<!-- FORGE:CONTRACT:JSON:END -->`;
  assert.deepEqual(parseBuilderContractReport(report), contract);
});

test("review-fix contract revisions link hashes and increment revisions", () => {
  const revision = makeBuilderContractRevision({
    previous: contract,
    addedPaths: [{ kind: "exact", path: "test/core/new.test.ts" }],
    reason: "Review finding requires a focused regression test.",
    actor: "session-1",
  });
  assert.equal(revision.revision, 2);
  assert.equal(revision.previousContractHash, hashBuilderContract(contract));
  assert.equal(
    validateBuilderContractPaths(revision.contract, ["test/core/new.test.ts"])
      .valid,
    true,
  );
});
