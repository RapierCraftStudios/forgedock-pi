import assert from "node:assert/strict";
import test from "node:test";
import {
  ForgeYamlError,
  loadForgeYaml,
  parseForgeYaml,
  projectForgeYaml,
} from "../../src/adapters/forge-yaml.ts";

test("shared forge.yaml reader loads the repository configuration", async () => {
  const config = await loadForgeYaml(".");
  assert.equal(config.repository, "RapierCraftStudios/forgedock-pi");
  assert.equal(config.branches.staging, "staging");
  assert.equal(config.branches.default, "main");
  assert.equal(config.agents.subagentModel, "openai-codex/gpt-5.6-luna");
});

test("forge.yaml reader accepts multiline scalars and absolute configured paths", () => {
  const parsed = parseForgeYaml(`project:\n  name: demo\n  owner: acme\n  repo: app\npaths:\n  root: /srv/acme/app\n  worktree_base: /srv/acme/worktrees\nbranches:\n  staging: staging\n  default: main\n  context: |\n    retained\n    guidance\nagents:\n  default_model: model/a\n  subagent_model: model/b\n`);
  assert.ok(parsed && typeof parsed === "object");
});

test("forge.yaml reader fails closed for missing required fields and malformed YAML", async () => {
  await assert.rejects(loadForgeYaml("/tmp"), ForgeYamlError);
  assert.throws(() => parseForgeYaml("project: [unterminated"), ForgeYamlError);
});

test("managed projection preserves policy and rewrites only child-local paths", () => {
  const canonical = `project:
  name: demo
  owner: acme
  repo: app
paths:
  root: /parent/checkout
  worktree_base: /parent/checkout/.claude/worktrees
branches:
  staging: staging
  default: main
agents:
  default_model: model/a
  subagent_model: model/b
review:
  tech_stack: TypeScript
verification:
  commands:
    typescript:
      typecheck: npm run typecheck
`;
  const projected = parseForgeYaml(
    projectForgeYaml(canonical, "/managed/children/issue-1"),
  ) as {
    paths: { root: string; worktree_base: string };
    project: unknown;
    branches: unknown;
    agents: unknown;
    review: unknown;
    verification: unknown;
  };

  assert.equal(projected.paths.root, "/managed/children/issue-1");
  assert.equal(
    projected.paths.worktree_base,
    "/managed/children/issue-1/.forge/runtime/worktrees",
  );
  assert.deepEqual(projected.project, { name: "demo", owner: "acme", repo: "app" });
  assert.deepEqual(projected.branches, { staging: "staging", default: "main" });
  assert.deepEqual(projected.agents, {
    default_model: "model/a",
    subagent_model: "model/b",
  });
  assert.deepEqual(projected.review, { tech_stack: "TypeScript" });
  assert.deepEqual(projected.verification, {
    commands: { typescript: { typecheck: "npm run typecheck" } },
  });
  assert.doesNotMatch(JSON.stringify(projected), /parent\/(?:checkout|worktrees)/);
});

test("managed projection validates before rewriting and rejects unsafe child roots", () => {
  const invalid = `project: { name: demo, owner: acme, repo: app }
paths: { root: /parent, worktree_base: /parent/worktrees }
branches: { staging: staging, default: main }
`;
  assert.throws(
    () => projectForgeYaml(invalid, "/managed/child"),
    ForgeYamlError,
  );
  assert.throws(
    () => projectForgeYaml("", "relative/child"),
    /absolute path/,
  );
  assert.throws(
    () => projectForgeYaml("", "/managed/child\0evil"),
    /absolute path/,
  );
});
