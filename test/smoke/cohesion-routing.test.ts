import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const text = (path: string) => readFile(path, "utf8");
const phase = (name: string) => text(`specs/original/commands/work-on/${name}.md`);

test("complexity signals require a recorded cohesion decision, not automatic splitting", async () => {
  const investigate = await phase("investigate");
  assert.match(investigate, /3\+ service groups/);
  assert.match(investigate, /6\+.*files.*directories/s);
  assert.match(investigate, /multiple task types.*phased/s);
  assert.match(investigate, /signals.*assessment.*not.*automatic/s);
  assert.match(investigate, /Cohesion and Decomposition/);
  assert.match(investigate, /atomic.*invariant/s);
  assert.match(investigate, /weak.*input.*not.*refus/s);
});

test("decomposition permits safe sequential overlap and preserves a partial PR", async () => {
  const decompose = await phase("decompose");
  assert.doesNotMatch(decompose, /Child scopes do not overlap/);
  assert.match(decompose, /overlap.*explicit.*dependenc/s);
  assert.match(decompose, /Existing PR or partial implementation/);
  assert.match(decompose, /do not.*close.*PR.*discard/s);
  assert.match(decompose, /approved.*handoff.*disposition/s);
  assert.match(decompose, /acceptance.*mapped.*children/s);
  assert.match(decompose, /do not.*dispatch.*unconfirmed/s);
});

test("review can route to scope reassessment without restarting code rounds", async () => {
  const root = await text("specs/original/commands/work-on.md");
  const remediate = await phase("remediate");
  const review = await phase("review");
  assert.match(root, /decomposition reassessment.*preserve.*PR/s);
  assert.match(review, /scope\s+reassessment.*DECOMPOSE/s);
  assert.match(remediate, /scope reassessment.*decomposition/is);
  assert.match(remediate, /does not reset.*budget/s);
  assert.match(root, /pre-build challenger.*subagent.*forbidden before review/is);
  const entrypoint = await text("src/index.ts");
  assert.match(entrypoint, /registerForgePromptRouter\(pi\)/);
  assert.doesNotMatch(entrypoint, /registerForgeCommands|child-runtime/);
});
