import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertNoPackageLocationOptions,
  preflightRequiredVerificationCommands,
  resolveVerificationCommandDirectory,
  VerificationPreflightError,
} from "../../src/adapters/verification-preflight.ts";
import type { VerificationCommandPolicy } from "../../src/core/policy.ts";

async function fixture(): Promise<{
  root: string;
  outside: string;
  path: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "forgedock-preflight-"));
  const outside = await mkdtemp(join(tmpdir(), "forgedock-preflight-outside-"));
  const bin = join(root, "bin");
  await mkdir(join(root, "web"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
  await writeFile(
    join(root, "web", "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
  );
  await writeFile(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "npm"), 0o755);
  return {
    root,
    outside,
    path: bin,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
}

function command(
  cwd: string,
  overrides: Partial<VerificationCommandPolicy> = {},
): VerificationCommandPolicy {
  return {
    argv: ["npm", "test"],
    cwd,
    required: true,
    timeoutMs: 60_000,
    ...overrides,
  };
}

test("required monorepo verification preflight selects the package cwd", async () => {
  const testFixture = await fixture();
  try {
    await assert.rejects(
      preflightRequiredVerificationCommands(
        testFixture.root,
        { test: command(".") },
        { path: testFixture.path, configPath: "/repo/.forge/config.json" },
      ),
      (error: unknown) =>
        error instanceof VerificationPreflightError &&
        error.path === "/repo/.forge/config.json verification.commands.test.argv" &&
        /no 'test' script/.test(error.message),
    );

    await preflightRequiredVerificationCommands(
      testFixture.root,
      { test: command("web") },
      { path: testFixture.path },
    );
  } finally {
    await testFixture.cleanup();
  }
});

test("package-manager location options cannot override the bound package", async () => {
  const testFixture = await fixture();
  try {
    const locationCommands: readonly (readonly string[])[] = [
      ["npm", "--prefix", ".", "test"],
      ["npm", "--prefix=.", "test"],
      ["npm", "--workspace", "other", "test"],
      ["npm", "--workspace=other", "test"],
      ["npm", "--workspaces", "test"],
      ["npm", "--workspace-root", "test"],
      ["npm", "--global", "test"],
      ["npm", "--location=global", "test"],
      ["npm", "test", "--prefix", "."],
      ["npm", "test", "--prefix=."],
      ["npm", "test", "--workspace=other"],
      ["pnpm", "--dir", ".", "test"],
      ["pnpm", "-C", ".", "test"],
      ["yarn", "--cwd", ".", "test"],
      ["bun", "--cwd=.", "test"],
    ];
    for (const argv of locationCommands) {
      assert.throws(
        () => assertNoPackageLocationOptions(argv, "verification.argv"),
        (error: unknown) =>
          error instanceof VerificationPreflightError &&
          error.path === "verification.argv" &&
          /package-location option/.test(error.message),
        `expected ${argv.join(" ")} to be rejected`,
      );
      await assert.rejects(
        preflightRequiredVerificationCommands(
          testFixture.root,
          { test: command("web", { argv }) },
          { path: testFixture.path },
        ),
        (error: unknown) =>
          error instanceof VerificationPreflightError &&
          /package-location option/.test(error.message),
      );
    }

    await preflightRequiredVerificationCommands(
      testFixture.root,
      {
        test: command("web", {
          argv: ["npm", "test", "--", "--prefix=/outside"],
        }),
      },
      { path: testFixture.path },
    );
  } finally {
    await testFixture.cleanup();
  }
});

test("preflight checks executable availability without running the command", async () => {
  const testFixture = await fixture();
  try {
    await assert.rejects(
      preflightRequiredVerificationCommands(
        testFixture.root,
        { test: command("web", { argv: ["missing-tool", "test"] }) },
        { path: testFixture.path },
      ),
      /executable 'missing-tool' is unavailable/,
    );
    await preflightRequiredVerificationCommands(
      testFixture.root,
      {
        optional: command("missing", {
          argv: ["missing-tool"],
          required: false,
        }),
      },
      { path: "" },
    );
  } finally {
    await testFixture.cleanup();
  }
});

test("verification cwd rejects missing, control, and symlink-escape directories", async () => {
  const testFixture = await fixture();
  try {
    await symlink(testFixture.outside, join(testFixture.root, "escaped"), "dir");
    await assert.rejects(
      resolveVerificationCommandDirectory(testFixture.root, "missing"),
      /does not exist/,
    );
    await assert.rejects(
      resolveVerificationCommandDirectory(testFixture.root, ".pi"),
      /runtime control directories/,
    );
    await assert.rejects(
      resolveVerificationCommandDirectory(testFixture.root, "escaped"),
      /outside the repository/,
    );
  } finally {
    await testFixture.cleanup();
  }
});
