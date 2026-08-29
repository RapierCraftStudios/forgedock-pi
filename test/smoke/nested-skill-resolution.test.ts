import assert from "node:assert/strict";
import test from "node:test";

import {
  FORGE_NESTED_SKILL_TRANSLATIONS,
  FORGE_PUBLIC_SKILLS,
  resolveForgeSkillReference,
  resolveReachableForgeSkillReferences,
} from "../../src/package-contract.ts";

test("every nested mandatory skill reference reachable from public skills resolves", () => {
  const resolution = resolveReachableForgeSkillReferences(process.cwd());
  assert.deepEqual(resolution.missing, []);
  assert.ok(resolution.references.length >= FORGE_PUBLIC_SKILLS.length);
  assert.equal(
    resolution.references.some((reference) => reference.requested === "test-gate"),
    true,
  );
  assert.equal(
    resolution.references.some((reference) => reference.requested === "issue"),
    true,
  );
});

test("mandatory nested calls resolve to packaged Pi translations", () => {
  for (const [requested, translated] of Object.entries(
    FORGE_NESTED_SKILL_TRANSLATIONS,
  )) {
    const resolved = resolveForgeSkillReference(requested, process.cwd());
    assert.equal(resolved?.kind, "skill");
    assert.match(resolved?.target ?? "", new RegExp(`${translated}/SKILL\\.md$`));
  }
});

test("missing nested references fail closed", () => {
  const resolution = resolveForgeSkillReference("does-not-exist", process.cwd());
  assert.equal(resolution, undefined);
});
