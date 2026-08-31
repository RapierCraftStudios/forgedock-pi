import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

const exec = promisify(execFile);
const script = resolve("scripts/project-forge-config.mjs");

test("packaged projector bootstraps five independent untracked-config children", async () => {
  await mkdir(resolve(".forge/runtime"), { recursive: true });
  const parent = await mkdtemp(join(resolve(".forge/runtime"), "projection-test-"));
  const canonicalPath = join(parent, "canonical-forge.yaml");
  await writeFile(canonicalPath, `project:
  name: demo
  owner: acme
  repo: app
paths:
  root: /parent/checkout
  worktree_base: /parent/worktrees
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
    test: npm test
`);
  const children = Array.from({ length: 5 }, (_, index) => join(parent, `child-${index}`));
  try {
    for (const child of children) {
      await mkdir(child, { recursive: true });
      const output = join(child, ".forge/runtime/forge.yaml");
      await exec(process.execPath, [script, "--input", canonicalPath, "--output", output, "--child-root", child]);
      const projected = YAML.parse(await readFile(output, "utf8"));
      assert.equal(projected.paths.root, resolve(child));
      assert.equal(projected.paths.worktree_base, resolve(child, ".forge/runtime/worktrees"));
      assert.equal(projected.project.repo, "app");
      assert.equal(projected.review.tech_stack, "TypeScript");
      assert.equal(relative(resolve(child), resolve(projected.paths.worktree_base)).startsWith(".."), false);
      assert.equal((await exec("git", ["check-ignore", "-q", output])).stdout, "");
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("projector rejects symlinked child runtime directories", async () => {
  await mkdir(resolve(".forge/runtime"), { recursive: true });
  const parent = await mkdtemp(join(resolve(".forge/runtime"), "projection-test-"));
  const external = await mkdtemp(join(resolve(".forge/runtime"), "projection-external-"));
  const canonicalPath = join(parent, "canonical-forge.yaml");
  await writeFile(canonicalPath, `project: { name: demo, owner: acme, repo: app }
paths: { root: /parent, worktree_base: /parent/worktrees }
branches: { staging: staging, default: main }
agents: { default_model: a, subagent_model: b }
`);
  const child = join(parent, "child");
  try {
    await mkdir(join(child, ".forge"), { recursive: true });
    await symlink(external, join(child, ".forge/runtime"));
    await assert.rejects(
      exec(process.execPath, [script, "--input", canonicalPath, "--output", join(child, ".forge/runtime/forge.yaml"), "--child-root", child]),
      /must not be a symlink|symlink escape/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("projector fails closed when output escapes the managed runtime", async () => {
  await mkdir(resolve(".forge/runtime"), { recursive: true });
  const parent = await mkdtemp(join(resolve(".forge/runtime"), "projection-test-"));
  const canonicalPath = join(parent, "canonical-forge.yaml");
  await writeFile(canonicalPath, `project: { name: demo, owner: acme, repo: app }
paths: { root: /parent, worktree_base: /parent/worktrees }
branches: { staging: staging, default: main }
agents: { default_model: a, subagent_model: b }
`);
  try {
    const child = join(parent, "child");
    await mkdir(child, { recursive: true });
    await assert.rejects(
      exec(process.execPath, [script, "--input", canonicalPath, "--output", join(parent, "..", "escaped.yaml"), "--child-root", child]),
      /child\/(?:\.forge\/runtime|runtime directory)/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
