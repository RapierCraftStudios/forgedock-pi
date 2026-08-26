import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { discoverVerificationCommands } from "../../src/ui/commands.ts";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/verification-monorepo",
);

test("init discovers a package-scoped npm test instead of an impossible root test", async () => {
  const commands = await discoverVerificationCommands(fixtureRoot);
  assert.deepEqual(commands.test, {
    argv: ["npm", "test"],
    required: true,
    timeoutMs: 600_000,
    cwd: "web",
  });
});

test("init can emit CI-only verification when no package exposes test", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-init-no-test-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "ci-only", private: true }),
    );
    assert.deepEqual(await discoverVerificationCommands(root), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
