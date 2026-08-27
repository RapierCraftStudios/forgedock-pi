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

test("package-manager location flags cannot override the validated cwd", async () => {
  const testFixture = await fixture();
  try {
    for (const argv of [
      ["npm", "--prefix", "/tmp/outside", "test"],
      ["npm", "--prefix=/tmp/outside", "test"],
      ["pnpm", "--dir", "/tmp/outside", "test"],
      ["yarn", "--cwd=/tmp/outside", "test"],
      ["bun", "-C", "/tmp/outside", "test"],
      ["npm", "test", "--", "--cwd", "/tmp/outside"],
    ]) {
      const shouldPassThroughScriptArgs = argv[2] === "--";
      if (shouldPassThroughScriptArgs) {
        await preflightRequiredVerificationCommands(
          testFixture.root,
          { test: command("web", { argv }) },
          { path: testFixture.path },
        );
        continue;
      }
      await assert.rejects(
        preflightRequiredVerificationCommands(
          testFixture.root,
          { test: command("web", { argv }) },
          {
            path: testFixture.path,
            configPath: "/repo/.forge/config.json",
          },
        ),
        (error: unknown) =>
          error instanceof VerificationPreflightError &&
          error.path ===
            "/repo/.forge/config.json verification.commands.test.argv" &&
          /location flag/.test(error.message) &&
          /validated cwd/.test(error.message),
      );
    }

    await assert.rejects(
      preflightRequiredVerificationCommands(
        testFixture.root,
        {
          optional: command("web", {
            argv: ["npm", "--prefix", "/tmp/outside", "test"],
            required: false,
          }),
        },
        { path: testFixture.path },
      ),
      /location flag/,
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
      resolveVerificationCommandDirectory(
        testFixture.root,
        "missing",
        "/repo/.forge/config.json verification.commands.test.cwd",
      ),
      (error: unknown) =>
        error instanceof VerificationPreflightError &&
        error.path ===
          "/repo/.forge/config.json verification.commands.test.cwd" &&
        /does not exist/.test(error.message) &&
        /use CI-only verification/.test(error.message),
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
