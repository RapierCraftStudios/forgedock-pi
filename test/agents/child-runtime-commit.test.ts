import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
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
  ForgeOutputLimitError,
  FORGE_REVIEWER_CAPABILITY_CEILING,
  allowedNodeTools,
  appendBounded,
  assertCommittedTree,
  assertCompleteProcessOutput,
  assertCompleteReviewDiff,
  assertReviewerDiffCoverage,
  assertUniqueReviewerProfileIds,
  boundedToolDenial,
  diffChunk,
  forgeCommitArguments,
  forgePushArguments,
  isForgeRuntimePath,
  parseBoundReviewerResult,
  parseGitStatusPaths,
  phaseProjectionLabels,
  reviewerStatusIsTerminal,
  writeTrustedResultFile,
} from "../../src/agents/child-runtime.ts";
import { redactGitHubTokens } from "../../src/adapters/github-api.ts";
import { FORGE_WORK_ON_TOOLS } from "../../src/agents/register.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

test("technical phase failures do not project needs-human authority", () => {
  assert.deepEqual(phaseProjectionLabels("fail"), []);
  assert.deepEqual(phaseProjectionLabels("block"), []);
  assert.deepEqual(phaseProjectionLabels("needs-human"), ["needs-human"]);
});

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
  assert.equal(
    allowedNodeTools("review-architecture").has("forge_finalize_reviewer"),
    true,
  );
  assert.equal(
    allowedNodeTools("review-architecture").has("forge_finalize_node"),
    false,
  );
});

test("reviewer capability ceiling preserves trusted Forge tools", () => {
  assert.equal(FORGE_REVIEWER_CAPABILITY_CEILING.denyExtensions, false);
  assert.equal(
    FORGE_REVIEWER_CAPABILITY_CEILING.allowedTools.includes("forge_diff"),
    true,
  );
  assert.equal(
    FORGE_REVIEWER_CAPABILITY_CEILING.allowedTools.includes(
      "forge_finalize_reviewer",
    ),
    true,
  );
});

test("read-only nodes deny shell and file mutation tools", () => {
  assert.match(boundedToolDenial("resolve", "bash") ?? "", /Shell execution/);
  assert.match(boundedToolDenial("investigate", "write") ?? "", /read-only/);
  assert.match(boundedToolDenial("plan", "edit") ?? "", /read-only/);
  assert.equal(boundedToolDenial("implement", "edit"), undefined);
  assert.equal(boundedToolDenial("implement", "bash"), undefined);
  assert.equal((FORGE_WORK_ON_TOOLS as readonly string[]).includes("bash"), false);
  assert.equal((FORGE_WORK_ON_TOOLS as readonly string[]).includes("subagent"), true);
  assert.equal((FORGE_WORK_ON_TOOLS as readonly string[]).includes("forge_checkpoint"), true);
  assert.equal((FORGE_WORK_ON_TOOLS as readonly string[]).includes("forge_run_review_panel"), false);
  assert.equal((FORGE_WORK_ON_TOOLS as readonly string[]).includes("forge_finalize_reviewer"), true);
  assert.equal(allowedNodeTools(undefined).has("forge_run_review_panel"), false);
  assert.equal(allowedNodeTools(undefined).has("forge_finalize_reviewer"), true);
});

test("runtime path classification follows the checkout case contract", () => {
  assert.equal(isForgeRuntimePath(".PI/agents/worker.md"), false);
  assert.equal(isForgeRuntimePath(".PI/agents/worker.md", true), true);
  assert.equal(isForgeRuntimePath(".FORGE/CACHE/result", true), true);
  assert.equal(isForgeRuntimePath(".Forge/WorkTrees/run", true), true);
  assert.equal(isForgeRuntimePath("src/.pi-value.ts", true), false);
});

test("security evidence overflow stays typed across repeated output chunks", () => {
  const first = appendBounded("", "a".repeat(60 * 1024), 50 * 1024);
  const second = appendBounded(first.value, "b".repeat(60 * 1024), 50 * 1024);
  const processCap = appendBounded("", "c".repeat(100 * 1024 + 1), 100 * 1024);
  assert.equal(first.truncated, true);
  assert.equal(second.truncated, true);
  assert.equal(processCap.truncated, true);
  assert.throws(
    () =>
      assertCompleteProcessOutput(
        { stdoutTruncated: true, stderrTruncated: false },
        "Git path listing",
      ),
    ForgeOutputLimitError,
  );
  assert.throws(
    () =>
      assertCompleteReviewDiff({
        stdout: "x".repeat(50 * 1024 + 1),
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ForgeOutputLimitError,
  );
  assert.throws(
    () => assertReviewerDiffCoverage(undefined, "abcdef1234567890"),
    /requires complete forge_diff coverage/,
  );
  assert.doesNotThrow(() =>
    assertReviewerDiffCoverage(
      {
        headSha: "abcdef1234567890",
        sha256: "a".repeat(64),
        bytes: 42,
        coveredBytes: 42,
      },
      "abcdef1234567890",
    ),
  );
  assert.throws(
    () =>
      assertReviewerDiffCoverage(
        {
          headSha: "abcdef1234567890",
          sha256: "a".repeat(64),
          bytes: 42,
          coveredBytes: 21,
        },
        "abcdef1234567890",
      ),
    /requires complete forge_diff coverage/,
  );
});

test("diff chunks preserve UTF-8 boundaries and contiguous cursors", () => {
  const value = `start-${"é".repeat(20)}-end`;
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < Buffer.byteLength(value)) {
    const chunk = diffChunk(value, cursor, 7);
    chunks.push(chunk.text);
    assert.ok(chunk.end > cursor);
    cursor = chunk.end;
  }
  assert.equal(chunks.join(""), value);
});

test("review polling recognizes textual terminal states from pi-subagents RPC", () => {
  assert.equal(
    reviewerStatusIsTerminal({ text: "Run: child\nState: complete\nResult: /tmp/result.json" }),
    true,
  );
  assert.equal(reviewerStatusIsTerminal({ state: "failed" }), true);
  assert.equal(reviewerStatusIsTerminal({ text: "State: running" }), false);
  assert.equal(reviewerStatusIsTerminal({ text: "State: paused" }), false);
  assert.equal(
    reviewerStatusIsTerminal({
      text: "State: running\nError context included: State: failed",
    }),
    false,
  );
});

test("dynamic reviewer IDs are unique and cannot shadow baselines", () => {
  assert.doesNotThrow(() =>
    assertUniqueReviewerProfileIds([{ id: "architecture" }, { id: "api" }]),
  );
  assert.throws(
    () =>
      assertUniqueReviewerProfileIds([
        { id: "architecture" },
        { id: "architecture" },
      ]),
    /reserved or duplicated/,
  );
  assert.throws(
    () => assertUniqueReviewerProfileIds([{ id: "security" }]),
    /reserved or duplicated/,
  );
});

test("trusted result publication replaces final symlinks and rejects parent symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-result-root-"));
  const outside = await mkdtemp(join(tmpdir(), "forgedock-result-outside-"));
  try {
    const protectedRoot = join(root, ".pi", "forge");
    await mkdir(protectedRoot, { recursive: true });
    const outsideFile = join(outside, "outside.json");
    const resultPath = join(protectedRoot, "review.json");
    await writeFile(outsideFile, "outside\n");
    await symlink(outsideFile, resultPath);

    await writeTrustedResultFile(root, resultPath, "trusted\n");
    assert.equal(await readFile(resultPath, "utf8"), "trusted\n");
    assert.equal(await readFile(outsideFile, "utf8"), "outside\n");
    assert.equal((await lstat(resultPath)).isSymbolicLink(), false);

    await rm(protectedRoot, { recursive: true, force: true });
    await symlink(outside, protectedRoot);
    await assert.rejects(
      writeTrustedResultFile(root, join(protectedRoot, "escaped.json"), "no\n"),
      /real directory|cannot traverse symlinks/,
    );
    await assert.rejects(readFile(join(outside, "escaped.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("review result files are schema and identity bound", () => {
  const value = {
    schema: "forgedock.reviewer-result/v1",
    runId: "forge-run",
    reviewer: "architecture",
    headSha: "abcdef1234567890",
    verdict: "pass",
    findings: [],
    filesReviewed: ["src/index.ts"],
    limitations: [],
  };
  assert.deepEqual(
    parseBoundReviewerResult(JSON.stringify(value), {
      runId: "forge-run",
      reviewer: "architecture",
      headSha: "abcdef1234567890",
    }),
    value,
  );
  assert.throws(
    () =>
      parseBoundReviewerResult(JSON.stringify(value), {
        runId: "other-run",
        reviewer: "architecture",
        headSha: "abcdef1234567890",
      }),
    /identity does not match/,
  );
  assert.throws(
    () =>
      parseBoundReviewerResult("not-json", {
        runId: "forge-run",
        reviewer: "architecture",
        headSha: "abcdef1234567890",
      }),
    /valid JSON/,
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
    assert.equal(changedPaths.some((path) => isForgeRuntimePath(path)), false);

    await git(root, "add", "-A", "--", ...changedPaths);
    const staged = await git(root, "diff", "--cached", "--name-only", "-z", "--");
    const stagedPaths = staged.stdout.split("\0").filter(Boolean).sort();
    assert.deepEqual(stagedPaths, ["new.ts", "source.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git pushes use an empty hooks path and redact GitHub credentials", () => {
  const args = forgePushArguments("/tmp/empty-hooks", [
    "-C",
    "/tmp/repo",
    "push",
    "origin",
    "main",
  ]);
  assert.deepEqual(args, [
    "-c",
    "core.hooksPath=/tmp/empty-hooks",
    "-C",
    "/tmp/repo",
    "push",
    "--no-verify",
    "origin",
    "main",
  ]);
  const token = "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(
    redactGitHubTokens(`git failed: ${token}`),
    "git failed: [redacted-token]",
  );
});

test("controlled hooksPath prevents repository hooks and committed-tree checks fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-hooks-"));
  const maliciousHooks = join(root, "malicious-hooks");
  const emptyHooks = await mkdtemp(join(tmpdir(), "forgedock-empty-hooks-test-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.invalid");
    await writeFile(join(root, "source.ts"), "before\n");
    await git(root, "add", "source.ts");
    await git(root, "commit", "-m", "initial");
    const preCommitHead = (await git(root, "rev-parse", "HEAD")).stdout.trim();

    await mkdir(maliciousHooks);
    const prepareHook = join(maliciousHooks, "prepare-commit-msg");
    const postHook = join(maliciousHooks, "post-commit");
    await writeFile(
      prepareHook,
      "#!/bin/sh\nprintf 'unauthorized\\n' > unauthorized.txt\ngit add unauthorized.txt\n",
    );
    await writeFile(postHook, "#!/bin/sh\nprintf 'ran\\n' > post-hook-ran\n");
    await chmod(prepareHook, 0o755);
    await chmod(postHook, 0o755);
    await git(root, "config", "core.hooksPath", maliciousHooks);

    await writeFile(join(root, "source.ts"), "after\n");
    await git(root, "add", "source.ts");
    const stagedTree = (await git(root, "write-tree")).stdout.trim();
    await execFileAsync(
      "git",
      forgeCommitArguments(root, emptyHooks, "safe commit"),
      { cwd: root, encoding: "utf8" },
    );
    const head = (await git(root, "rev-parse", "HEAD")).stdout.trim();
    const committedTree = (await git(root, "show", "-s", "--format=%T", head)).stdout.trim();
    const actualParent = (await git(root, "rev-parse", `${head}^`)).stdout.trim();
    await assert.rejects(readFile(join(root, "unauthorized.txt"), "utf8"));
    await assert.rejects(readFile(join(root, "post-hook-ran"), "utf8"));
    assertCommittedTree({
      preCommitHead,
      actualParent,
      stagedTree,
      committedTree,
      stagedPaths: ["source.ts"],
      committedPaths: ["source.ts"],
    });
    assert.throws(
      () =>
        assertCommittedTree({
          preCommitHead,
          actualParent,
          stagedTree,
          committedTree: "different-tree",
          stagedPaths: ["source.ts"],
          committedPaths: ["source.ts", "unauthorized.txt"],
        }),
      /Committed tree differs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(emptyHooks, { recursive: true, force: true });
  }
});
