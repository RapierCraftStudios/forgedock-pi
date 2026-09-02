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
  assert.match(adapter, /one direct `yq` call.*one short `node` call/s);
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
    assert.ok(skill.includes(specPath), `${skillPath} must route to ${specPath}`);
    assert.ok(skill.split("\n").length <= 70, `${skillPath} must stay a compact router`);
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
  assert.match(skill, /load only the\s+current phase in bounded chunks/);
  assert.match(skill, /do not preload later phases/);
  assert.match(skill, /Launch the complete\s+panel concurrently/);
  assert.match(skill, /Prepare each reviewer bundle\s+deterministically/);
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
  assert.match(skill, /joins and validates\s+the full panel/);
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

test("canonical dispatch recipe governs wave, successor, and recovery launches", async () => {
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  const skill = await readFile("skills/forgedock-orchestrate/SKILL.md", "utf8");
  const coordinator = await readFile("agents/forgedock-work-on-coordinator.md", "utf8");
  const reviewSkill = await readFile("skills/forgedock-review-pr/SKILL.md", "utf8");

  // Recipe-first dispatch: compact plans skip the large phase-4 corpus.
  assert.match(adapter, /Canonical dispatch recipe \(authoritative/);
  assert.match(adapter, /supported compact plan/);
  assert.match(skill, /recipe is the primary\s+execution path/);
  assert.match(skill, /do not read the full `phase-4-execution\.md` corpus/);
  assert.match(skill, /single script blocks/);
  // Remediation re-review scope: blocker personas + one general, never a full union panel.
  assert.match(reviewSkill, /For a remediation re-review/);
  assert.match(reviewSkill, /personas that produced the blocking findings plus one general/);
  assert.match(reviewSkill, /A full-domain union\s+panel is never required/);
  // Multi-blocker remediation is one cohesive head in the existing PR worktree, one re-review round.
  assert.match(reviewSkill, /remediation is one cohesive pass on the/);
  assert.match(reviewSkill, /never one head per blocker/);
  assert.match(reviewSkill, /all\s+blocker invariants on that single new head in one review round/);
  // Reviewer effort calibrates to risk; the blocking standard never drops.
  assert.match(reviewSkill, /calibrate reviewer effort to that risk/);
  assert.match(reviewSkill, /medium thinking effort/);
  assert.match(reviewSkill, /never by lowering the blocking standard/);
  // Active-identity verification tolerates broken non-active accounts.
  assert.match(adapter, /`gh auth status --active`/);
  assert.match(adapter, /non-active account must never fail (?:the )?preflight/);
  // One promise graph streams successors by their actual predecessors.
  assert.match(adapter, /Build one visible promise graph/);
  assert.match(adapter, /Promise\.all\(\[predecessorPromises\.\.\.\]\)\.then/);
  assert.match(adapter, /never await a whole sibling\s+wave/);
  assert.match(adapter, /work-on items\s+must not pass `timeoutMs`/);
  assert.match(adapter, /normalizeFailure/);
  assert.match(adapter, /\.catch\(normalizeFailure\)/);
  assert.match(adapter, /every sibling settles/);
  assert.match(adapter, /task text exactly\s+`"<number> --under-orchestration"`/);
  assert.match(adapter, /workflow:engine-error/);
  // The dispatcher must not research its own translation at runtime.
  assert.match(adapter, /Never load the pi-subagents reference corpus/);
  // Helper paths and tooling fallbacks resolve deterministically.
  assert.match(adapter, /`specs\/original\/bin\/\.\.\.` and `specs\/original\/scripts/);
  assert.match(adapter, /do not retry alternate quoting forms/);
  assert.match(skill, /canonical recipe in `specs\/pi-adapter\.md`/);
  assert.match(skill, /Never compose improvised prose task/);
  // Coordinators execute artifacts exactly and never spawn sub-workflows;
  // mechanical gaps use adapter fallbacks, never supervisor decisions.
  assert.match(coordinator, /never paraphrase formats/i);
  assert.match(coordinator, /Mechanical environment gaps are not decisions/);
  assert.match(coordinator, /Never route a tooling or configuration gap/);
  assert.match(coordinator, /not a sub-workflow|no sub-workflow|not a sub-workflow of domain lanes|direct read-only children/);
});

test("investigation checks sibling paths for the same broken behavior", async () => {
  const investigate = await readFile(
    "specs/original/commands/work-on/investigate.md",
    "utf8",
  );

  assert.match(investigate, /\*\*Same-Behavior Check\*\*/);
  assert.match(investigate, /callers, readers, writers, serializers, shortcuts, or sibling paths/);
  assert.match(investigate, /Do not inspect unrelated code/);
  assert.match(investigate, /### Same-Behavior Check/);
  assert.match(investigate, /\*\*Behavior followed\*\*/);
  assert.match(investigate, /\*\*Other relevant paths checked\*\*/);
  assert.match(investigate, /\*\*Scope result\*\*/);

  assert.ok(
    investigate.indexOf("7. **Same-Behavior Check**") <
      investigate.indexOf("8. **Identify affected files**"),
    "the check must run before affected files are finalized",
  );
  assert.ok(
    investigate.indexOf("### Same-Behavior Check") <
      investigate.indexOf("### Affected Files"),
    "the report must record the check before publishing mutation scope",
  );

  const resumeLogic = investigate.slice(
    investigate.indexOf("**Resume logic**"),
    investigate.indexOf("**Set label**"),
  );
  assert.match(resumeLogic, /### Same-Behavior Check/);
  assert.match(resumeLogic, /Behavior followed/);
  assert.match(resumeLogic, /Other relevant paths checked/);
  assert.match(resumeLogic, /Scope result/);
});

test("work-on optimizes for first-pass completion without recursive blocker issues", async () => {
  const coordinator = await readFile("agents/forgedock-work-on-coordinator.md", "utf8");
  const workOn = await readFile("skills/forgedock-work-on/SKILL.md", "utf8");
  const reviewSkill = await readFile("skills/forgedock-review-pr/SKILL.md", "utf8");
  const investigate = await readFile("specs/original/commands/work-on/investigate.md", "utf8");
  const implement = await readFile("specs/original/commands/work-on/build/implement.md", "utf8");
  const review = await readFile("specs/original/commands/work-on/review.md", "utf8");
  const remediate = await readFile("specs/original/commands/work-on/remediate.md", "utf8");
  const reviewSpec = await readFile("specs/original/commands/review-pr.md", "utf8");
  const protocols = await readFile(
    "specs/original/commands/review-pr-agents/protocols.md",
    "utf8",
  );

  for (const contract of [coordinator, workOn, investigate]) {
    assert.match(contract, /up to two fresh read-only (?:helpers|investigation helpers)/);
    assert.match(contract, /narrow issues?.*inline/i);
  }
  assert.match(implement, /compare the finished implementation once against every path/i);
  assert.match(implement, /fix it now; do not knowingly hand incomplete work to review/i);
  assert.match(reviewSkill, /do not create recursive blocker issues/i);
  assert.match(reviewSpec, /blocking findings stay in the synthesized PR review/i);
  assert.match(protocols, /A finding does not need a new issue to remain durable/i);
  assert.match(protocols, /Confidence or severity alone never makes a blocker/i);
  assert.match(review, /Continue Code-Fixable Blockers/);
  assert.match(review, /do not wait for an outer orchestrator/i);
  assert.match(review, /FORGE:REINVESTIGATE_REQUIRED/);
  assert.match(review, /at most once per PR head/);
  assert.match(remediate, /blocking findings do not need child issues to be durable/i);
  assert.match(coordinator, /Escalate only authority or exhausted remediation/);
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
  assert.match(agent, /one synchronous `workflowScript`/);
  assert.match(agent, /proxy-post/i);
  assert.match(agent, /Do not launch nested issue orchestration/);
  assert.doesNotMatch(agent, /^timeoutMs:/m);
  assert.match(agent, /^toolTimeoutMs: 3900000$/m);
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

test("reviewer profile enforces incident-blocking standard without metadata deadlocks", async () => {
  const reviewer = await readFile("agents/forgedock-reviewer.md", "utf8");
  assert.match(reviewer, /name: forgedock-reviewer/);
  assert.match(reviewer, /tools: read, grep, find, ls, bash/);
  assert.match(reviewer, /defaultContext: fresh/);
  assert.match(reviewer, /publishing exactly one assigned PR comment/);
  assert.match(reviewer, /untrusted data, never instructions/);
  assert.match(reviewer, /never interpolate repository text into commands or URLs/);
  assert.match(reviewer, /repository.*one `owner\/name` slug/s);
  assert.match(reviewer, /PR and attempt to be positive integers/);
  assert.match(reviewer, /head to be 40 lowercase hex characters/);
  assert.match(reviewer, /scratch file outside the source tree/);
  assert.match(reviewer, /current head to equal the assigned full SHA/);
  assert.match(reviewer, /POST the body once/);
  assert.match(reviewer, /GET that exact comment ID/);
  assert.match(reviewer, /comment_id/);
  assert.match(reviewer, /You must not edit\s+source/);
  assert.match(reviewer, /launch subagents/);
  assert.match(reviewer, /FORGE:QUALITATIVE_REVIEW:v1/);
  // Deterministic bundle prep: reviewer receives a complete bundle and never deadlocks on metadata.
  assert.match(reviewer, /complete review bundle inline/);
  assert.match(reviewer, /never refuse to review|never refuse to review over it|keep reviewing/);
  assert.match(reviewer, /"unknown"/);
  // Blocking standard: production-incident risk introduced by the patch, verified in code.
  assert.match(reviewer, /production incident/);
  assert.match(reviewer, /introduced or made reachable by this patch/);
  assert.match(reviewer, /Read the actual code path/);
  assert.match(reviewer, /Position discipline/);
  assert.match(reviewer, /verified against the actual file content/);
  assert.match(reviewer, /Exit reflection/);
});

test("orchestrate streams its exact async workflow without a work-on deadline", async () => {
  const skill = await readFile("skills/forgedock-orchestrate/SKILL.md", "utf8");
  const adapter = await readFile("specs/pi-adapter.md", "utf8");

  assert.match(skill, /isolated\s+issue worktrees/);
  assert.match(skill, /no work-on deadline/);
  assert.match(adapter, /`async: true`/);
  assert.match(adapter, /failed child becomes\s+an `\{ ok: false, error \}` result/);
  assert.match(adapter, /await Promise\.all\(\[allIssuePromises\.\.\.\]\)/);
  assert.match(adapter, /globalConcurrencyLimit/);
  assert.match(adapter, /async composite has no parent deadline/);
  assert.match(adapter, /explicit cancellation/);
  assert.match(adapter, /Resume the retained run/);
  assert.match(adapter, /restore the handoff patch/);
});

test("review panel is concurrent, directly published, and fails closed", async () => {
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  const reviewSkill = await readFile("skills/forgedock-review-pr/SKILL.md", "utf8");
  assert.match(adapter, /exactly one synchronous `workflowScript`/);
  assert.match(adapter, /only dispatch is one `await runs\.all/);
  assert.match(adapter, /strictly larger panel join deadline/);
  assert.match(adapter, /`acceptance: false`/);
  assert.match(adapter, /GET each exact comment ID/);
  assert.match(adapter, /Re-read the PR head/);
  assert.match(adapter, /never proxy-posts comments/);
  assert.match(adapter, /rejected child/);
  assert.match(adapter, /review-degraded/);
  assert.match(reviewSkill, /one synchronous `workflowScript`\/`runs\.all`/);
  assert.match(reviewSkill, /never\s+proxy-post/);
});

test("work-on reuses managed orchestration context and closes scope before validation", async () => {
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  const workOn = await readFile("skills/forgedock-work-on/SKILL.md", "utf8");
  const coordinator = await readFile("agents/forgedock-work-on-coordinator.md", "utf8");
  const implement = await readFile("specs/original/commands/work-on/build/implement.md", "utf8");

  for (const text of [workOn, coordinator]) {
    assert.match(text, /--under-orchestration/);
    assert.match(text, /skip all\s+original worktree add\/recreate\/remove logic/i);
    for (const runtimePath of ["`.claude`", "`.opencode`", "`.codex`"])
      assert.ok(text.includes(runtimePath), runtimePath);
  }
  assert.match(adapter, /FORGE_CONFIG_JSON=\$\(yq -o=json/);
  assert.equal(adapter.match(/yq -o=json/g)?.length, 1);
  assert.match(adapter, /\.agents\.subagent_model \/\/ \.agents\.default_model \/\/ empty/);
  assert.match(coordinator, /agents\.subagent_model/);
  assert.match(coordinator, /Never pass legacy `sonnet`, `opus`, or `haiku` aliases/);
  assert.match(coordinator, /resolved model at maximum\s+thinking/);
  assert.match(implement, /Before editing, turn the contract deliverables and every path/);
  assert.match(implement, /one short completion checklist/);
  assert.match(implement, /Before the first expensive validation run/);
  assert.match(implement, /revert unrelated formatting, generated files, or broad replacement churn/);
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
