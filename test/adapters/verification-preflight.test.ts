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
  discoverPackageScripts,
  preflightRequiredVerificationCommands,
  resolveVerificationCommandDirectory,
  selectInitVerificationCommands,
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

test("/forge:init discovers and binds a unique monorepo package script without execution", async () => {
  const testFixture = await fixture();
  try {
    const manifests = await discoverPackageScripts(testFixture.root);
    assert.deepEqual(manifests, [
      { cwd: "web", scripts: { test: "vitest run" } },
    ]);
    const selection = await selectInitVerificationCommands(
      testFixture.root,
      {},
      {
        path: testFixture.path,
        configPath: "/repo/.forge/config.json",
      },
    );
    assert.equal(selection.mode, "discovered");
    assert.deepEqual(selection.commands, {
      test: {
        argv: ["npm", "test"],
        cwd: "web",
        required: true,
        timeoutMs: 600_000,
      },
    });
  } finally {
    await testFixture.cleanup();
  }
});

test("/forge:init preserves valid commands and repairs one unambiguous package cwd", async () => {
  const testFixture = await fixture();
  try {
    const valid = command("web", { timeoutMs: 120_000 });
    const preserved = await selectInitVerificationCommands(
      testFixture.root,
      { test: valid },
      { path: testFixture.path, configPath: "/repo/.forge/config.json" },
    );
    assert.equal(preserved.mode, "configured");
    assert.deepEqual(preserved.commands, { test: valid });

    const repaired = await selectInitVerificationCommands(
      testFixture.root,
      { test: command(".") },
      { path: testFixture.path, configPath: "/repo/.forge/config.json" },
    );
    assert.equal(repaired.mode, "discovered");
    assert.equal(repaired.commands.test?.cwd, "web");
  } finally {
    await testFixture.cleanup();
  }
});

test("ambiguous package scripts fall back to explicit CI-only selection", async () => {
  const testFixture = await fixture();
  try {
    await mkdir(join(testFixture.root, "api"));
    await writeFile(
      join(testFixture.root, "api", "package.json"),
      JSON.stringify({ scripts: { test: "node test.js" } }),
    );
    const selection = await selectInitVerificationCommands(
      testFixture.root,
      {},
      { path: testFixture.path, configPath: "/repo/.forge/config.json" },
    );
    assert.equal(selection.mode, "ci-only");
    assert.deepEqual(selection.commands, {});
    assert.match(selection.reason ?? "", /No unambiguous package/);
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
      preflightRequiredVerificationCommands(
        testFixture.root,
        { test: command("missing") },
        { path: testFixture.path, configPath: "/repo/.forge/config.json" },
      ),
      (error: unknown) =>
        error instanceof VerificationPreflightError &&
        error.path === "/repo/.forge/config.json verification.commands.test.cwd" &&
        /\/forge:init/.test(error.message) &&
        /commands: \{\}/.test(error.message),
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
