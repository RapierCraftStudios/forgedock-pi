import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  findPackageWithScript,
  preflightRequiredVerificationCommands,
  resolveVerificationCommandDirectory,
  VerificationPreflightError,
} from "../../src/adapters/verification-preflight.ts";
import type { VerificationCommandPolicy } from "../../src/core/policy.ts";

const monorepo = fileURLToPath(
  new URL("../fixtures/monorepo/", import.meta.url),
);

function command(
  overrides: Partial<VerificationCommandPolicy> = {},
): VerificationCommandPolicy {
  return {
    argv: ["npm", "test"],
    cwd: ".",
    required: true,
    timeoutMs: 600_000,
    ...overrides,
  };
}

test("the bundled template leaves local verification explicitly CI-owned", async () => {
  const template = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL("../../templates/config.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { verification: { commands: unknown } };
  assert.deepEqual(template.verification.commands, {});
});

test("discovers the unique nested package with the requested script", async () => {
  assert.equal(await findPackageWithScript(monorepo, "test"), "web");
});

test("preflight rejects a root npm script that does not exist", async () => {
  await assert.rejects(
    preflightRequiredVerificationCommands(
      monorepo,
      { test: command() },
      { configPath: "/repo/.forge/config.json" },
    ),
    (error: unknown) =>
      error instanceof VerificationPreflightError &&
      error.message.includes("/repo/.forge/config.json") &&
      error.message.includes("verification.commands.test") &&
      error.message.includes("does not define npm script 'test'") &&
      error.message.includes("/forge:init"),
  );
});

test("preflight accepts the nested package without executing its script", async () => {
  await preflightRequiredVerificationCommands(
    monorepo,
    { test: command({ cwd: "web" }) },
    { configPath: "/repo/.forge/config.json" },
  );
});

test("preflight checks every required command and ignores optional commands", async () => {
  await assert.rejects(
    preflightRequiredVerificationCommands(
      monorepo,
      {
        optional: command({
          argv: ["definitely-not-a-forgedock-executable", "test"],
          required: false,
        }),
        required: command({
          argv: ["definitely-not-a-forgedock-executable", "test"],
          cwd: "missing",
        }),
      },
      { configPath: "/repo/.forge/config.json" },
    ),
    (error: unknown) =>
      error instanceof VerificationPreflightError &&
      error.failures.some((failure) => failure.includes("verification.commands.required")) &&
      !error.failures.some((failure) => failure.includes("optional")),
  );
});

test("ambiguous nested packages fall back instead of guessing", async () => {
  const root = await mkdtemp(join(dirname(monorepo), "forgedock-packages-"));
  try {
    await mkdir(join(root, "one"));
    await mkdir(join(root, "two"));
    const packageJson = JSON.stringify({ scripts: { test: "node --test" } });
    await writeFile(join(root, "one", "package.json"), packageJson);
    await writeFile(join(root, "two", "package.json"), packageJson);
    assert.equal(await findPackageWithScript(root, "test"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification directories cannot escape through traversal or symlinks", async () => {
  const root = await mkdtemp(join(dirname(monorepo), "forgedock-cwd-"));
  const outside = await mkdtemp(join(dirname(monorepo), "forgedock-outside-"));
  try {
    await assert.rejects(resolveVerificationCommandDirectory(root, "../outside"));
    await symlink(outside, join(root, "linked"));
    await assert.rejects(
      resolveVerificationCommandDirectory(root, "linked"),
      /outside the repository/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
