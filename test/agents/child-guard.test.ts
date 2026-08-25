import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPathWithin,
  isPathWithin,
  toolPath,
} from "../../src/agents/child-guard.ts";

test("child guard accepts the worktree and descendants but rejects traversal", () => {
  assert.equal(isPathWithin("/worktree", "/worktree"), true);
  assert.equal(isPathWithin("/worktree", "/worktree/src/index.ts"), true);
  assert.equal(isPathWithin("/worktree", "/worktree/../outside"), false);
  assert.throws(
    () => assertPathWithin("/worktree", "/outside", "Tool path"),
    /Tool path is outside/,
  );
});

test("child guard extracts only non-empty object paths", () => {
  assert.equal(toolPath({ path: "src/index.ts" }), "src/index.ts");
  assert.equal(toolPath({ path: "" }), undefined);
  assert.equal(toolPath({ path: 42 }), undefined);
  assert.equal(toolPath(undefined), undefined);
});
