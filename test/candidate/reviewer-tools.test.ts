import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";

test("candidate package includes a source-read-only reviewer and publication-only tool", async () => {
  const agent = await readFile("candidate/agents/forgedock-reviewer.md", "utf8");
  const tool = await readFile("candidate/reviewer-tools.ts", "utf8");
  assert.match(agent, /^tools: read, grep, find, ls, forge_publish_reviewer$/m);
  assert.match(agent, /^subagentOnlyExtensions: \.\.\/reviewer-tools\.ts$/m);
  assert.doesNotMatch(agent, /^tools:.*\b(?:bash|edit|write)\b/m);
  assert.match(tool, /name: "forge_publish_reviewer"/);
  assert.match(tool, /reviewRoot/);
  assert.match(tool, /artifactKey/);
  assert.match(tool, /assertUnderRoot/);
  assert.match(tool, /pi\.exec\("node"/);
});
