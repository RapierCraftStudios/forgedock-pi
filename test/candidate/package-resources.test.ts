import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("candidate manifest loads only the thin active resource roots", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    pi: { extensions: string[]; prompts: string[]; skills: string[]; subagents: { agents: string[] } };
    files: string[];
  };
  assert.deepEqual(manifest.pi.extensions, ["./candidate/extension.ts"]);
  assert.deepEqual(manifest.pi.prompts, ["./candidate/prompts"]);
  assert.deepEqual(manifest.pi.skills, ["./candidate/skills"]);
  assert.deepEqual(manifest.pi.subagents.agents, ["./candidate/agents"]);
  assert.equal(manifest.files.includes("skills/"), false);
  assert.equal(manifest.files.includes("specs/"), false);
  assert.equal(manifest.files.includes("agents/"), false);
});
