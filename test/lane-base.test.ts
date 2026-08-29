import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  LaneBaseError,
  prepareManagedLaneBase,
  verifyManagedLaneScope,
} from "../src/lane-base.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createFixture(): Promise<{
  root: string;
  child: string;
  stagingSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "forgedock-lane-base-"));
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  const child = join(root, "child");
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await git(repository, "config", "user.name", "ForgeDock Test");
  await git(repository, "config", "user.email", "forgedock@example.test");
  await writeFile(join(repository, "base.txt"), "base\n");
  await mkdir(join(repository, "specs", "original", "commands"), { recursive: true });
  await writeFile(
    join(repository, "specs", "original", "commands", "tracked.md"),
    "tracked\n",
  );
  await writeFile(
    join(repository, "specs", "original", "SHA256SUMS"),
    `${"0".repeat(64)}  specs/original/commands/tracked.md\n`,
  );
  await git(repository, "add", "base.txt", "specs/original");
  await git(repository, "commit", "-m", "base");
  const stagingSha = await git(repository, "rev-parse", "HEAD");
  await git(repository, "branch", "staging", stagingSha);
  await writeFile(join(repository, "main.txt"), "main only\n");
  await git(repository, "add", "main.txt");
  await git(repository, "commit", "-m", "main only");
  await git(repository, "remote", "add", "origin", remote);
  await git(repository, "push", "origin", "main", "staging");
  await git(repository, "worktree", "add", child, "-b", "pi-parallel-lane", "main");
  return { root, child, stagingSha };
}

test("managed lane base initializes one clean unpushed branch to the frozen target", async () => {
  const fixture = await createFixture();
  try {
    const result = await prepareManagedLaneBase({
      repositoryRoot: fixture.child,
      targetRef: "staging",
      targetSha: fixture.stagingSha,
    });
    assert.equal(result.schema, "forgedock.lane-base/v1");
    assert.equal(result.branch, "pi-parallel-lane");
    assert.equal(result.targetSha, fixture.stagingSha);
    assert.equal(result.initialized, true);
    assert.equal(await git(fixture.child, "rev-parse", "HEAD"), fixture.stagingSha);
    assert.equal(await git(fixture.child, "status", "--porcelain"), "");

    await mkdir(join(fixture.child, "src"));
    await writeFile(join(fixture.child, "src", "approved.ts"), "export {};\n");
    await git(fixture.child, "add", "src/approved.ts");
    await git(fixture.child, "commit", "-m", "approved lane change");
    const headSha = await git(fixture.child, "rev-parse", "HEAD");
    const scope = await verifyManagedLaneScope({
      repositoryRoot: fixture.child,
      targetRef: "staging",
      routeBaseRef: "staging",
      baseSha: fixture.stagingSha,
      headSha,
      claimedPaths: ["src/**"],
    });
    assert.deepEqual(scope.changedPaths, ["src/approved.ts"]);
    await assert.rejects(
      verifyManagedLaneScope({
        repositoryRoot: fixture.child,
        targetRef: "staging",
        routeBaseRef: "staging",
        baseSha: fixture.stagingSha,
        headSha: fixture.stagingSha,
        claimedPaths: ["src/**"],
      }),
      (error: unknown) =>
        error instanceof LaneBaseError && /does not match assigned worktree HEAD/.test(error.message),
    );
    await writeFile(join(fixture.child, "dirty.txt"), "dirty\n");
    await assert.rejects(
      verifyManagedLaneScope({
        repositoryRoot: fixture.child,
        targetRef: "staging",
        routeBaseRef: "staging",
        baseSha: fixture.stagingSha,
        headSha,
        claimedPaths: ["src/**"],
      }),
      (error: unknown) =>
        error instanceof LaneBaseError && /not clean at lane-scope/.test(error.message),
    );
    await rm(join(fixture.child, "dirty.txt"));
    await assert.rejects(
      verifyManagedLaneScope({
        repositoryRoot: fixture.child,
        targetRef: "staging",
        routeBaseRef: "staging",
        baseSha: fixture.stagingSha,
        headSha,
        claimedPaths: ["README.md"],
      }),
      (error: unknown) =>
        error instanceof LaneBaseError && /violates the final claim/.test(error.message),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("lane scope requires the manifest for tracked original specification changes", async () => {
  const fixture = await createFixture();
  try {
    await prepareManagedLaneBase({
      repositoryRoot: fixture.child,
      targetRef: "staging",
      targetSha: fixture.stagingSha,
    });
    await writeFile(
      join(fixture.child, "specs", "original", "commands", "tracked.md"),
      "changed\n",
    );
    await git(fixture.child, "add", "specs/original/commands/tracked.md");
    await git(fixture.child, "commit", "-m", "change tracked spec");
    let headSha = await git(fixture.child, "rev-parse", "HEAD");
    await assert.rejects(
      verifyManagedLaneScope({
        repositoryRoot: fixture.child,
        targetRef: "staging",
        routeBaseRef: "staging",
        baseSha: fixture.stagingSha,
        headSha,
        claimedPaths: ["specs/original/commands/tracked.md"],
      }),
      (error: unknown) =>
        error instanceof LaneBaseError && /SHA256SUMS must change/.test(error.message),
    );

    await writeFile(
      join(fixture.child, "specs", "original", "SHA256SUMS"),
      `${"1".repeat(64)}  specs/original/commands/tracked.md\n`,
    );
    await git(fixture.child, "add", "specs/original/SHA256SUMS");
    await git(fixture.child, "commit", "-m", "refresh manifest");
    headSha = await git(fixture.child, "rev-parse", "HEAD");
    const scope = await verifyManagedLaneScope({
      repositoryRoot: fixture.child,
      targetRef: "staging",
      routeBaseRef: "staging",
      baseSha: fixture.stagingSha,
      headSha,
      claimedPaths: [
        "specs/original/commands/tracked.md",
        "specs/original/SHA256SUMS",
      ],
    });
    assert.deepEqual(scope.changedPaths, [
      "specs/original/SHA256SUMS",
      "specs/original/commands/tracked.md",
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("managed lane base refuses dirty or pushed branches", async () => {
  const dirty = await createFixture();
  try {
    await writeFile(join(dirty.child, "dirty.txt"), "dirty\n");
    await assert.rejects(
      prepareManagedLaneBase({
        repositoryRoot: dirty.child,
        targetRef: "staging",
        targetSha: dirty.stagingSha,
      }),
      (error: unknown) =>
        error instanceof LaneBaseError && /not clean/.test(error.message),
    );
  } finally {
    await rm(dirty.root, { recursive: true, force: true });
  }

  const pushed = await createFixture();
  try {
    await git(pushed.child, "push", "-u", "origin", "HEAD");
    await assert.rejects(
      prepareManagedLaneBase({
        repositoryRoot: pushed.child,
        targetRef: "staging",
        targetSha: pushed.stagingSha,
      }),
      (error: unknown) =>
        error instanceof LaneBaseError && /already tracks/.test(error.message),
    );
  } finally {
    await rm(pushed.root, { recursive: true, force: true });
  }
});
