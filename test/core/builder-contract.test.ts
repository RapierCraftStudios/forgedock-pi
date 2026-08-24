import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBuilderContractPaths,
  createBuilderContractArtifact,
  extendBuilderContract,
  findBuilderContractViolations,
  isBuilderPathAllowed,
  parseBuilderContractReport,
  parseGitNameStatusOutput,
  parsePorcelainStatusPaths,
  BuilderContractError,
} from "../../src/core/builder-contract.ts";

function contract() {
  return createBuilderContractArtifact({
    allowedPaths: [
      { kind: "exact", path: "src/core/events.ts" },
      { kind: "directory", path: "test/core" },
    ],
  });
}

test("builder contract hashes normalized exact and directory rules", () => {
  const left = createBuilderContractArtifact({
    allowedPaths: [
      { kind: "directory", path: "test/core/**" },
      { kind: "exact", path: "src/core/events.ts" },
    ],
  });
  const right = createBuilderContractArtifact({
    allowedPaths: [
      { kind: "exact", path: "src/core/events.ts" },
      { kind: "directory", path: "./test/core" },
    ],
  });
  assert.equal(left.contractHash, right.contractHash);
  assert.equal(isBuilderPathAllowed(left, "src/core/events.ts"), true);
  assert.equal(isBuilderPathAllowed(left, "test/core/nested.test.ts"), true);
  assert.equal(isBuilderPathAllowed(left, "test/corex/nested.test.ts"), false);
});

test("contract validation covers additions, deletions, and both rename paths", () => {
  const accepted = contract();
  assert.doesNotThrow(() =>
    assertBuilderContractPaths(accepted, [
      "src/core/events.ts",
      "test/core/builder-contract.test.ts",
    ]),
  );
  assert.deepEqual(
    findBuilderContractViolations(accepted, [
      "src/core/events.ts",
      "src/workflows/work-on.ts",
      "src/old.ts",
    ]),
    ["src/old.ts", "src/workflows/work-on.ts"],
  );
  assert.throws(
    () => assertBuilderContractPaths(accepted, ["src/old.ts"]),
    (error) =>
      error instanceof BuilderContractError &&
      error.code === "out-of-contract-path",
  );
});

test("Git name-status and porcelain parsing retain source and destination paths", () => {
  assert.deepEqual(
    parseGitNameStatusOutput(
      "M\tsrc/core/events.ts\nD\tsrc/removed.ts\nR100\tsrc/old.ts\tsrc/core/events.ts\nC075\ttest/core/a.ts\ttest/core/b.ts\n",
    ),
    [
      "src/core/events.ts",
      "src/removed.ts",
      "src/old.ts",
      "test/core/a.ts",
      "test/core/b.ts",
    ],
  );
  assert.deepEqual(
    parsePorcelainStatusPaths(
      " M src/core/events.ts\0R  src/old.ts\0src/core/events.ts\0?? test/core/new.ts\0",
    ),
    ["src/core/events.ts", "src/old.ts", "test/core/new.ts"],
  );
});

test("contract reports are typed artifacts and extensions are audited revisions", () => {
  const initial = parseBuilderContractReport(`<!-- FORGE:CONTRACT -->
## Builder Contract

\`\`\`json
${JSON.stringify({
  schema: "forgedock.builder-contract/v1",
  revision: 1,
  allowedPaths: [{ kind: "exact", path: "src/core/events.ts" }],
})}
\`\`\``);
  const extension = extendBuilderContract(initial, {
    allowedPaths: [{ kind: "directory", path: "test/core" }],
    reason: "A reviewer-authorized regression test is required.",
  });
  assert.equal(extension.revision, 2);
  assert.equal(extension.supersedes, initial.contractHash);
  assert.equal(extension.reason, "A reviewer-authorized regression test is required.");
  assert.notEqual(extension.contractHash, initial.contractHash);
  assert.throws(
    () =>
      createBuilderContractArtifact({
        allowedPaths: [{ kind: "directory", path: "../outside" }],
      }),
    (error) => error instanceof BuilderContractError && error.code === "invalid-path",
  );
});
