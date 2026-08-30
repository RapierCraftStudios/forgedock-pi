import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadForgeYaml, parseForgeYaml, ForgeYamlError } from "../../src/adapters/forge-yaml.ts";

test("shared forge.yaml reader loads the repository configuration", async () => {
  const config = await loadForgeYaml(".");
  assert.equal(config.repository, "RapierCraftStudios/forgedock-pi");
  assert.equal(config.branches.staging, "staging");
  assert.equal(config.branches.default, "main");
  assert.equal(config.agents.subagentModel, "openai-codex/gpt-5.6-luna");
  assert.equal(config.orchestration.maxConcurrent, 4);
});

test("forge.yaml reader accepts multiline scalars and absolute configured paths", () => {
  const parsed = parseForgeYaml(`project:\n  name: demo\n  owner: acme\n  repo: app\npaths:\n  root: /srv/acme/app\n  worktree_base: /srv/acme/worktrees\nbranches:\n  staging: staging\n  default: main\n  context: |\n    retained\n    guidance\nagents:\n  default_model: model/a\n  subagent_model: model/b\norchestration:\n  max_concurrent: 8\n`);
  assert.ok(parsed && typeof parsed === "object");
});

test("forge.yaml reader fails closed for missing required fields and malformed YAML", async () => {
  await assert.rejects(loadForgeYaml("/tmp"), ForgeYamlError);
  assert.throws(() => parseForgeYaml("project: [unterminated"), ForgeYamlError);
  const root = await mkdtemp(join(tmpdir(), "forgedock-yaml-"));
  try {
    await writeFile(
      join(root, "forge.yaml"),
      `project:\n  name: demo\n  owner: acme\n  repo: app\npaths:\n  root: .\n  worktree_base: .forge/worktrees\nbranches:\n  staging: staging\n  default: main\nagents:\n  default_model: model/a\n  subagent_model: model/b\norchestration:\n  max_concurrent: 0\n`,
    );
    await assert.rejects(loadForgeYaml(root), ForgeYamlError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
