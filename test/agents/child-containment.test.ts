import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  guardChildToolPath,
  resolveChildRoot,
} from "../../src/agents/child-containment.ts";

test("child containment allows worktree paths and protects runtime paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-containment-"));
  try {
    const canonical = await resolveChildRoot(root, root);
    assert.equal(await guardChildToolPath(canonical, root, "read", { path: "src/app.ts" }), undefined);
    assert.equal(
      (await guardChildToolPath(canonical, root, "write", { path: ".pi/forge/result.json" }))?.block,
      true,
    );
    assert.equal(
      (await guardChildToolPath(canonical, root, "read", { path: ".git/config" }))?.block,
      true,
    );
    assert.equal(
      (await guardChildToolPath(canonical, root, "read", { path: "../outside.txt" }))?.block,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child containment resolves symlink escapes before allowing a tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-containment-root-"));
  const outside = await mkdtemp(join(tmpdir(), "forgedock-containment-outside-"));
  try {
    await symlink(outside, join(root, "linked-outside"));
    const canonical = await resolveChildRoot(root, root);
    const decision = await guardChildToolPath(
      canonical,
      root,
      "read",
      { path: "linked-outside/secret.txt" },
    );
    assert.equal(decision?.block, true);
    assert.match(decision?.reason ?? "", /outside the assigned Forge worktree/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
