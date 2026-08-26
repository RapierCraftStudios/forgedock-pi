import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { materializeForgeAgents } from "../src/agents/materialize.ts";

test("materialized agents preserve role-specific completion guards", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "forgedock-agents-"));

  try {
    const paths = await materializeForgeAgents(worktree);
    const manifests = new Map(
      await Promise.all(
        paths.map(async (path) => [basename(path), await readFile(path, "utf8")] as const),
      ),
    );

    const writer = manifests.get("forge-work-on.md");
    const correctnessReviewer = manifests.get("forge-review-correctness.md");
    const securityReviewer = manifests.get("forge-review-security.md");

    assert.ok(writer);
    assert.ok(correctnessReviewer);
    assert.ok(securityReviewer);
    assert.match(writer, /acceptanceRole: writer\nmaxSubagentDepth: 2\ncompletionGuard: true/);
    assert.match(correctnessReviewer, /acceptanceRole: read-only\nmaxSubagentDepth: 1\ncompletionGuard: false/);
    assert.match(securityReviewer, /acceptanceRole: read-only\nmaxSubagentDepth: 1\ncompletionGuard: false/);
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});
