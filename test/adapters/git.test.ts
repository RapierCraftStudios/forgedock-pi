import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  cleanupForgeRuntime,
  GitWorktreeManager,
  parseChangedGitPaths,
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

test("NUL-delimited changed paths retain rename sources, destinations, and deletions", () => {
  assert.deepEqual(
    parseChangedGitPaths("R100\0src/old.ts\0src/new.ts\0D\0src/gone.ts\0"),
    ["src/gone.ts", "src/new.ts", "src/old.ts"],
  );
  assert.throws(() => parseChangedGitPaths("R100\0src/old.ts\0"));
});

test("runtime cleanup removes every generated Forge agent definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-runtime-cleanup-"));
  try {
    await mkdir(join(root, ".pi", "agents"), { recursive: true });
    await mkdir(join(root, ".pi", "forge"), { recursive: true });
    await writeFile(join(root, ".pi", "settings.json"), "{}\n");
    await writeFile(
      join(root, ".pi", "forge", "generated-settings"),
      "settings.json\n",
    );
    for (const name of [
      "forge-read-only-node.md",
      "forge-work-on.md",
      "forge-refresh-review.md",
      "forge-review-correctness.md",
      "forge-review-security.md",
    ])
      await writeFile(join(root, ".pi", "agents", name), "generated\n");

    await cleanupForgeRuntime(root);

    await assert.rejects(readFile(join(root, ".pi", "settings.json"), "utf8"));
    await assert.rejects(readFile(join(root, ".pi", "agents", "forge-read-only-node.md"), "utf8"));
    await assert.rejects(readFile(join(root, ".pi", "forge", "generated-settings"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("local exclude update rejects a pre-existing metadata-parent symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-git-parent-link-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  const external = join(root, "external-info");
  try {
    await execFileAsync("git", ["init", "--bare", origin]);
    await execFileAsync("git", ["init", "-b", "main", seed]);
    await git(seed, "config", "user.name", "Test");
    await git(seed, "config", "user.email", "test@example.invalid");
    await writeFile(join(seed, "app.txt"), "base\n");
    await git(seed, "add", "app.txt");
    await git(seed, "commit", "-m", "initial");
    await git(seed, "remote", "add", "origin", origin);
    await git(seed, "push", "origin", "main");
    await execFileAsync("git", ["clone", origin, clone]);

    const externalExclude = join(external, "exclude");
    await mkdir(external, { recursive: true });
    await writeFile(externalExclude, "external\n");
    const infoPath = join(clone, ".git", "info");
    await rm(infoPath, { recursive: true, force: true });
    await symlink(external, infoPath, "dir");

    const manager = new GitWorktreeManager(executor);
    await assert.rejects(manager.ensureRuntimeIgnored(clone));
    assert.equal(await readFile(externalExclude, "utf8"), "external\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local exclude update rejects a replacement final-file symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-git-file-link-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  const external = join(root, "external-exclude");
  try {
    await execFileAsync("git", ["init", "--bare", origin]);
    await execFileAsync("git", ["init", "-b", "main", seed]);
    await git(seed, "config", "user.name", "Test");
    await git(seed, "config", "user.email", "test@example.invalid");
    await writeFile(join(seed, "app.txt"), "base\n");
    await git(seed, "add", "app.txt");
    await git(seed, "commit", "-m", "initial");
    await git(seed, "remote", "add", "origin", origin);
    await git(seed, "push", "origin", "main");
    await execFileAsync("git", ["clone", origin, clone]);

    const manager = new GitWorktreeManager(executor);
    await manager.ensureRuntimeIgnored(clone);
    const excludePath = join(clone, ".git", "info", "exclude");
    await writeFile(external, "external\n");
    await rm(excludePath, { force: true });
    await symlink(external, excludePath, "file");

    await assert.rejects(manager.ensureRuntimeIgnored(clone));
    assert.equal(await readFile(external, "utf8"), "external\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
