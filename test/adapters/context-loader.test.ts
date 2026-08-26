import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRepositoryContext } from "../../src/adapters/context-loader.ts";

test("repository context loads root and nearest path guidance with provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-context-"));
  try {
    await mkdir(join(root, "packages", "web", "src"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root rules\n");
    await writeFile(join(root, "package.json"), '{"name":"root"}\n');
    await writeFile(join(root, "packages", "web", "AGENTS.md"), "web rules\n");
    const context = await loadRepositoryContext({
      repositoryRoot: root,
      revision: "abcdef1",
      affectedPaths: ["packages/web/src/app.ts"],
    });
    assert.deepEqual(
      context.map((entry) => entry.path),
      ["AGENTS.md", "package.json", "packages/web/AGENTS.md"],
    );
    assert.equal(context.every((entry) => entry.revision === "abcdef1"), true);
    assert.equal(context.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository context rejects unsafe paths and escaped guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-context-root-"));
  const outside = await mkdtemp(join(tmpdir(), "forgedock-context-outside-"));
  try {
    await mkdir(join(root, "pkg"));
    await writeFile(join(outside, "AGENTS.md"), "outside\n");
    await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
    const context = await loadRepositoryContext({
      repositoryRoot: root,
      revision: "abcdef1",
    });
    assert.equal(context.some((entry) => entry.content.includes("outside")), false);
    await assert.rejects(
      loadRepositoryContext({
        repositoryRoot: root,
        revision: "abcdef1",
        affectedPaths: ["../outside.ts"],
      }),
      /unsafe/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
