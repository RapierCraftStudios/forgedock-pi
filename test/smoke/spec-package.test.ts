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
  assert.match(adapter, /behavioral authority for routing, phase order/);
  assert.match(adapter, /direct Bash with `yq`.*short `node` command/s);
  assert.match(adapter, /Use Pi's `subagent` tool with fresh context/);
  assert.match(adapter, /Orchestrate resolves and confirms the issue set/);
  assert.match(adapter, /must never choose the next workflow phase/);
  assert.match(adapter, /Use direct `gh` and `git` commands/);
  // Runtime plumbing only: no workflow engines, gates, or hidden state.
  assert.doesNotMatch(adapter, /FORGE:BASE_REFRESH/);
  assert.doesNotMatch(adapter, /blocker closure matrix/);
  assert.doesNotMatch(adapter, /forgedock-builder/);
  assert.doesNotMatch(
    adapter,
    /forgedock_(?:github|preflight)|forge_(?:prepare|verify|push)_lane/,
  );
});

test("public skills are thin routers over the original specifications", async () => {
  const routes: Array<[string, string]> = [
    ["skills/forgedock-review-pr/SKILL.md", "specs/original/commands/review-pr.md"],
    [
      "skills/forgedock-review-pr-staging/SKILL.md",
      "specs/original/commands/review-pr-staging.md",
    ],
    ["skills/forgedock-work-on/SKILL.md", "specs/original/commands/work-on.md"],
    [
      "skills/forgedock-orchestrate/SKILL.md",
      "specs/original/commands/orchestrate.md",
    ],
  ];
  for (const [skillPath, specPath] of routes) {
    const skill = await readFile(skillPath, "utf8");
    assert.ok(await readFile(specPath, "utf8"), `missing authority spec ${specPath}`);
    assert.match(skill, /specs\/pi-adapter\.md/);
    assert.match(skill, new RegExp(specPath.replace(/\//g, "\\/")));
    assert.ok(skill.split("\n").length <= 60, `${skillPath} must stay a compact router`);
    for (const banned of [
      /FORGE:BASE_REFRESH/,
      /FORGE:REMEDIATION_PLAN/,
      /blocker closure matrix/,
      /timeoutMs: \d{6,}/,
      /forgedock-builder/,
      /forgedock_(?:github|preflight)|forge_(?:prepare|verify|push)_lane/,
      /FORGE:BUILDER:COMPLETE/,
    ])
      assert.doesNotMatch(skill, banned, `${skillPath} re-speccs workflow mechanics: ${banned}`);
  }
});

test("review-pr is independently invocable without a work-on ownership gate", async () => {
  const skill = await readFile("skills/forgedock-review-pr/SKILL.md", "utf8");
  assert.match(skill, /Every PR is independently\s+reviewable/);
  assert.match(skill, /Launch one complete fresh-context reviewer panel/);
  assert.match(skill, /Merge only when `--auto-merge` was explicit/);
  for (const banned of [
    /work-on[- ]owned PR/,
    /ownership gate/,
    /structural gate/,
    /frozen GitHub patch/,
    /FORGE:CLAIM/,
    /FORGE:CONTRACT/,
  ])
    assert.doesNotMatch(skill, banned, `review must not gate on work-on ownership: ${banned}`);
});

test("work-on routes phases through the original specs and keeps review in-process", async () => {
  const skill = await readFile("skills/forgedock-work-on/SKILL.md", "utf8");
  assert.match(skill, /resolve → investigate/);
  assert.match(skill, /work-on\.md` in bounded chunks/);
  assert.match(skill, /load only the required\s+phase file/);
  assert.match(skill, /forgedock-review-pr/);
  assert.match(skill, /Do not spawn a second\s+review coordinator/s);
  assert.match(skill, /Join every selected reviewer/);
  assert.match(skill, /work-on\/close\.md/);
  // The lifecycle runs inline in the coordinator; no builder handoff machinery.
  assert.doesNotMatch(skill, /B0-B2/);
  assert.doesNotMatch(skill, /builder handoff|fresh builder/i);
});

test("orchestrate dispatches coordinators and reports state without building", async () => {
  const skill = await readFile("skills/forgedock-orchestrate/SKILL.md", "utf8");
  assert.match(skill, /The visible session is a dispatcher, never a builder/);
  assert.match(skill, /one fresh `forgedock-work-on-coordinator`/);
  assert.match(skill, /orchestration\.max_concurrent/);
  assert.match(skill, /GATED is not FAILED/);
  assert.match(skill, /Do not poll/);
});

test("one canonical issue schema governs every ForgeDock creator", async () => {
  const issue = await readFile("specs/original/commands/issue.md", "utf8");
  const review = await readFile("specs/original/commands/review-pr.md", "utf8");
  const staging = await readFile("specs/original/commands/review-pr-staging.md", "utf8");

  for (const heading of [
    "## Problem",
    "## Affected Files",
    "## Acceptance Criteria",
  ])
    assert.ok(issue.includes(heading), heading);
  assert.match(issue, /`## Problem` is MANDATORY/);
  assert.match(issue, /`## Acceptance Criteria` is MANDATORY/);
  for (const creator of [review, staging]) {
    assert.match(creator, /Skill\(skill="issue"/);
  }
  for (const port of [
    "skills/forgedock-issue/SKILL.md",
    "skills/forgedock-review-pr/SKILL.md",
    "skills/forgedock-review-pr-staging/SKILL.md",
    "agents/forgedock-work-on-coordinator.md",
    "specs/pi-adapter.md",
  ]) {
    assert.match(await readFile(port, "utf8"), /forgedock-issue/);
  }
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
  assert.match(agent, /current working directory is the only authoritative repository root/);
  assert.match(agent, /forgedock-reviewer/);
  assert.match(agent, /Join|joined/);
  assert.match(agent, /Do not launch nested issue orchestration/);
  assert.match(agent, /forgedock-issue/);
  assert.doesNotMatch(agent, /forgedock_(?:github|preflight)|forge_(?:prepare|verify|push)_lane/);
  assert.doesNotMatch(agent, /maxSubagentDepth: 1/);
  // One compact profile, not a re-specced lifecycle.
  assert.ok(agent.split("\n").length <= 70);
  for (const banned of [
    /FORGE:BASE/,
    /FORGE:REMEDIATION_PLAN/,
    /blocker closure matrix/,
    /timeoutMs: 3600000/,
    /forgedock-builder/,
  ])
    assert.doesNotMatch(agent, banned);
});

test("reviewer profile is read-only with a structured return contract", async () => {
  const reviewer = await readFile("agents/forgedock-reviewer.md", "utf8");
  assert.match(reviewer, /name: forgedock-reviewer/);
  assert.match(reviewer, /tools: read, grep, find, ls/);
  assert.match(reviewer, /defaultContext: fresh/);
  assert.match(reviewer, /You must not:/);
  assert.match(reviewer, /launch subagents/);
  assert.match(reviewer, /FORGE:QUALITATIVE_REVIEW:v1/);
});

test("headless orchestrate waits on its exact async workflow", async () => {
  const skill = await readFile("skills/forgedock-orchestrate/SKILL.md", "utf8");
  const adapter = await readFile("specs/pi-adapter.md", "utf8");

  assert.match(skill, /isolated issue\s+worktrees|isolated issue worktrees/);
  assert.match(adapter, /`async: true`/);
  assert.match(adapter, /await runs\.all/);
  assert.match(adapter, /globalConcurrencyLimit/);
  assert.match(adapter, /subagent_wait/);
  assert.match(adapter, /stopOnAttention: false/);
  assert.match(adapter, /GATED\/FAILED evidence, never successful orchestration/);
});

test("reviewer deadlines stay runtime plumbing, never workflow gates", async () => {
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  assert.match(adapter, /generous `timeoutMs`/);
  assert.match(adapter, /generic attention event is observational/);
  assert.match(adapter, /stopOnAttention: false/);
  assert.match(adapter, /incomplete panel\s+fails closed/);
});

test("original corpus retains its tested upstream anchors", async () => {
  const workOn = await readFile("specs/original/commands/work-on.md", "utf8");
  const review = await readFile("specs/original/commands/review-pr.md", "utf8");
  const remediate = await readFile("specs/original/commands/work-on/remediate.md", "utf8");
  const execution = await readFile(
    "specs/original/commands/orchestrate/phase-4-execution.md",
    "utf8",
  );
  assert.match(workOn, /Universal Phase Dispatcher/);
  assert.match(workOn, /UNDER_ORCHESTRATION/);
  assert.match(review, /Phase 3: Agent Selection & Launch/);
  assert.match(remediate, /## Phase M6: Re-Invoke \/review-pr/);
  assert.match(execution, /orchestration\.max_concurrent/);
});
