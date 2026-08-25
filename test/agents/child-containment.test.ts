import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkToolPath,
  isPathWithin,
  resolveBoundWorktreeRoot,
  writeBoundResult,
} from "../../src/agents/child-containment.ts";

test("child containment accepts worktree paths and denies control directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-containment-"));
  try {
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".pi"));
    const canonical = await resolveBoundWorktreeRoot(root, root);

    assert.equal(await checkToolPath(canonical, root, { path: "src/file.ts" }, "read"), undefined);
    assert.match(
      (await checkToolPath(canonical, root, { path: ".git/config" }, "read")) ?? "",
      /Forge runtime or Git control files/,
    );
    assert.match(
      (await checkToolPath(canonical, root, { path: ".pi/forge/result.json" }, "write")) ?? "",
      /Forge runtime or Git control files/,
    );
    assert.match(
      (await checkToolPath(canonical, root, { path: "../outside.txt" }, "edit")) ?? "",
      /outside the assigned Forge worktree/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bound result writes reject symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-result-root-"));
  const outside = await mkdtemp(join(tmpdir(), "forgedock-result-outside-"));
  try {
    const resultPath = join(root, ".pi", "forge", "result.json");
    await writeBoundResult(root, resultPath, "safe");
    assert.equal(await readFile(resultPath, "utf8"), "safe");
    const escaped = join(root, ".pi", "forge", "escaped.json");
    await symlink(join(outside, "target.json"), escaped);
    await assert.rejects(
      writeBoundResult(root, escaped, "unsafe"),
      /must not be a symbolic link/,
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("child containment rejects a session cwd outside the bound root", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-containment-root-"));
  const outside = await mkdtemp(join(tmpdir(), "forgedock-containment-outside-"));
  try {
    await assert.rejects(
      resolveBoundWorktreeRoot(root, outside),
      /outside bound worktree/,
    );
    assert.equal(isPathWithin(root, join(root, "nested")), true);
    assert.equal(isPathWithin(root, outside), false);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
