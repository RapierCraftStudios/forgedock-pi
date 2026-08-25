import assert from "node:assert/strict";
import test from "node:test";

import {
  ApprovedVerificationRunner,
  safeEnvironment,
  truncateTail,
  validateBoundCommand,
} from "../../src/adapters/verification.ts";

test("approved verification runner preserves typed success and output", async () => {
  const runner = new ApprovedVerificationRunner(process.cwd(), "run-test");
  const result = await runner.run("unit", {
    argv: [process.execPath, "-e", "process.stdout.write('ok')"],
    required: true,
    timeoutMs: 10_000,
  });
  assert.equal(result.details.status, "passed");
  assert.equal(result.details.exitCode, 0);
  assert.match(result.content[0].text, /ok/);
});

test("verification boundaries validate argv and bound output", () => {
  assert.throws(
    () => validateBoundCommand("empty", { argv: [], required: true, timeoutMs: 1_000 }),
    /non-empty string array/,
  );
  assert.equal(truncateTail("abc", 3), "abc");
  assert.match(truncateTail("abcdef", 3), /output truncated/);
  assert.equal(safeEnvironment("run-test").GIT_CONFIG_NOSYSTEM, "1");
});
