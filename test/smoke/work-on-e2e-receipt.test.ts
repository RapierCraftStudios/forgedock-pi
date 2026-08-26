import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reads the deterministic work-on E2E receipt fixture", async () => {
  const receipt = await readFile(
    new URL("../fixtures/work-on-e2e-receipt.txt", import.meta.url),
    "utf8",
  );

  assert.equal(receipt, "forgedock-work-on-e2e-v1\n");
});
