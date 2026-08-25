import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  isForgeRuntimePath,
  parseGitStatusPaths,
} from "../../src/agents/child-runtime.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

test("commit path staging excludes ignored Forge runtime content", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-commit-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.invalid");
    await writeFile(join(root, "source.ts"), "export const value = 1;\n");
    await git(root, "add", "source.ts");
    await git(root, "commit", "-m", "initial");
    await writeFile(join(root, ".git", "info", "exclude"), ".pi/\n");
    await mkdir(join(root, ".pi", "agents"), { recursive: true });
    await writeFile(join(root, ".pi", "agents", "forge-work-on.md"), "runtime\n");
    await writeFile(join(root, "source.ts"), "export const value = 2;\n");
    await writeFile(join(root, "new.ts"), "export const added = true;\n");

    const status = await git(
      root,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z",
    );
    const changedPaths = parseGitStatusPaths(status.stdout);
    assert.deepEqual(changedPaths.sort(), ["new.ts", "source.ts"]);
    assert.equal(changedPaths.some(isForgeRuntimePath), false);

    await git(root, "add", "-A", "--", ...changedPaths);
    const staged = await git(root, "diff", "--cached", "--name-only", "-z", "--");
    const stagedPaths = staged.stdout.split("\0").filter(Boolean).sort();
    assert.deepEqual(stagedPaths, ["new.ts", "source.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
