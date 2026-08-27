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
  discoverVerificationCommandCandidates,
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

test("discovery returns manifest-backed package scripts with safe cwd values", async () => {
  const testFixture = await fixture();
  try {
    await symlink(testFixture.outside, join(testFixture.root, "linked"), "dir");
    const candidates = await discoverVerificationCommandCandidates(testFixture.root);
    assert.deepEqual(candidates, [
      {
        name: "web-test",
        packagePath: "web",
        packageManager: "npm",
        script: "test",
        argv: ["npm", "test"],
      },
    ]);
  } finally {
    await testFixture.cleanup();
  }
});

test("discovery keeps generated names valid for numeric package paths", async () => {
  const testFixture = await fixture();
  try {
    await mkdir(join(testFixture.root, "1"));
    await writeFile(
      join(testFixture.root, "1", "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    const candidates = await discoverVerificationCommandCandidates(testFixture.root);
    assert.equal(candidates[0]?.name, "verification-1-test");
  } finally {
    await testFixture.cleanup();
  }
});

test("discovery uses bun run for a manifest test script", async () => {
  const testFixture = await fixture();
  try {
    await writeFile(join(testFixture.root, "bun.lock"), "lockfileVersion: 1\n");
    const candidates = await discoverVerificationCommandCandidates(testFixture.root);
    assert.deepEqual(candidates[0], {
      name: "web-test",
      packagePath: "web",
      packageManager: "bun",
      script: "test",
      argv: ["bun", "run", "test"],
    });
  } finally {
    await testFixture.cleanup();
  }
});

test("preflight validates package-manager script syntax, selectors, and built-in bun test", async () => {
  const testFixture = await fixture();
  try {
    await assert.rejects(
      preflightRequiredVerificationCommands(
        testFixture.root,
        { test: command("web", { argv: ["npm", "run"] }) },
        { path: testFixture.path },
      ),
      /must name a package script/,
    );
    await assert.rejects(
      preflightRequiredVerificationCommands(
        testFixture.root,
        { test: command("web", { argv: ["npm", "run", "test\0"] }) },
        { path: testFixture.path },
      ),
      /must not contain NUL bytes/,
    );
    await preflightRequiredVerificationCommands(
      testFixture.root,
      { test: command(".", { argv: ["npm", "--prefix", "web", "test"] }) },
      { path: testFixture.path },
    );
    await preflightRequiredVerificationCommands(
      testFixture.root,
      { test: command(".", { argv: ["npm", "--workspace", "web", "test"] }) },
      { path: testFixture.path },
    );
    await preflightRequiredVerificationCommands(
      testFixture.root,
      { test: command(".", { argv: ["npm", "test", "--workspace=web"] }) },
      { path: testFixture.path },
    );
    await writeFile(join(testFixture.path, "pnpm"), "#!/bin/sh\nexit 0\n");
    await chmod(join(testFixture.path, "pnpm"), 0o755);
    await preflightRequiredVerificationCommands(
      testFixture.root,
      { test: command(".", { argv: ["pnpm", "--filter", "web", "test"] }) },
      { path: testFixture.path },
    );
    await preflightRequiredVerificationCommands(
      testFixture.root,
      { test: command(".", { argv: ["pnpm", "-r", "run", "test"] }) },
      { path: testFixture.path },
    );
    await writeFile(join(testFixture.path, "yarn"), "#!/bin/sh\nexit 0\n");
    await chmod(join(testFixture.path, "yarn"), 0o755);
    await preflightRequiredVerificationCommands(
      testFixture.root,
      {
        test: command(".", {
          argv: ["yarn", "workspace", "web", "run", "test"],
        }),
      },
      { path: testFixture.path },
    );
    await writeFile(join(testFixture.path, "bun"), "#!/bin/sh\nexit 0\n");
    await chmod(join(testFixture.path, "bun"), 0o755);
    await preflightRequiredVerificationCommands(
      testFixture.root,
      { test: command(".", { argv: ["bun", "test"] }) },
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

test("verification cwd rejects missing, control, aliases, and symlink-escape directories", async () => {
  const testFixture = await fixture();
  try {
    await mkdir(join(testFixture.root, ".forge"));
    await symlink(join(testFixture.root, ".forge"), join(testFixture.root, "forge-alias"), "dir");
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
      resolveVerificationCommandDirectory(testFixture.root, ".forge"),
      /runtime control directories/,
    );
    await assert.rejects(
      resolveVerificationCommandDirectory(testFixture.root, "forge-alias"),
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
