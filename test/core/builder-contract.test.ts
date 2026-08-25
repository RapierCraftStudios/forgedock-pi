import assert from "node:assert/strict";
import test from "node:test";

import {
  assertChangedPathsAllowed,
  BuilderContractError,
  extendBuilderContract,
  findBuilderContractViolations,
  hashBuilderContract,
  matchesBuilderContractPath,
  normalizeBuilderContract,
  normalizeBuilderContractExtension,
  parseBuilderContractReport,
  parseGitNameStatus,
  type BuilderContract,
} from "../../src/core/builder-contract.ts";

const base: BuilderContract = {
  schema: "forgedock.builder-contract/v1",
  revision: 1,
  baseSha: "1234567890abcdef",
  allowedPaths: ["src/core/state.ts", "test/**"],
};

 test("exact and directory contract rules are normalized and matched", () => {
  const contract = normalizeBuilderContract(base);
  assert.deepEqual(contract.allowedPaths, ["src/core/state.ts", "test/**"]);
  assert.equal(matchesBuilderContractPath(contract, "src/core/state.ts"), true);
  assert.equal(matchesBuilderContractPath(contract, "test/core/state.test.ts"), true);
  assert.equal(matchesBuilderContractPath(contract, "src/core/events.ts"), false);
  assert.equal(matchesBuilderContractPath(contract, "testing/file.ts"), false);
});

test("out-of-contract paths fail closed, including runtime paths", () => {
  const paths = [
    { status: "modified" as const, path: "src/core/events.ts" },
    { status: "added" as const, path: "src/core/state.ts" },
  ];
  assert.deepEqual(findBuilderContractViolations(base, paths), [
    "modified path src/core/events.ts",
  ]);
  assert.throws(
    () =>
      assertChangedPathsAllowed(base, [
        { status: "modified", path: ".pi/forge/result.json" },
      ]),
    (error) =>
      error instanceof BuilderContractError &&
      error.code === "invalid-path",
  );
});

test("renames require both source and destination paths and deletions require their path", () => {
  const contract = normalizeBuilderContract({
    ...base,
    allowedPaths: ["src/old.ts", "src/new.ts", "test/**"],
  });
  assert.doesNotThrow(() =>
    assertChangedPathsAllowed(contract, [
      {
        status: "renamed",
        previousPath: "src/old.ts",
        path: "src/new.ts",
      },
      { status: "deleted", path: "test/removed.test.ts" },
    ]),
  );
  assert.throws(
    () =>
      assertChangedPathsAllowed(contract, [
        {
          status: "renamed",
          previousPath: "src/outside.ts",
          path: "src/new.ts",
        },
      ]),
    /outside the accepted builder contract/,
  );
  assert.throws(
    () =>
      assertChangedPathsAllowed(contract, [
        { status: "deleted", path: "docs/removed.md" },
      ]),
    /outside the accepted builder contract/,
  );
});

test("contract hashes are deterministic and extensions require the prior revision/hash", () => {
  const firstHash = hashBuilderContract(base);
  const reordered = normalizeBuilderContract({
    ...base,
    allowedPaths: ["test/**", "src/core/state.ts"],
  });
  assert.equal(hashBuilderContract(reordered), firstHash);
  const extension = normalizeBuilderContractExtension({
    schema: "forgedock.builder-contract-extension/v1",
    baseContractHash: firstHash,
    revision: 2,
    addedPaths: ["src/core/events.ts"],
    reason: "Reviewer finding requires the event reducer update.",
    findingIds: ["CORRECTNESS-1"],
  });
  const next = extendBuilderContract(base, extension);
  assert.equal(next.revision, 2);
  assert.equal(next.baseSha, base.baseSha);
  assert.equal(next.allowedPaths.includes("src/core/events.ts"), true);
  assert.throws(
    () =>
      extendBuilderContract(base, {
        ...extension,
        baseContractHash: "sha256:wrong",
      }),
    /references sha256:wrong/,
  );
  assert.throws(
    () =>
      extendBuilderContract(base, {
        ...extension,
        revision: 3,
      }),
    /must follow 1/,
  );
});

test("name-status parsing preserves rename and deletion information", () => {
  assert.deepEqual(
    parseGitNameStatus(
      "M\0src/core/state.ts\0R100\0src/old.ts\0src/new.ts\0D\0docs/removed.md\0",
    ),
    [
      { status: "modified", path: "src/core/state.ts" },
      { status: "renamed", previousPath: "src/old.ts", path: "src/new.ts" },
      { status: "deleted", path: "docs/removed.md" },
    ],
  );
});

test("plan reports must contain the typed contract artifact", () => {
  const parsed = parseBuilderContractReport(
    `<!-- FORGE:CONTRACT -->\n\n\`\`\`json\n${JSON.stringify(base)}\n\`\`\`\n<!-- FORGE:CONTRACT:COMPLETE -->`,
  );
  assert.deepEqual(parsed, normalizeBuilderContract(base));
  assert.throws(
    () => parseBuilderContractReport("<!-- FORGE:CONTRACT -->\nNo JSON"),
    /JSON code block/,
  );
});
