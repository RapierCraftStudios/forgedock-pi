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
  discoverPackageManifests,
  preflightRequiredVerificationCommands,
  resolveVerificationCommandDirectory,
  selectInitVerificationCommands,
  verificationScriptName,
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

test("init discovers the only package test script and binds its cwd", async () => {
  const testFixture = await fixture();
  try {
    const manifests = await discoverPackageManifests(testFixture.root);
    assert.deepEqual(
      manifests.map((manifest) => manifest.cwd),
      [".", "web"],
    );
    assert.equal(manifests.find((manifest) => manifest.cwd === ".")?.scripts.test, undefined);
    assert.equal(manifests.find((manifest) => manifest.cwd === "web")?.scripts.test, "vitest run");

    const selection = selectInitVerificationCommands({}, manifests);
    assert.equal(selection.mode, "local");
    assert.deepEqual(selection.commands.test, {
      argv: ["npm", "test"],
      cwd: "web",
      required: true,
      timeoutMs: 600_000,
    });
  } finally {
    await testFixture.cleanup();
  }
});

test("init falls back to explicit CI-only verification for ambiguous packages", async () => {
  const testFixture = await fixture();
  try {
    await writeFile(
      join(testFixture.root, "package.json"),
      JSON.stringify({ scripts: { test: "node test.js" } }),
    );
    const selection = selectInitVerificationCommands(
      {},
      await discoverPackageManifests(testFixture.root),
    );
    assert.equal(selection.mode, "ci-only");
    assert.deepEqual(selection.commands, {});
    assert.match(selection.reason, /Multiple packages/);
    assert.match(selection.reason, /web/);
  } finally {
    await testFixture.cleanup();
  }
});

test("init preserves valid commands and disables impossible required npm scripts", async () => {
  const testFixture = await fixture();
  try {
    const manifests = await discoverPackageManifests(testFixture.root);
    const valid = selectInitVerificationCommands(
      { test: command("web") },
      manifests,
    );
    assert.equal(valid.mode, "local");
    assert.equal(valid.commands.test?.cwd, "web");

    const invalid = selectInitVerificationCommands(
      { test: command(".") },
      manifests,
    );
    assert.equal(invalid.mode, "ci-only");
    assert.deepEqual(invalid.commands, {});
    assert.match(invalid.reason, /\.forge\/config\.json verification\.commands\.test\.argv/);
    assert.match(invalid.reason, /set cwd/);
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
      resolveVerificationCommandDirectory(testFixture.root, "web/.pi"),
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

test("npm-family script detection tolerates safe command-line flags", () => {
  assert.equal(verificationScriptName(["npm", "--silent", "test"]), "test");
  assert.equal(
    verificationScriptName(["npm", "--prefix", "web", "run", "test"]),
    "test",
  );
  assert.equal(
    verificationScriptName(["pnpm", "run", "--if-present", "check"]),
    "check",
  );
  assert.equal(verificationScriptName(["node", "test.js"]), undefined);
});
