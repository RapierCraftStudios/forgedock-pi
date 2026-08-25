import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ApprovedVerificationRunner,
  safeEnvironment,
  truncateTail,
} from "../../src/adapters/verification.ts";

test("verification runner executes only a bound command and reports status", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "forgedock-verification-"));
  try {
    const runner = new ApprovedVerificationRunner({
      smoke: {
        argv: [process.execPath, "-e", "process.stdout.write('ok')"],
        required: true,
        timeoutMs: 10_000,
      },
    });
    const result = await runner.execute("smoke", {
      cwd,
      runId: "run-verification",
    });
    assert.equal(result.status, "passed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok");
    await assert.rejects(
      runner.execute("not-bound", { cwd, runId: "run-verification" }),
      /not approved/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verification environment is scrubbed and output truncation is explicit", () => {
  const env = safeEnvironment("run-scrubbed");
  assert.equal(env.FORGEDOCK_RUN_ID, "run-scrubbed");
  assert.equal(
    env.GIT_CONFIG_GLOBAL,
    process.platform === "win32" ? "NUL" : "/dev/null",
  );
  assert.notEqual(env.HOME, process.env.HOME);
  const output = truncateTail("0123456789", 4);
  assert.match(output, /^\[output truncated to last 4 bytes\]/);
  assert.ok(Buffer.byteLength(output) > 4);
});
