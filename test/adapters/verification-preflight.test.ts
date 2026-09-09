import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  preflightRequiredVerificationCommands,
  resolveVerificationCommandDirectory,
  VerificationPreflightError,
} from "../../src/adapters/verification-preflight.ts";
import type { VerificationCommandPolicy } from "../../src/core/policy.ts";

const execFileAsync = promisify(execFile);

async function fixture(
  rootManifest: unknown = { dependencies: {} },
): Promise<{
  root: string;
  outside: string;
  path: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "forgedock-preflight-"));
  const outside = await mkdtemp(join(tmpdir(), "forgedock-preflight-outside-"));
  const bin = join(root, "bin");
  await execFileAsync("git", ["init", "--quiet", root]);
  await execFileAsync("git", ["-C", root, "config", "core.ignorecase", "true"]);
  await mkdir(join(root, "web"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(root, "package.json"), JSON.stringify(rootManifest));
  await writeFile(
    join(root, "web", "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
  );
  for (const manager of ["npm", "pnpm"]) {
    await writeFile(join(bin, manager), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, manager), 0o755);
  }
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

test("malformed root test metadata cannot be bypassed by package selectors", async () => {
  const testFixture = await fixture({
    dependencies: {},
    scripts: { test: { command: "not-a-script" } },
  });
  try {
    for (const argv of [
      ["npm", "--prefix", "web", "test"],
      ["npm", "--workspace", "web", "test"],
      ["npm", "--workspace=web", "test"],
      ["pnpm", "--filter-prod", "web", "test"],
      ["npm", "--registry", "https://registry.npmjs.org", "test"],
      ["npm", "--", "test"],
      ["npm", "run", "--workspace", "web", "test"],
      ["npm", "run", "--prefix", "../outside", "check"],
      ["npm", "run", "--prefix", "web"],
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
          /package-manager (?:options are not supported|'run' must name a script directly)/.test(
            error.message,
          ),
        `expected malformed root metadata to reject ${argv.join(" ")}`,
      );
    }
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

test("required proof capability binding is exact and fail closed", async () => {
  const specification = await readFile("specs/verification.md", "utf8");
  assert.match(specification, /criterionTextHash/);
  assert.match(specification, /contractDigest/);
  assert.match(specification, /FORGE:VERIFICATION_BLOCKED/);
  assert.match(specification, /MISSING.*SKIPPED.*UNKNOWN.*CONTRADICTED/s);
  assert.match(specification, /Structural\/source-string checks.*never satisfy/is);

  const bound = {
    capability: "runtime:e2e",
    criterion: "required-proof-capability-binding",
    criterionTextHash: "sha256:" + "a".repeat(64),
    sourceHead: "b".repeat(40),
    contractDigest: "sha256:" + "c".repeat(64),
    proofType: "runtime",
    boundary: "hosted e2e boundary",
  };
  const record = (state: "PASS" | "MISSING" | "SKIPPED" | "UNKNOWN" | "CONTRADICTED", evidence: string, wakeCondition: string) => ({
    v: 1,
    ...bound,
    state,
    evidence,
    wakeCondition,
  });
  const admission = (candidate: ReturnType<typeof record>, expected = bound) =>
    candidate.state === "PASS" && candidate.proofType === "runtime" && candidate.evidence.length > 0 &&
    candidate.criterion === expected.criterion &&
    candidate.criterionTextHash === expected.criterionTextHash &&
    candidate.sourceHead === expected.sourceHead &&
    candidate.contractDigest === expected.contractDigest &&
    candidate.boundary === expected.boundary;
  assert.equal(admission(record("PASS", "e2e run at bound head", "")), true);
  for (const state of ["MISSING", "SKIPPED", "UNKNOWN", "CONTRADICTED"] as const)
    assert.equal(admission(record(state, "", "restore hosted e2e capability")), false, state);
  assert.equal(admission({ ...record("PASS", "source string matched", ""), proofType: "structural" }), false);
  assert.equal(admission({ ...record("PASS", "bound e2e result", ""), sourceHead: "d".repeat(40) }), false);
  assert.equal(admission({ ...record("PASS", "bound e2e result", ""), contractDigest: "sha256:" + "d".repeat(64) }), false);
  assert.equal(admission({ ...record("PASS", "bound e2e result", ""), criterionTextHash: "sha256:" + "d".repeat(64) }), false);
  const blocked = record("MISSING", "", "restore hosted e2e capability");
  assert.deepEqual(
    Object.fromEntries(["capability", "criterion", "criterionTextHash", "sourceHead", "contractDigest", "state", "wakeCondition"].map((key) => [key, blocked[key as keyof typeof blocked]])),
    {
      capability: "runtime:e2e",
      criterion: "required-proof-capability-binding",
      criterionTextHash: "sha256:" + "a".repeat(64),
      sourceHead: "b".repeat(40),
      contractDigest: "sha256:" + "c".repeat(64),
      state: "MISSING",
      wakeCondition: "restore hosted e2e capability",
    },
  );
});

test("verification cwd rejects case variants and canonical reserved-directory targets", async () => {
  const testFixture = await fixture();
  try {
    await mkdir(join(testFixture.root, ".PI"));
    await symlink(join(testFixture.root, ".PI"), join(testFixture.root, "pi-alias"), "dir");
    await symlink(join(testFixture.root, ".git"), join(testFixture.root, "git-alias"), "dir");

    for (const configuredCwd of [".PI", ".GIT", "pi-alias", "git-alias"]) {
      await assert.rejects(
        resolveVerificationCommandDirectory(testFixture.root, configuredCwd),
        /runtime control directories/,
        configuredCwd,
      );
    }
  } finally {
    await testFixture.cleanup();
  }
});
