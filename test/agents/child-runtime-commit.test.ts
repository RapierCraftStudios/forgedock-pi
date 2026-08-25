import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  allowedNodeTools,
  assertBoundNodeResultHead,
  isForgeRuntimePath,
  parseGitStatusPaths,
} from "../../src/agents/child-runtime.ts";
import type { ForgeNodeResult } from "../../src/agents/contracts.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

test("every bounded non-review node can persist its trusted result", () => {
  for (const node of [
    "resolve",
    "investigate",
    "plan",
    "prepare-worktree",
    "implement",
    "verify",
    "prepare-pr",
  ])
    assert.equal(
      allowedNodeTools(node).has("forge_finalize_node"),
      true,
      `${node} must expose forge_finalize_node`,
    );
  assert.equal(
    allowedNodeTools("review-security").has("forge_finalize_reviewer"),
    true,
  );
  assert.equal(
    allowedNodeTools("review-security").has("forge_finalize_node"),
    false,
  );
  assert.equal(allowedNodeTools("review-security").has("forge_diff"), true);
});

test("bounded verify finalization rejects stale result and artifact heads", () => {
  const result: ForgeNodeResult = {
    schema: "forgedock.node-result/v1",
    runId: "run-1",
    issueNumber: 52,
    nodeId: "verify-1",
    node: "verify",
    status: "completed",
    branch: "forge/52",
    baseSha: "base123456789",
    headSha: "head123456789",
    changedFiles: [],
    verification: [],
    evidence: ["no local commands configured"],
    artifact: {
      schema: "forgedock.phase-artifact/v1",
      phase: "verify",
      headSha: "head123456789",
      checks: [
        {
          name: "local verification",
          required: false,
          status: "not-configured",
          evidence: "No local commands configured.",
        },
      ],
      readiness: "ready-for-ci",
      reason: "Local verification is not configured.",
    },
  };
  assert.doesNotThrow(() =>
    assertBoundNodeResultHead("verify", "head123456789", result),
  );
  assert.throws(
    () => assertBoundNodeResultHead("verify", "other12345678", result),
    /result head SHA does not match/i,
  );
  assert.throws(
    () =>
      assertBoundNodeResultHead("verify", "head123456789", {
        ...result,
        artifact: { ...result.artifact!, headSha: "other12345678" },
      } as ForgeNodeResult),
    /artifact head SHA does not match/i,
  );
});

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
