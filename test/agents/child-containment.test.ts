import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalizePotentialPath,
  isPathWithin,
  toolPath,
} from "../../src/agents/child-containment.ts";

test("child containment canonicalizes symlink prefixes before authorizing new paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-containment-"));
  const worktree = join(root, "worktree");
  const outside = join(root, "outside");
  try {
    await mkdir(worktree);
    await mkdir(outside);
    await symlink(outside, join(worktree, "linked"));
    const target = await canonicalizePotentialPath(
      worktree,
      "linked/new/file.ts",
    );
    assert.equal(isPathWithin(worktree, target), false);
    assert.equal(isPathWithin(outside, target), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child containment extracts only non-empty path tool arguments", () => {
  assert.equal(toolPath({ path: "src/index.ts" }), "src/index.ts");
  assert.equal(toolPath({ path: "" }), undefined);
  assert.equal(toolPath({}), undefined);
  assert.equal(toolPath(null), undefined);
});
