import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  preflightVerificationCommands,
  resolveVerificationCommandDirectory,
} from "../../src/adapters/verification-preflight.ts";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/verification-monorepo",
);
const configPath = join(fixtureRoot, ".forge", "config.json");

function testCommand(cwd: string) {
  return {
    argv: ["npm", "test"],
    required: true,
    timeoutMs: 600_000,
    cwd,
  } as const;
}

test("required monorepo verification preflight selects the package cwd", async () => {
  await assert.doesNotReject(() =>
    preflightVerificationCommands({
      repositoryRoot: fixtureRoot,
      configPath,
      commands: { test: testCommand("web") },
    }),
  );
});

test("missing npm scripts fail with config-path remediation", async () => {
  await assert.rejects(
    () =>
      preflightVerificationCommands({
        repositoryRoot: fixtureRoot,
        configPath,
        commands: { test: testCommand(".") },
      }),
    (error: unknown) => {
      assert.match(String(error), /verification\.commands\.test\.cwd/);
      assert.match(String(error), /has no 'test' script/);
      assert.match(
        String(error),
        /set cwd to the package that defines it or use CI-only verification/,
      );
      return true;
    },
  );
});

test("missing executables are rejected before a writer can launch", async () => {
  await assert.rejects(
    () =>
      preflightVerificationCommands({
        repositoryRoot: fixtureRoot,
        configPath,
        commands: {
          test: {
            ...testCommand("web"),
            argv: ["forge-command-that-does-not-exist"],
          },
        },
        path: "/does-not-exist",
      }),
    (error: unknown) => {
      assert.match(String(error), /verification\.commands\.test\.argv/);
      assert.match(String(error), /run \/forge:init/);
      return true;
    },
  );
});

test("verification cwd rejects missing, control, and symlink-escape directories", async () => {
  await assert.rejects(() =>
    resolveVerificationCommandDirectory(
      fixtureRoot,
      "missing",
      `${configPath}:verification.commands.test.cwd`,
    ),
  );
  await assert.rejects(() =>
    resolveVerificationCommandDirectory(
      fixtureRoot,
      "../outside",
      `${configPath}:verification.commands.test.cwd`,
    ),
  );

  const root = await mkdtemp(join(tmpdir(), "forge-preflight-root-"));
  const outside = await mkdtemp(join(tmpdir(), "forge-preflight-outside-"));
  try {
    await mkdir(join(root, "link"), { recursive: true });
    await rm(join(root, "link"), { recursive: true, force: true });
    await symlink(outside, join(root, "link"), "dir");
    await assert.rejects(() =>
      resolveVerificationCommandDirectory(
        root,
        "link",
        "verification.commands.test.cwd",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
