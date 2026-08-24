import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  FORGE_RUNTIME_PATHS,
  filterForgeRuntimeStatus,
  findUnexpectedForgeRuntimePaths,
  forgeProductStagingArgs,
  forgeTrackedStagingArgs,
  parseGitPathList,
} from "../../src/agents/commit-staging.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
  });
  return result.stdout;
}

test("product staging excludes generated Forge files without repository ignore rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-commit-staging-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "ForgeDock Test");
    await git(root, "config", "user.email", "forgedock-test@example.invalid");
    await writeFile(join(root, "README.md"), "base\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "initial");

    const generatedPath = join(root, ".pi", "agents", "forge-work-on.md");
    await mkdir(join(root, ".pi", "agents"), { recursive: true });
    await writeFile(
      generatedPath,
      "extensions:\n  - /machine-specific/pi-subagents/index.ts\n",
    );
    await writeFile(join(root, "implementation.ts"), "export const ok = true;\n");

    await git(root, ...forgeTrackedStagingArgs());
    await git(root, ...forgeProductStagingArgs());

    const staged = parseGitPathList(
      await git(root, "diff", "--cached", "--name-only", "-z", "--"),
    );
    const headRuntime = parseGitPathList(
      await git(
        root,
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "HEAD",
        "--",
        ...FORGE_RUNTIME_PATHS,
      ),
    );

    assert.deepEqual(staged, ["implementation.ts"]);
    assert.deepEqual(
      findUnexpectedForgeRuntimePaths(staged, headRuntime),
      [],
    );

    await git(root, "commit", "-m", "implementation");
    const committedFiles = parseGitPathList(
      await git(root, "ls-tree", "-r", "--name-only", "-z", "HEAD"),
    );
    assert.deepEqual(committedFiles, ["README.md", "implementation.ts"]);
    assert.equal(await readFile(join(root, "implementation.ts"), "utf8"), "export const ok = true;\n");
    await assert.rejects(
      git(root, "show", "HEAD:.pi/agents/forge-work-on.md"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-only untracked status entries are not product dirt", () => {
  assert.equal(
    filterForgeRuntimeStatus(
      "?? .pi/agents/forge-work-on.md\n?? .pi/forge/run.json\n?? implementation.ts\n",
    ),
    "?? implementation.ts\n",
  );
  assert.equal(
    filterForgeRuntimeStatus(" M .pi/agents/tracked.md\n"),
    " M .pi/agents/tracked.md\n",
  );
});

test("newly staged Forge runtime paths fail the pre-commit guard", () => {
  assert.deepEqual(
    findUnexpectedForgeRuntimePaths(
      ["implementation.ts", ".pi/agents/forge-review-security.md", ".pi/forge/run.json"],
      ["README.md"],
    ),
    [".pi/agents/forge-review-security.md", ".pi/forge/run.json"],
  );
  assert.deepEqual(
    findUnexpectedForgeRuntimePaths(
      [".pi/agents/intentional.md"],
      [".pi/agents/intentional.md"],
    ),
    [],
  );
});
