import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverPackageScriptCandidates,
  preflightVerificationCommands,
  VerificationPreflightError,
} from "../../src/adapters/verification-preflight.ts";

const fixtureRoot = fileURLToPath(
  new URL("../fixtures/monorepo-no-root-test/", import.meta.url),
);
const configPath = join(fixtureRoot, ".forge", "config.json");
const npmTest = {
  argv: ["npm", "test"],
  workingDirectory: "web",
  required: true,
  timeoutMs: 600_000,
} as const;

const environment = { ...process.env };

test("preflight accepts npm test in the package that defines the script", async () => {
  const report = await preflightVerificationCommands(
    fixtureRoot,
    { test: npmTest },
    { configPath, env: environment },
  );
  assert.deepEqual(report.checks, [
    {
      name: "test",
      required: true,
      workingDirectory: "web",
      status: "passed",
      details:
        "Executable, working directory, and required package metadata are available.",
    },
  ]);
});

test("preflight rejects root npm test when the monorepo root has no script", async () => {
  await assert.rejects(
    () =>
      preflightVerificationCommands(
        fixtureRoot,
        {
          test: {
            ...npmTest,
            workingDirectory: ".",
          },
        },
        { configPath, env: environment },
      ),
    (error: unknown) => {
      assert.ok(error instanceof VerificationPreflightError);
      assert.match(
        error.message,
        new RegExp(
          `${escapeRegExp(configPath)}\\.verification\\.commands\\.test\\.argv`,
        ),
      );
      assert.match(error.message, /does not define scripts\.test/);
      assert.match(error.message, /\/forge:init/);
      return true;
    },
  );
});

test("preflight catches missing directories and executables before execution", async () => {
  await assert.rejects(
    () =>
      preflightVerificationCommands(
        fixtureRoot,
        {
          missingDirectory: {
            ...npmTest,
            workingDirectory: "missing",
          },
          missingExecutable: {
            argv: ["forge-command-that-does-not-exist"],
            workingDirectory: "web",
            required: true,
            timeoutMs: 600_000,
          },
        },
        { configPath, env: environment },
      ),
    (error: unknown) => {
      assert.ok(error instanceof VerificationPreflightError);
      assert.equal(error.failures.length, 2);
      assert.match(error.message, /directory does not exist/);
      assert.match(error.message, /was not found or is not executable/);
      return true;
    },
  );
});

test("package discovery returns the unique nested package with a test script", async () => {
  const candidates = await discoverPackageScriptCandidates(fixtureRoot, "test");
  assert.deepEqual(candidates, [
    {
      workingDirectory: "web",
      packagePath: join(fixtureRoot, "web", "package.json"),
    },
  ]);
});

test("an empty command map is an explicit CI-only verification policy", async () => {
  const report = await preflightVerificationCommands(fixtureRoot, {}, {
    configPath,
    env: environment,
  });
  assert.deepEqual(report.checks, []);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
