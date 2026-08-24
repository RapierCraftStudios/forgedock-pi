import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApprovedVerificationRunner } from "../../src/agents/verification-runner.ts";

test("approved verification runner executes only a bound command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "forgedock-verification-"));
  try {
    const runner = new ApprovedVerificationRunner(
      {
        smoke: {
          argv: [process.execPath, "-e", "process.stdout.write('ok')"],
          required: true,
          timeoutMs: 10_000,
        },
      },
      "run-verification-test",
    );
    const result = await runner.run("smoke", cwd);
    assert.equal(result.status, "passed");
    assert.equal(result.required, true);
    assert.equal(result.stdout, "ok");
    await assert.rejects(
      runner.run("unbound", cwd),
      /is not approved for this run/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approved verification runner reports non-zero commands as failed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "forgedock-verification-fail-"));
  try {
    const runner = new ApprovedVerificationRunner(
      {
        failing: {
          argv: [process.execPath, "-e", "process.stderr.write('nope'); process.exit(3)"],
          required: false,
          timeoutMs: 10_000,
        },
      },
      "run-verification-failure-test",
    );
    const result = await runner.run("failing", cwd);
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 3);
    assert.equal(result.stderr, "nope");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
