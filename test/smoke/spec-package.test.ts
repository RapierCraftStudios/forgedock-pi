import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

const WORK_ON_PHASES = [
  "specs/original/commands/work-on/investigate.md",
  "specs/original/commands/work-on/decompose.md",
  "specs/original/commands/work-on/build.md",
  "specs/original/commands/work-on/review.md",
  "specs/original/commands/work-on/remediate.md",
  "specs/original/commands/work-on/close.md",
] as const;

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("packaged specifications and helpers match their manifest", async () => {
  const manifest = await text("specs/original/SHA256SUMS");
  const entries = manifest.trim().split("\n");
  assert.ok(entries.length >= 100);
  for (const entry of entries) {
    const match = entry.match(/^([a-f0-9]{64})  (.+)$/);
    assert.ok(match, `invalid manifest entry: ${entry}`);
    const [, expected, path] = match;
    const actual = createHash("sha256").update(await readFile(path!)).digest("hex");
    assert.equal(actual, expected, path);
  }
});

test("active work-on authority is compact and Pi-native", async () => {
  const root = await text("specs/original/commands/work-on.md");
  const skill = await text("skills/forgedock-work-on/SKILL.md");
  const adapter = await text("specs/pi-adapter.md");
  const active = [root, skill, adapter, ...(await Promise.all(WORK_ON_PHASES.map(text)))];

  assert.ok(root.split("\n").length <= 260, "root lifecycle must stay routing-only");
  assert.ok(skill.split("\n").length <= 65, "skill must stay a thin entrypoint");
  for (const [path, content] of WORK_ON_PHASES.map((path, i) => [path, active[i + 3]] as const))
    assert.ok(content!.split("\n").length <= 180, `${path} is too large`);

  for (const content of active) {
    assert.doesNotMatch(content!, /\.claude|\.opencode|\.codex|OpenCode|Claude Code/);
    assert.doesNotMatch(content!, /gh gist|FORGE:KNOWLEDGE_GIST|FORGE:HEARTBEAT|FORGE:CHECKPOINT/);
    assert.doesNotMatch(content!, /eval\s+["']\$|bash -c\s+["']\$/);
  }
});

test("one work-on agent owns every pre-review phase inline", async () => {
  const root = await text("specs/original/commands/work-on.md");
  const skill = await text("skills/forgedock-work-on/SKILL.md");
  const agent = await text("agents/forgedock-work-on-coordinator.md");
  const adapter = await text("specs/pi-adapter.md");

  for (const content of [root, skill, agent, adapter]) {
    assert.match(content, /sole work-on agent|sole per-issue work-on agent|sole writer/i);
    assert.match(content, /review|re-review/);
  }
  assert.match(root, /subagent.*forbidden before review/is);
  assert.match(skill, /Do not launch delegates, phase agents, builders, quality-gate agents/);
  assert.match(agent, /only nested-subagent use.*review panel/is);
  assert.match(adapter, /Before review\/re-review it must\s+not call `subagent`/s);
});

test("normal work-on has four durable artifacts and no ceremony", async () => {
  const root = await text("specs/original/commands/work-on.md");
  assert.match(root, /one `FORGE:INVESTIGATOR`/);
  assert.match(root, /one completed `FORGE:BUILDER`/);
  assert.match(root, /PR's reviewer evidence and official review verdict/);
  assert.match(root, /one `FORGE:TRAJECTORY`/);
  assert.match(root, /Do not create Gists, memory\s+indexes, ledgers, dossiers, ADRs/s);
});

test("investigation defines scope without children or executable comments", async () => {
  const investigate = await text(WORK_ON_PHASES[0]);
  assert.match(investigate, /Execute this phase inline.*Do not launch children/s);
  assert.match(investigate, /Same-Behavior Check/);
  assert.match(investigate, /Mutation Scope/);
  assert.match(investigate, /Non-Goals/);
  assert.match(investigate, /Acceptance Checks/);
  assert.match(investigate, /Verdict: CONFIRMED \| INVALID/);
  assert.match(investigate, /Route: BUILD \| DECOMPOSE \| TERMINAL/);
  assert.match(investigate, /Never emit shell commands/);
  assert.match(investigate, /add `workflow:investigating`/);
  assert.match(investigate, /set `workflow:ready-to-build`/);
});

test("build is one inline procedure with SHA-keyed verification", async () => {
  const build = await text(WORK_ON_PHASES[2]);
  assert.match(build, /Do not launch builders, quality-gate\s+agents, context agents, architects/s);
  assert.match(build, /investigation receipt\s+is the mutation contract/s);
  assert.match(build, /Verify once per SHA/);
  assert.match(build, /rerun only the\s+failed command and commands affected by the fix/s);
  assert.match(build, /one immutable issue comment/);
  assert.match(build, /replace `workflow:ready-to-build`.*with `workflow:building`/s);
  assert.match(build, /persisted state\/schema changes/);
  assert.match(build, /request and origin scope, cross-request\s+contamination/s);
  assert.match(build, /FORGE:BUILDER:COMPLETE/);
  for (const deleted of ["context", "architect", "implement", "validate"])
    await assert.rejects(access(`specs/original/commands/work-on/build/${deleted}.md`));
});

test("review keeps exact-head quality without target-movement starvation", async () => {
  const review = await text(WORK_ON_PHASES[3]);
  const reviewSkill = await text("skills/forgedock-review-pr/SKILL.md");
  const adapter = await text("specs/pi-adapter.md");

  for (const content of [review, reviewSkill, adapter]) {
    assert.match(content, /Base movement|target-branch advance|target movement/i);
    assert.match(content, /effective patch/i);
  }
  assert.match(review, /clean\s+and mergeable/i);
  assert.match(review, /review loop/i);
  assert.match(review, /replace `workflow:building`.*with\s+`workflow:in-review`/s);
  assert.match(review, /replace `workflow:in-review` with\s+`workflow:awaiting-merge`/s);
  assert.match(adapter, /review-starvation/i);
  assert.match(reviewSkill, /one\s+additional\s+workflow containing only that role/s);
  assert.match(reviewSkill, /one\s+SHA-bound consolidated panel comment/s);
  assert.match(reviewSkill, /never use `runs\.host`/);
  assert.match(adapter, /`runs\.host` is not available/);
  assert.match(adapter, /Never restart a panel for JSON key casing/);
  assert.match(reviewSkill, /formatting variance alone never restarts a role or panel/);
});

test("remediated executable heads retain security review and ordinary issue review stays approving", async () => {
  const reviewSkill = await text("skills/forgedock-review-pr/SKILL.md");
  assert.match(reviewSkill, /Every new\s+executable-code head also receives security review/s);
  assert.match(reviewSkill, /ordinary issue PR targeting the configured integration branch keeps\s+this standard approving review/s);
});

test("staging review is a compact generic-delegate deployment gate", async () => {
  const staging = await text("skills/forgedock-review-pr-staging/SKILL.md");
  assert.match(staging, /explicit integration-to-protected deployment or bundle PR/);
  assert.match(staging, /fresh ordinary\s+`delegate` agents with full normal tools/s);
  assert.match(staging, /FORGE:STAGING_GATE:PASS/);
  assert.doesNotMatch(staging, /review-pr-staging\.md|Task\(|Agent\(|allowed-tools|needs-human/);
});

test("work-on defines target selection, GATED resume, and remediation-cap exit", async () => {
  const root = await text("specs/original/commands/work-on.md");
  const remediation = await text(WORK_ON_PHASES[4]);
  assert.match(root, /ordinary no-milestone issues use\s+`branches\.staging`/s);
  assert.match(root, /issue has durable GATED prerequisite\/recovery/);
  assert.match(root, /review\.remediation_max_rounds`, default `3`/);
  assert.match(remediation, /return to investigation once/);
  assert.match(remediation, /Remaining blocker at the round cap/);
});

test("review uses generic delegates without package capability ceilings", async () => {
  const reviewSkill = await text("skills/forgedock-review-pr/SKILL.md");
  const adapter = await text("specs/pi-adapter.md");
  const workOnAgent = await text("agents/forgedock-work-on-coordinator.md");
  await assert.rejects(access("agents/forgedock-reviewer.md"));
  assert.doesNotMatch(workOnAgent, /^tools:/m);
  assert.match(reviewSkill, /fresh ordinary `delegate` agents with full normal tool\s+availability/s);
  assert.match(adapter, /does not register a specialized reviewer profile or impose a reviewer capability ceiling/);
  assert.match(reviewSkill, /verified `path:line` behaviors/);
  assert.match(reviewSkill, /confirmed HIGH\/CRITICAL production-incident standard/);
});

test("remediation is cohesive and re-review is scoped", async () => {
  const remediate = await text(WORK_ON_PHASES[4]);
  assert.match(remediate, /same work-on agent remains the sole writer/i);
  assert.match(remediate, /one cohesive patch/);
  assert.match(remediate, /Do not create blocker issues/);
  assert.match(remediate, /blocker-producing personas\s+plus one general reviewer/s);
  assert.match(remediate, /Never rebase and restart re-review/);
});

test("closeout is one terminal receipt and ownership-safe cleanup", async () => {
  const close = await text(WORK_ON_PHASES[5]);
  assert.match(close, /short terminal procedure/);
  assert.match(close, /FORGE:TRAJECTORY/);
  assert.match(close, /must not remove or unregister its active Pi-managed `\$PWD`/);
  assert.match(close, /Cleanup is last/);
  assert.match(close, /Never enumerate or delete unrelated worktrees/);
});

test("orchestrate builds only hard dependency edges and maximizes concurrency", async () => {
  const skill = await text("skills/forgedock-orchestrate/SKILL.md");
  const adapter = await text("specs/pi-adapter.md");

  assert.match(skill, /dispatcher, never a builder/);
  assert.match(skill, /exact shared declared mutation files/);
  assert.match(skill, /Domain tags.*never dependency edges/s);
  assert.match(skill, /prefer isolated parallel work/);
  assert.match(skill, /Independent roots start\s+together/s);
  assert.match(skill, /Do not create a claims-board/);
  assert.match(adapter, /Domain, broad\s+directory, cost, co-change, and low-confidence heuristics never create edges/s);
  assert.match(adapter, /globalConcurrencyLimit/);
  assert.match(adapter, /Promise\.all\(\[a\]\)\.then\(launchC\)/);
  assert.match(adapter, /lifecycleStatus\(result\)/);
  assert.match(adapter, /FORGE_WORK_ON_RESULT status=\(DONE\|GATED\|FAILED\)/);
  assert.match(skill, /FORGE_WORK_ON_RESULT status=DONE/);
  assert.match(adapter, /use and report\s+the extension's effective limit/s);
  assert.match(adapter, /Do not set `maxSubagentSpawnsPerRun`/);
  assert.match(adapter, /attention thresholds at or above the 1,200,000 ms panel join/);
  assert.match(adapter, /at most one concise `contact_supervisor` progress update/);
  assert.doesNotMatch(skill, /maxSubagentSpawnsPerRun/);
});

test("affected-file extraction accepts plain path-line forms", async () => {
  const script = await text("specs/original/scripts/extract-affected-files.sh");
  assert.match(script, /path per line/);
  assert.match(script, /:\[0-9\]/);
  assert.match(script, /may be a declared new file/);
  assert.match(script, /PROVENANCE=body-fallback/);
  assert.equal((script.match(/gh issue view/g) ?? []).length, 1);

  const temp = await mkdtemp("/tmp/forgedock-path-extractor-");
  try {
    await mkdir(`${temp}/bin`);
    await mkdir(`${temp}/scripts/tests`, { recursive: true });
    await writeFile(`${temp}/scripts/prod-smoke-test.sh`, "#!/bin/sh\n");
    await writeFile(`${temp}/scripts/tests/test_identity.py`, "# test\n");
    await writeFile(
      `${temp}/bin/gh`,
      `#!/bin/sh\nprintf '%s\\n' '{"body":"## Affected Files\\n1. scripts/prod-smoke-test.sh:193-198 — normalize value.\\n2. scripts/tests/test_identity.py — cover it.\\n3. package.json — root config.\\n4. new/path/custom.ext — declared new file.\\n5. LICENSE — extensionless tracked root.\\nNode.js is explanatory prose, not a path.","comments":[]}'\n`,
      { mode: 0o755 },
    );
    const result = await execFileAsync(
      "bash",
      ["specs/original/scripts/extract-affected-files.sh", "42", "-R", "owner/repo"],
      { env: { ...process.env, PATH: `${temp}/bin:${process.env.PATH}` } },
    );
    assert.equal(
      result.stdout,
      "PROVENANCE=body-fallback\nLICENSE\nnew/path/custom.ext\npackage.json\nscripts/prod-smoke-test.sh\nscripts/tests/test_identity.py\n",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("issue creation remains canonical for decomposition and follow-ups", async () => {
  const issue = await text("specs/original/commands/issue.md");
  const decompose = await text(WORK_ON_PHASES[1]);
  const reviewSkill = await text("skills/forgedock-review-pr/SKILL.md");
  for (const heading of ["## Problem", "## Root Cause", "## Affected Files", "## Expected Behavior", "## Acceptance Criteria"])
    assert.ok(issue.includes(heading), heading);
  assert.match(decompose, /forgedock-issue/);
  assert.match(reviewSkill, /one valuable independent follow-up issue/);
});

test("prompt router remains the only active extension workflow layer", async () => {
  const entrypoint = await text("src/index.ts");
  const router = await text("src/prompt-router.ts");
  assert.match(entrypoint, /registerForgePromptRouter\(pi\)/);
  assert.doesNotMatch(entrypoint, /registerForgeCommands/);
  assert.match(router, /\/skill:/);
  assert.doesNotMatch(router, /registerTool/);
});
