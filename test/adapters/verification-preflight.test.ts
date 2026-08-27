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

test("preflight rejects package location selectors before package validation", async () => {
  const testFixture = await fixture();
  try {
    for (const argv of [
      ["npm", "--prefix", "web", "test"],
      ["npm", "--prefix=web", "test"],
      ["npm", "-C", "web", "test"],
      ["npm", "-Cweb", "test"],
      ["npm", "test", "--prefix", "web"],
      ["npm", "run", "test", "--workspace", "web"],
      ["npm", "--location=global", "test"],
      ["npm", "exec", "--", "npm", "--prefix", "web", "test"],
      ["pnpm", "-F", "web", "test"],
      ["pnpm", "-r", "run", "test"],
      ["pnpm", "--recursive", "run", "test"],
      ["yarn", "workspace", "web", "test"],
      ["yarn", "workspaces", "foreach", "run", "test"],
      ["yarnpkg", "--cwd", "web", "test"],
      ["corepack", "pnpm", "--dir", "web", "test"],
    ]) {
      await assert.rejects(
        preflightRequiredVerificationCommands(
          testFixture.root,
          { test: command(".", { argv }) },
          { path: testFixture.path },
        ),
        (error: unknown) =>
          error instanceof VerificationPreflightError &&
          error.path === ".forge/config.json verification.commands.test.argv" &&
          /package-location option/.test(error.message),
      );
    }

    assert.doesNotThrow(() =>
      assertNoPackageLocationOptions(["npm", "test", "--", "--prefix", "web"]),
    );
    await preflightRequiredVerificationCommands(
      testFixture.root,
      {
        test: command("web", {
          argv: ["npm", "test", "--", "--prefix", "not-a-package"],
        }),
      },
      { path: testFixture.path },
    );

    await writeFile(
      join(testFixture.root, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
    );
    await preflightRequiredVerificationCommands(
      testFixture.root,
      {
        typecheck: command(".", {
          argv: ["npm", "--cache", "test", "run", "typecheck"],
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
