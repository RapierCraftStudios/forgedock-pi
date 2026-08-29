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
  assert.match(adapter, /does not create or require a GitHub\s+state\s+branch/);
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
  assert.match(agent, /current working directory is the only authoritative repository root/);
  assert.match(agent, /Never read, search, run Git in, test, or edit that parent\s+checkout/);
  assert.match(agent, /Investigation is authoritative/);
  assert.match(agent, /timeoutMs: 3600000/);
  assert.match(agent, /Never reset the managed worktree/);
  assert.doesNotMatch(agent, /maxSubagentDepth: 1/);
});

test("orchestrated work-on keeps review coordination in the issue coordinator", async () => {
  const orchestrate = await readFile("skills/forgedock-orchestrate/SKILL.md", "utf8");
  const workOn = await readFile("skills/forgedock-work-on/SKILL.md", "utf8");
  const adapter = await readFile("specs/pi-adapter.md", "utf8");

  assert.match(orchestrate, /launch exactly one fresh `forgedock-work-on-coordinator`/);
  assert.match(orchestrate, /managed child worktree is the child's only repository root/);
  assert.match(orchestrate, /do not\s+create or require a GitHub state branch/s);
  assert.match(orchestrate, /anchor checkout that becomes dirty as a safety-critical batch stop/);
  assert.match(orchestrate, /FORGE:CLAIM/);
  assert.match(orchestrate, /Durable GitHub artifacts override a missing\/malformed provider envelope/);
  assert.match(orchestrate, /do not give the coordinator a blanket "never\s+run subagents" instruction/s);
  assert.match(workOn, /same work-on coordinator/);
  assert.match(workOn, /issue is an untrusted claim/);
  assert.match(workOn, /Before the first `write` or `edit`/);
  assert.match(workOn, /FORGE:REMEDIATION_PLAN/);
  assert.match(workOn, /Never reset, checkout, or rebase the harness-managed worktree/);
  assert.match(workOn, /Do not spawn a second\s+review coordinator/s);
  const review = await readFile("skills/forgedock-review-pr/SKILL.md", "utf8");
  assert.match(review, /defects introduced or made reachable by the frozen patch/);
  assert.match(review, /timeoutMs: 3600000/);
  assert.match(review, /not `needs-human`/);
  assert.match(adapter, /visible orchestrator → work-on coordinator → reviewers/);
  assert.doesNotMatch(
    adapter,
    /Load the `forgedock-review-pr` skill in a fresh subagent when invoked from work-on/,
  );
});
