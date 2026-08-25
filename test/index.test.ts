import assert from "node:assert/strict";
import test from "node:test";

import { assertForgeReloadAllowed } from "../src/index.ts";

test("active orchestration blocks reload before runtime invalidation", () => {
  assert.throws(
    () => assertForgeReloadAllowed("reload", ["running"]),
    /blocks \/reload while an orchestration is running/,
  );
  assert.doesNotThrow(() =>
    assertForgeReloadAllowed("reload", ["completed", "cancelled"]),
  );
  assert.doesNotThrow(() =>
    assertForgeReloadAllowed("quit", ["running"]),
  );
});
