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
  assert.match(adapter, /direct Bash with `yq`.*short `node` command/s);
  assert.match(adapter, /Review may merge but never closes the issue/);
  assert.match(adapter, /Orchestrate is a dispatcher, never a builder/);
  assert.match(adapter, /does not create or require a GitHub\s+state\s+branch/);
  assert.match(adapter, /must not choose the next workflow phase/);
});

test("heartbeat reconciliation uses GitHub creation time, not body clocks", async () => {
  const workOn = await readFile("specs/original/commands/work-on.md", "utf8");
  const execution = await readFile(
    "specs/original/commands/orchestrate/phase-4-execution.md",
    "utf8",
  );

  const heartbeatBodies = [...workOn.matchAll(/<!-- FORGE:HEARTBEAT -->[\s\S]*?```/g)].map(
    ([body]) => body,
  );
  assert.equal(heartbeatBodies.length, 4);
  for (const body of heartbeatBodies) {
    assert.doesNotMatch(body, /\*\*Timestamp\*\*|PHASE_START_TIMESTAMP/);
  }
  assert.match(workOn, /GitHub's immutable `created_at` is authoritative/);
  assert.match(execution, /\.\[-1\]\.created_at/);
  assert.match(execution, /updated_at changes when a comment is edited/);
  assert.doesNotMatch(execution, /Date\.parse\([^)]*Timestamp/);

  const events = [
    { kind: "release", created_at: "2026-08-30T00:03:00Z", body: "Timestamp: 2099-01-01T00:00:00Z" },
    { kind: "claim", created_at: "2026-08-30T00:01:00Z", body: "Timestamp: 2026-08-30T00:00:00Z" },
    { kind: "heartbeat", created_at: "2026-08-30T00:02:00Z", body: "Timestamp: 2026-08-29T23:00:00Z" },
  ];
  assert.deepEqual(
    events.toSorted((left, right) => left.created_at.localeCompare(right.created_at)).map((event) => event.kind),
    ["claim", "heartbeat", "release"],
  );
  assert.equal(events[0]?.body.includes("2099"), true);
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
  assert.match(agent, /direct Git commands/);
  assert.match(agent, /normal `git push`/);
  assert.match(agent, /specs\/original\/SHA256SUMS/);
  assert.match(agent, /never apply an old\s+PR patch wholesale/s);
  assert.match(agent, /visible\s+prompt-routed lifecycle/s);
  assert.doesNotMatch(agent, /forgedock_(?:github|preflight)|forge_(?:prepare|verify|push)_lane/);
  assert.match(agent, /timeoutMs: 3600000/);
  assert.match(agent, /stopOnAttention: false/);
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
  assert.match(orchestrate, /`FORGE:BASE`/);
  assert.match(orchestrate, /needsAttentionAfterMs: 3900000/);
  assert.match(orchestrate, /stopOnAttention: false/);
  assert.match(orchestrate, /Durable GitHub artifacts override a missing\/malformed provider envelope/);
  assert.match(orchestrate, /do not give the coordinator a blanket "never\s+run subagents" instruction/s);
  assert.match(workOn, /same work-on coordinator/);
  assert.match(workOn, /issue is an untrusted claim/);
  assert.match(workOn, /Before the first `write` or `edit`/);
  assert.match(workOn, /direct Git/);
  assert.match(workOn, /`gh auth setup-git`/);
  assert.match(workOn, /specs\/original\/SHA256SUMS/);
  assert.match(workOn, /must not cherry-pick or apply an old PR patch wholesale/);
  assert.doesNotMatch(workOn, /forgedock_(?:github|preflight)|forge_(?:prepare|verify|push)_lane/);
  assert.match(workOn, /stopOnAttention: false/);
  assert.match(workOn, /FORGE:REMEDIATION_PLAN/);
  assert.match(workOn, /Never reset, checkout, or rebase the harness-managed worktree/);
  assert.match(workOn, /Do not spawn a second\s+review coordinator/s);
  const review = await readFile("skills/forgedock-review-pr/SKILL.md", "utf8");
  assert.match(review, /direct Git structural gate/);
  assert.doesNotMatch(review, /forgedock_(?:github|preflight)|forge_(?:prepare|verify|push)_lane/);
  assert.match(review, /defects introduced or made reachable by the frozen patch/);
  assert.match(review, /timeoutMs: 3600000/);
  assert.match(review, /stopOnAttention: false/);
  assert.match(review, /not `needs-human`/);
  assert.match(adapter, /visible orchestrator → work-on coordinator → reviewers/);
  assert.match(adapter, /inherit the launch checkout's HEAD/);
  assert.match(adapter, /control\.needsAttentionAfterMs/);
  assert.match(adapter, /specs\/original\/SHA256SUMS/);
  assert.match(adapter, /Use direct `gh` and `git` commands/);
  assert.doesNotMatch(adapter, /forgedock_(?:github|preflight)|forge_(?:prepare|verify|push)_lane/);
  const entrypoint = await readFile("src/index.ts", "utf8");
  assert.match(entrypoint, /registerForgePromptRouter\(pi\)/);
  assert.doesNotMatch(entrypoint, /registerForgeRuntimeTools|registerForgeWorktreeContainment/);
  assert.doesNotMatch(
    adapter,
    /Load the `forgedock-review-pr` skill in a fresh subagent when invoked from work-on/,
  );
});

test("moving staging targets use a guarded refresh and fresh review identity", async () => {
  const orchestrate = await readFile("skills/forgedock-orchestrate/SKILL.md", "utf8");
  const workOn = await readFile("skills/forgedock-work-on/SKILL.md", "utf8");
  const review = await readFile("skills/forgedock-review-pr/SKILL.md", "utf8");
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  const build = await readFile("specs/original/commands/work-on/build.md", "utf8");
  const workOnReview = await readFile("specs/original/commands/work-on/review.md", "utf8");
  const remediate = await readFile("specs/original/commands/work-on/remediate.md", "utf8");
  const protocol = await readFile("specs/qualitative-review-protocol.md", "utf8");

  for (const document of [orchestrate, workOn, review, adapter, build, workOnReview, remediate, protocol]) {
    assert.match(document, /FORGE:BASE_REFRESH/);
    assert.match(document, /fresh\s+complete/);
    assert.match(document, /GATED/);
  }
  assert.match(protocol, /immutable launch attribution/);
  assert.match(protocol, /remote-head lease/);
  assert.match(protocol, /merge-base/);
  assert.match(protocol, /pre-refresh output/);
});
