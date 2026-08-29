import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("packaged original specifications and helpers match their manifest", async () => {
  const manifest = await readFile("specs/original/SHA256SUMS", "utf8");
  const entries = manifest.trim().split("\n");
  assert.ok(entries.length >= 100, "expected the complete original command/helper corpus");
  for (const entry of entries) {
    const match = entry.match(/^([a-f0-9]{64})  (.+)$/);
    assert.ok(match, `invalid SHA256SUMS entry: ${entry}`);
    const [, expected, path] = match;
    const actual = createHash("sha256")
      .update(await readFile(path as string))
      .digest("hex");
    assert.equal(actual, expected, path);
  }
});

test("Pi adapter keeps workflow decisions in visible specifications", async () => {
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  assert.match(adapter, /visible Pi session is the coordinator/);
  assert.match(adapter, /GitHub issue\/PR state/);
  assert.match(adapter, /yq.*not a hard failure in Pi/s);
  assert.match(adapter, /Review may merge but never closes the issue/);
  assert.match(adapter, /Orchestrate is a dispatcher, never a builder/);
  assert.match(adapter, /must not choose the next workflow phase/);
});

test("package exposes a depth-bounded work-on coordinator with reviewer fanout", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.deepEqual(packageJson.pi.subagents.agents, ["./agents"]);
  assert.ok(packageJson.files.includes("agents/"));

  const agent = await readFile("agents/forgedock-work-on-coordinator.md", "utf8");
  assert.match(agent, /name: forgedock-work-on-coordinator/);
  assert.match(agent, /allowNestedSubagents: true/);
  assert.match(agent, /tools:.*\bsubagent\b/);
  assert.match(agent, /skills: forgedock-work-on, forgedock-review-pr/);
  assert.match(agent, /visible orchestrator → work-on coordinator → fresh reviewers/);
  assert.doesNotMatch(agent, /maxSubagentDepth: 1/);
});

test("orchestrated work-on keeps review coordination in the issue coordinator", async () => {
  const orchestrate = await readFile("skills/forgedock-orchestrate/SKILL.md", "utf8");
  const workOn = await readFile("skills/forgedock-work-on/SKILL.md", "utf8");
  const adapter = await readFile("specs/pi-adapter.md", "utf8");

  assert.match(orchestrate, /launch exactly one fresh `forgedock-work-on-coordinator`/);
  assert.match(orchestrate, /do not give the coordinator a blanket "never\s+run subagents" instruction/s);
  assert.match(workOn, /same work-on coordinator/);
  assert.match(workOn, /Do not spawn a second\s+review coordinator/s);
  assert.match(adapter, /visible orchestrator → work-on coordinator → reviewers/);
  assert.doesNotMatch(
    adapter,
    /Load the `forgedock-review-pr` skill in a fresh subagent when invoked from work-on/,
  );
});
