import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("review-pr preserves canonical bare-number identity resolution", async () => {
  const prompt = await readFile("candidate/prompts/review-pr.md", "utf8");
  const skill = await readFile("candidate/skills/forgedock-review-pr/SKILL.md", "utf8");
  assert.match(prompt, /bare positive PR number/);
  assert.match(prompt, /canonical `forge\.yaml`/);
  assert.match(prompt, /Do not ask for a URL or repository/);
  assert.match(skill, /bare positive PR number/);
  assert.match(skill, /project\.owner\/repo/);
  assert.match(skill, /Ask for clarification only when/);
});
