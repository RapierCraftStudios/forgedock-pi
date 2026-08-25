import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  GitWorktreeManager,
  type CommandExecutor,
} from "../../src/adapters/git.ts";

const execFileAsync = promisify(execFile);

const executor: CommandExecutor = {
  async exec(command, args, options) {
    try {
      const result = await execFileAsync(command, [...args], {
        cwd: options?.cwd,
        timeout: options?.timeout,
        env: options?.env,
        signal: options?.signal,
        encoding: "utf8",
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failure = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
        killed?: boolean;
      };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        code: failure.code ?? 1,
        killed: failure.killed,
      };
    }
  },
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

test("worktree manager creates an issue branch from integration and cleans it safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-git-test-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  try {
    await execFileAsync("git", ["init", "--bare", origin]);
    await execFileAsync("git", ["init", "-b", "main", seed]);
    await git(seed, "config", "user.name", "Test");
    await git(seed, "config", "user.email", "test@example.invalid");
    await writeFile(join(seed, "app.txt"), "base\n");
    await git(seed, "add", "app.txt");
    await git(seed, "commit", "-m", "initial");
    await git(seed, "branch", "staging");
    await git(seed, "remote", "add", "origin", origin);
    await git(seed, "push", "origin", "main", "staging");
    await execFileAsync("git", ["clone", origin, clone]);

    const manager = new GitWorktreeManager(executor);
    await manager.ensureRuntimeIgnored(clone);
    assert.match(
      await readFile(join(clone, ".git", "info", "exclude"), "utf8"),
      /^\.pi\/$/m,
    );
    const prepared = await manager.prepare(clone, {
      runId: "run-1234",
      issueNumber: 7,
      baseBranch: "staging",
    });
    assert.equal(prepared.branch, "forge/issue-7-run-1234");
    assert.equal(
      await readFile(join(prepared.worktreePath, "app.txt"), "utf8"),
      "base\n",
    );
    await mkdir(join(prepared.worktreePath, ".pi", "agents"), {
      recursive: true,
    });
    await writeFile(
      join(prepared.worktreePath, ".pi", "agents", "runtime.md"),
      "generated runtime\n",
    );
    await manager.assertClean(prepared.worktreePath);
    await manager.push(prepared.worktreePath, prepared.branch);
    await manager.deleteRemoteBranch(prepared);
    const remoteBranch = await execFileAsync(
      "git",
      ["ls-remote", origin, `refs/heads/${prepared.branch}`],
      { encoding: "utf8" },
    );
    assert.equal(remoteBranch.stdout.trim(), "");
    await manager.cleanup(prepared);
    // Retry after the first cleanup has already removed both owned resources.
    await manager.cleanup(prepared);
    await assert.rejects(
      readFile(join(prepared.worktreePath, "app.txt"), "utf8"),
    );
    const localBranch = await execFileAsync(
      "git",
      ["-C", clone, "branch", "--list", prepared.branch],
      { encoding: "utf8" },
    );
    assert.equal(localBranch.stdout.trim(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
