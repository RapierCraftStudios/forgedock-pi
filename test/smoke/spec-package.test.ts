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

test("one canonical issue schema governs every ForgeDock creator", async () => {
  const issue = await readFile("specs/original/commands/issue.md", "utf8");
  const review = await readFile("specs/original/commands/review-pr.md", "utf8");
  const staging = await readFile("specs/original/commands/review-pr-staging.md", "utf8");
  const signalPlanner = await readFile("specs/original/commands/signal-planner.md", "utf8");
  const upgradeDeps = await readFile("specs/original/commands/upgrade-deps.md", "utf8");
  const resolutionPhase = await readFile(
    "specs/original/commands/orchestrate/phase-1-resolve.md",
    "utf8",
  );
  const dependencyPhase = await readFile(
    "specs/original/commands/orchestrate/phase-3-dependency.md",
    "utf8",
  );
  const workOnSpec = await readFile("specs/original/commands/work-on.md", "utf8");
  const issueSkill = await readFile("skills/forgedock-issue/SKILL.md", "utf8");
  const reviewSkill = await readFile("skills/forgedock-review-pr/SKILL.md", "utf8");
  const stagingSkill = await readFile("skills/forgedock-review-pr-staging/SKILL.md", "utf8");
  const coordinator = await readFile("agents/forgedock-work-on-coordinator.md", "utf8");
  const adapter = await readFile("specs/pi-adapter.md", "utf8");

  const headings = ["## Problem", "## Root Cause", "## Affected Files", "## Expected Behavior", "## Acceptance Criteria"];
  for (const heading of headings) assert.ok(issue.includes(heading), heading);
  assert.match(issue, /Each exact heading line appears once/);
  assert.match(issue, /Heading line numbers are strictly ordered/);
  assert.match(issue, /at least one actionable unchecked `- \[ \]` item/);
  assert.match(issue, /User\/legacy issues remain valid work-on inputs/);
  assert.doesNotMatch(issue, /MISSING_SECTIONS=/);
  assert.doesNotMatch(issue, /adding placeholders/);
  assert.doesNotMatch(issue, /silently repair/);
  assert.doesNotMatch(issue, /already section-repaired/);
  assert.doesNotMatch(issue, /3F repairs/);
  assert.doesNotMatch(issue, /Files that need changes \(ordered by dependency/);
  assert.doesNotMatch(issue, /will need to touch/);
  assert.ok(
    issue.indexOf("### 4C.5: Canonical Body Read-Back") <
      issue.lastIndexOf("ISSUE_CREATE_RESULT:CREATED"),
  );

  for (const findingSpec of [review, staging]) {
    assert.match(findingSpec, /## Problem/);
    assert.match(findingSpec, /## Root Cause/);
    assert.match(findingSpec, /## Affected Files/);
    assert.match(findingSpec, /## Expected Behavior/);
    assert.match(findingSpec, /## Acceptance Criteria/);
    assert.match(findingSpec, /Candidate investigation starting points \(not mutation authority\)/);
    assert.match(findingSpec, /Skill\(skill="issue"/);
  }
  assert.doesNotMatch(staging, /STAGING_FINDING_TITLE="chore:/);
  assert.doesNotMatch(staging, /Title: `Staging Review:/);
  assert.match(staging, /STAGING_FINDING_TITLE="fix:/);
  for (const creator of [signalPlanner, upgradeDeps, resolutionPhase, dependencyPhase]) {
    for (const heading of headings) assert.ok(creator.includes(heading), heading);
    assert.match(creator, /Skill\(skill="issue"/);
    assert.match(creator, /FORGE:BODY-INTEGRITY/);
  }
  assert.doesNotMatch(upgradeDeps, /^gh issue create/m);
  assert.doesNotMatch(dependencyPhase, /\$\(gh issue create/);
  assert.match(dependencyPhase, /refusing to orchestrate without the overlap-safety claims board/);
  assert.match(dependencyPhase, /exit 1/);
  assert.match(signalPlanner, /FORGE:BODY-INTEGRITY:signal-work-unit_/);
  assert.doesNotMatch(signalPlanner, /Phase 3F will non-blockingly/);
  assert.match(workOnSpec, /Preserve Intake and Normalize Through Investigation/);
  assert.match(workOnSpec, /body quality is never an admission gate/);
  assert.doesNotMatch(workOnSpec, /APPEND_TEXT=/);
  assert.doesNotMatch(workOnSpec, /Issue body normalized/);
  assert.match(reviewSkill, /preserve it unchanged/);
  assert.match(stagingSkill, /Preserve a deduplicated legacy issue unchanged/);
  assert.doesNotMatch(reviewSkill, /must be repaired/);
  assert.doesNotMatch(stagingSkill, /malformed reused issue/);
  for (const contract of [issueSkill, reviewSkill, stagingSkill, coordinator, adapter]) {
    const normalized = contract.replace(/\s+/g, " ");
    assert.match(normalized, /forgedock-issue/);
    assert.match(normalized, /Problem/);
    assert.match(normalized, /Root Cause/);
    assert.match(normalized, /Affected Files/);
    assert.match(normalized, /Expected Behavior/);
    assert.match(normalized, /Acceptance Criteria/);
  }
  assert.match(issueSkill, /not an admission gate/);
  assert.match(coordinator, /Imperfect user or\s+legacy issues remain valid intake/);
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
  assert.match(agent, /blocker closure matrix/);
  assert.match(agent, /failing-before\/passing-after regression command/);
  assert.match(agent, /Same-head edit\/test\/replan iterations remain within one remediation round/);
  assert.match(agent, /fresh current-head\s+review no longer\s+returns that occurrence/);
  assert.match(agent, /persisted same-lifecycle continuation/);
  assert.match(agent, /packed-package\s+checks serial but mandatory/);
  assert.match(agent, /FORGE:REINVESTIGATE_REQUIRED/);
  assert.match(agent, /Never reset the managed worktree/);
  assert.doesNotMatch(agent, /maxSubagentDepth: 1/);
});

test("fresh builder receives the durable build handoff before mutation", async () => {
  const builder = await readFile("agents/forgedock-builder.md", "utf8");
  const coordinator = await readFile("agents/forgedock-work-on-coordinator.md", "utf8");
  const workOn = await readFile("skills/forgedock-work-on/SKILL.md", "utf8");
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  const build = await readFile("specs/original/commands/work-on/build.md", "utf8");
  const implement = await readFile(
    "specs/original/commands/work-on/build/implement.md",
    "utf8",
  );
  const validate = await readFile(
    "specs/original/commands/work-on/build/validate.md",
    "utf8",
  );

  assert.match(builder, /name: forgedock-builder/);
  assert.match(builder, /defaultContext: fresh/);
  assert.match(builder, /tools: read, grep, find, ls, bash, edit, write/);
  assert.doesNotMatch(builder, /tools:.*\bsubagent\b/);
  assert.match(builder, /first repository read must be `specs\/original\/commands\/work-on\/build\.md`/);
  assert.match(builder, /latest completed `FORGE:INVESTIGATOR`/);
  assert.match(builder, /latest `FORGE:CONTRACT`/);
  assert.match(builder, /active coordination\s+`FORGE:CLAIM`/);
  assert.match(builder, /exact `FORGE:BASE`/);
  assert.match(builder, /do not create another worktree/i);
  assert.match(builder, /Only `build\.md` Phase B6\.5 may append `FORGE:BUILDER:COMPLETE`/);
  assert.match(builder, /active public or production seam/);

  for (const contract of [coordinator, workOn, adapter]) {
    assert.match(contract, /exactly one.*`forgedock-builder`/s);
    assert.match(contract, /fresh context|context: "fresh"/i);
    assert.match(contract, /acceptance: false/);
    assert.match(contract, /same.*worktree|same cwd|authoritative issue worktree/s);
    assert.match(contract, /wait[\s\S]*(?:without\s+mutating|do not[\s\S]*mutate)/i);
    assert.match(contract, /work-on\/build\.md/);
    assert.match(contract, /B0-B2/);
    assert.match(contract, /FORGE:BUILDER:COMPLETE/);
  }
  assert.match(coordinator, /sequential siblings/);
  assert.match(adapter, /work-on coordinator → builder/);
  assert.match(adapter, /work-on coordinator → reviewers/);
  assert.match(build, /Fresh Pi builder entry contract/);
  assert.match(build, /Execution Path and Proof/);
  assert.match(build, /absent artifact is never a skip/);
  assert.match(implement, /mandatory implementation precondition/);
  assert.match(implement, /Exact contract\/claim path gate/);
  assert.doesNotMatch(implement, /If `<!-- FORGE:ARCHITECT -->` is absent.*proceed/s);
  assert.match(validate, /Do \*\*not\*\* append `<!-- FORGE:BUILDER:COMPLETE -->` here/);
  assert.match(validate, /VALIDATED_COMMIT_SHA/);
  assert.match(validate, /No whole-phase skip/);
  assert.match(validate, /Phase V4\.5: Final Contract\/Claim Path Gate/);
  assert.match(validate, /validated_commit_sha:/);
  assert.match(build, /validated_commit: \$\{VALIDATED_COMMIT_SHA\}/);
  assert.match(build, /validated_commit_sha missing from VALIDATE_RESULT/);
  assert.doesNotMatch(build, /VALIDATED_COMMIT_SHA:-\$\(git rev-parse HEAD\)/);
  assert.match(build, /TRIVIAL[\s\S]*explicit completed skip-marker path/);
  assert.match(build, /latest completed investigation/);
  assert.match(implement, /clean `HEAD` different from frozen base/);
  assert.match(implement, /IMPLEMENT_RESULT: status: ALREADY_DONE/);
  assert.match(implement, /staged\/uncommitted changes[\s\S]*status: COMPLETE/);
  assert.doesNotMatch(implement, /Deleted partial FORGE:BUILDER/);
  assert.match(implement, /only build\.md Phase B6\.5 appends the marker/);
  assert.match(implement, /Task Type\s+`Investigation`[\s\S]*skip the architecture prerequisite/);
  assert.match(build, /must contain exactly one validated_commit/);
  assert.match(build, /completed builder branch identity invalid/);
  assert.match(build, /completed builder lacks validated_commit|must contain exactly one validated_commit/);
  assert.match(build, /completed builder commit is stale/);
  assert.match(build, /Partial pre-commit build preserved; continue directly to B6/);
  assert.match(build, /rerun configured verification and the V5 ancestry audit/);
  assert.match(build, /valid FORGE:FAST_PATH complexity marker missing/);
  assert.doesNotMatch(build, /COMPLEXITY_BAND:-STANDARD/);
  assert.match(validate, /QUALITY-GATE-TIMEOUT.*mechanical `GATED` outcome/s);
  assert.doesNotMatch(validate, /QUALITY-GATE-TIMEOUT[\s\S]{0,500}add `needs-human`/);
  assert.match(validate, /merge-base --is-ancestor "\{FROZEN_BASE_SHA\}" HEAD/);
  assert.match(validate, /ancestry audit failed/);
  assert.doesNotMatch(validate, /ANCESTRY_FAILED[\s\S]{0,300}--add-label "needs-human"/);
  assert.doesNotMatch(implement, /contract is wrong[\s\S]{0,300}add label `needs-human`/);
  for (const outputContract of [build, implement]) assert.match(outputContract, /GATED/);
  for (const routeContract of [builder, coordinator, workOn, adapter, build]) {
    assert.match(routeContract, /Task Type.*`Investigation`|Task Type is\s+`Investigation`|Task Type of `Investigation`/s);
    assert.match(routeContract, /Feature \(UI\/UX\)|UI\/full-stack|UI\/Full-Stack/);
  }
  assert.ok(build.indexOf("FORGE:ACCEPTANCE_GATE:PASSED") < build.indexOf("validated_commit: ${VALIDATED_COMMIT_SHA}"));
});

test("investigation acceptance checks preserve source cardinality and E2E behavior", async () => {
  const investigate = await readFile(
    "specs/original/commands/work-on/investigate.md",
    "utf8",
  );
  const build = await readFile("specs/original/commands/work-on/build.md", "utf8");

  assert.match(investigate, /emit exactly one machine-checkable check line/);
  assert.match(investigate, /counts and expected IDs match/);
  assert.match(build, /require exactly the same number/);
  for (const contract of [investigate, build]) {
    assert.match(contract, /ac-1\.\.ac-N/);
    assert.match(contract, /\[type:e2e\]/);
    assert.match(contract, /active\s+public\/production seam/);
    assert.match(contract, /direct imports?.*leaf helper|leaf-helper import/);
    assert.match(contract, /broad (?:test )?suite/);
  }
  assert.match(build, /FORGE:ACCEPTANCE_GATE:FAILED/);
  assert.ok([...build.matchAll(/--paginate/g)].length >= 3);
  assert.match(build, /latest completed investigation missing/);
  assert.match(build, /INVESTIGATION:COMPLETE/);
  assert.match(build, /\| last \| \.body/);
  assert.match(build, /only build path that\s+may append `FORGE:BUILDER:COMPLETE`/);
});

test("production seam ownership blocks test-only behavior before mutation", async () => {
  const contracts = await Promise.all(
    [
      "specs/original/commands/work-on/investigate.md",
      "specs/original/commands/work-on/build.md",
      "specs/original/commands/work-on/build/architect.md",
      "specs/original/commands/work-on/build/implement.md",
      "agents/forgedock-builder.md",
      "skills/forgedock-work-on/SKILL.md",
      "specs/pi-adapter.md",
    ].map((path) => readFile(path, "utf8")),
  );

  for (const contract of contracts) {
    assert.match(contract, /Production (?:Execution Seam|Seam Ownership)|production (?:execution seam|caller\/adapter)|production entrypoint[\s\S]{0,120}caller\/adapter/i);
    assert.match(contract, /test-local (?:fixture|helper)|fixture\/mock|fixtures?, mocks?/i);
    assert.match(contract, /production (?:owner|caller|entrypoint)/i);
  }
  const investigate = contracts[0]!;
  const build = contracts[1]!;
  const architect = contracts[2]!;
  const implement = contracts[3]!;
  const builder = contracts[4]!;
  const workOn = contracts[5]!;
  assert.match(investigate, /unresolved or read-only owner[\s\S]*blocks `INVESTIGATION:COMPLETE`/);
  assert.match(build, /owner that controls the requested effect cannot remain related\/read-only/);
  assert.match(architect, /do not post `FORGE:ARCHITECT:COMPLETE`/);
  assert.match(architect, /returns?\s+automated `GATED` to investigation/i);
  assert.match(implement, /Before I3, require a current `### Production Seam Ownership` section/);
  assert.match(implement, /at least one\s+non-header ownership row/);
  assert.match(implement, /before the first source mutation/);
  assert.match(implement, /resume never bypasses current ownership/);
  assert.match(investigate, /legacy completion marker[\s\S]*does not authorize build/);
  assert.match(build, /INVESTIGATION:COMPLETE[\s\S]*### Production Execution Seam/);
  assert.match(build, /FORGE:CONTRACT[\s\S]*### Production Seam Ownership/);
  assert.match(build, /--phase-role coordinator\|builder/);
  assert.match(build, /Coordinator role is allowed to create B2 artifacts/);
  assert.match(build, /Select the latest terminal investigator artifact first/);
  for (const field of ["Observable effect", "Public entrypoint", "Production owners", "Mutation coverage", "Acceptance seam"]) assert.match(build, new RegExp(field));
  assert.match(build, /Builder Contract has no production ownership data row/);
  assert.match(build, /Select the latest terminal investigator artifact first|Select the latest terminal investigator artifact/);
  assert.match(build, /Select latest artifacts before checking completion/);
  assert.match(build, /expected base SHA missing or malformed/);
  assert.match(build, /FORGE:BASE SHA missing, ambiguous, or mismatched/);
  assert.match(build, /active FORGE:CLAIM missing or incomplete/);
  assert.match(build, /claim missing deliverable/);
  assert.match(build, /ownership row is empty or placeholder/);
  assert.match(build, /ownership gate is not exactly CLOSED/);
  assert.match(build, /current architecture for resume/);
  assert.match(architect, /Select the latest architect artifact before checking completion/);
  assert.match(implement, /Select latest artifacts before checking schema\/completion/);
  assert.match(implement, /resume never bypasses current ownership/);
  assert.match(builder, /--phase-role builder/);
  assert.match(workOn, /--phase-role coordinator/);
  assert.match(workOn, /--phase-role builder/);
  assert.match(architect, /Every complexity band, including TRIVIAL/);
  assert.match(architect, /ownership-bearing Skip Marker/);
  assert.doesNotMatch(architect, /TRIVIAL[^\n]*skip all phases/);
  assert.match(architect, /legacy\/empty completion artifacts are insufficient/i);
});

test("production ownership artifact rules reject stale and placeholder authority", () => {
  const latest = (comments: string[], marker: string): string =>
    comments.filter((body) => body.includes(marker)).at(-1) ?? "";
  const substantiveInvestigation = (body: string): boolean =>
    [
      "### Production Execution Seam",
      "**Observable effect**:",
      "**Public entrypoint**:",
      "**Production owners**:",
      "**Mutation coverage**:",
      "**Acceptance seam**:",
    ].every((field) => {
      const line = body.split("\n").find((candidate) => candidate.startsWith(field));
      const value = line?.slice(line.indexOf(":") + 1).trim() ?? "";
      return value.length > 0 && !/^(?:\{.*\}|tbd|todo|unknown|none|n\/a|placeholder)$/i.test(value);
    });
  const closedOwnership = (body: string): boolean => {
    const section = body.split("### Production Seam Ownership")[1]?.split("\n### ")[0] ?? "";
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("|") && !/Observable Effect|^\|[- ]+\|/.test(line));
    return (
      body.includes("**Ownership gate**: CLOSED") &&
      rows.length > 0 &&
      rows.every((row) => !/\{[^}]*\}|\b(?:TBD|TODO|UNKNOWN|PLACEHOLDER)\b|\|\s*\|/i.test(row))
    );
  };

  const oldValid = "<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->\n### Production Execution Seam\n**Observable effect**: publish review\n**Public entrypoint**: src/api.ts:run\n**Production owners**: src/adapter.ts:publish\n**Mutation coverage**: both deliverables\n**Acceptance seam**: public command";
  const newerLegacy = "<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->";
  assert.equal(latest([oldValid, newerLegacy], "FORGE:INVESTIGATOR"), newerLegacy);
  assert.equal(substantiveInvestigation(newerLegacy), false);
  assert.equal(substantiveInvestigation(oldValid), true);

  const placeholderRow = "### Production Seam Ownership\n| Observable Effect | Public Entrypoint | Production Owner | Mutation | Test |\n|---|---|---|---|---|\n| {EFFECT} |  | TBD | {PROOF} | test |\n**Ownership gate**: OPEN";
  const closedRow = "### Production Seam Ownership\n| Observable Effect | Public Entrypoint | Production Owner | Mutation | Test |\n|---|---|---|---|---|\n| publish review | cli:run | src/api.ts:run | change adapter | e2e |\n**Ownership gate**: CLOSED";
  assert.equal(closedOwnership(placeholderRow), false);
  assert.equal(closedOwnership(closedRow), true);
});

test("pre-build proof stays builder-owned, singular, and executable", async () => {
  const [investigate, build, architect, implement, builder, workOn] = await Promise.all(
    [
      "specs/original/commands/work-on/investigate.md",
      "specs/original/commands/work-on/build.md",
      "specs/original/commands/work-on/build/architect.md",
      "specs/original/commands/work-on/build/implement.md",
      "agents/forgedock-builder.md",
      "skills/forgedock-work-on/SKILL.md",
    ].map((path) => readFile(path, "utf8")),
  );

  const contractSection = build!.split("## Phase B2: Post Builder Contract")[1]?.split("### B2.1:")[0] ?? "";
  assert.match(investigate!, /Irreversible\/provider side effect/);
  assert.match(investigate!, /### Provider Operations/);
  assert.doesNotMatch(investigate!, /### Provider Transaction Proof/);
  assert.match(investigate!, /Bounded confirmed-intake path/);
  assert.match(investigate!, /within five minutes/);
  assert.doesNotMatch(contractSection, /### Provider Transaction Proof/);
  assert.match(contractSection, /fresh builder[\s\S]*architecture before mutation/i);

  assert.match(architect!, /### Provider Transaction Proof/);
  assert.match(architect!, /Replay \/ Recovery Failure Scenario/);
  assert.match(architect!, /Exact Executable Command/);
  assert.match(architect!, /Risk[\s\S]*Severity[\s\S]*Concrete Failure Scenario[\s\S]*Exact Verification Command/);
  assert.doesNotMatch(architect!, /### HIGH-Risk Verification/);
  assert.doesNotMatch(architect!, /base-sha-A|reviewer receipts → apply findings/);

  assert.match(implement!, /run every exact command/i);
  assert.match(implement!, /Architecture Verification Results/);
  assert.match(implement!, /Exact Command[\s\S]*Outcome/);
  assert.doesNotMatch(implement!, /RISK_COUNT|PROOF_COUNT|HIGH-risk gate/);
  assert.match(builder!, /only Provider Transaction Proof/i);
  assert.match(builder!, /command plus passing outcome/i);
  assert.match(workOn!, /coordinator must\s+not generate architecture, provider proof, or risk matrices before fresh builder launch/i);
  assert.match(workOn!, /exactly one builder-owned Provider Transaction Proof/i);
  assert.doesNotMatch(workOn!, /HIGH-risk verification row|before builder launch,[\s\S]*Provider Transaction Proof/i);
});

test("headless orchestrate waits two hours on its exact async workflow", async () => {
  const orchestrate = await readFile("skills/forgedock-orchestrate/SKILL.md", "utf8");
  const adapter = await readFile("specs/pi-adapter.md", "utf8");

  for (const contract of [orchestrate, adapter]) {
    assert.match(contract, /exactly one top-level.*async|exactly one top-level asynchronous/s);
    assert.match(contract, /subagent_wait/);
    assert.match(contract, /timeoutMs: 7200000/);
    assert.match(contract, /stopOnAttention: false/);
    assert.match(contract, /1,800,000 ms|30-minute/);
    assert.match(contract, /coordination cleanup/);
  }
  assert.match(orchestrate, /exact returned workflow\s+run ID/);
  assert.match(adapter, /exact workflow run ID/);
});

test("orchestrated work-on keeps review coordination in the issue coordinator", async () => {
  const orchestrate = await readFile("skills/forgedock-orchestrate/SKILL.md", "utf8");
  const workOn = await readFile("skills/forgedock-work-on/SKILL.md", "utf8");
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  const coordinator = await readFile(
    "agents/forgedock-work-on-coordinator.md",
    "utf8",
  );
  const remediate = await readFile(
    "specs/original/commands/work-on/remediate.md",
    "utf8",
  );
  const forgeYaml = await readFile("forge.yaml", "utf8");

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
  assert.match(workOn, /blocker closure\s+matrix/);
  assert.match(workOn, /failing-before\/passing-after regression command/);
  assert.match(workOn, /Do not publish a new remediation head.*every closure row\s+passes locally/s);
  assert.match(workOn, /Only fresh current-head review can close findings|fresh\s+current-head\s+review no longer returns its occurrence/);
  assert.match(workOn, /background mechanism durably persists the same-lifecycle continuation/);
  assert.match(workOn, /packed-package checks must run separately and serially and remain mandatory/);
  assert.match(workOn, /authority and all\s+preconditions before the action/);
  assert.match(workOn, /FORGE:REINVESTIGATE_REQUIRED/);
  assert.match(workOn, /Never reset, checkout, or rebase the harness-managed worktree/);
  assert.match(workOn, /Do not spawn a second\s+review coordinator/s);
  const review = await readFile("skills/forgedock-review-pr/SKILL.md", "utf8");
  assert.match(review, /direct Git structural gate/);
  assert.doesNotMatch(review, /forgedock_(?:github|preflight)|forge_(?:prepare|verify|push)_lane/);
  assert.match(review, /defects introduced or made reachable by the frozen patch/);
  assert.match(review, /timeoutMs: 3600000/);
  assert.match(review, /stopOnAttention: false/);
  assert.match(review, /not `needs-human`/);
  assert.match(adapter, /visible orchestrator → work-on coordinator → builder/);
  assert.match(adapter, /visible orchestrator → work-on coordinator → reviewers/);
  assert.match(adapter, /inherit the launch checkout's HEAD/);
  assert.match(adapter, /control\.needsAttentionAfterMs/);
  assert.match(adapter, /specs\/original\/SHA256SUMS/);
  assert.match(adapter, /blocker closure\s+matrix/);
  assert.match(adapter, /Local\s+same-head(?: edit\/test\/replan)? iterations do\s+not consume another\s+round/);
  assert.match(adapter, /persisted\s+same-lifecycle continuation/);
  assert.match(adapter, /Packed-package smoke checks must run separately and serially and stay mandatory/);
  assert.match(adapter, /FORGE:REINVESTIGATE_REQUIRED/);
  assert.match(adapter, /Use direct `gh` and `git` commands/);
  assert.match(remediate, /Inline current-head blocker remediation \(authoritative override\)/);
  assert.match(remediate, /blocker closure matrix/);
  assert.match(remediate, /Failing-before proof/);
  assert.match(remediate, /Do not close review-finding issues in this phase/);
  assert.match(remediate, /Only publishing one substantive new head.*consumes the round/s);
  assert.match(remediate, /automatically wakes that coordinator on every terminal state/);
  assert.match(remediate, /must run in a separate bounded serial\s+step/);
  assert.match(remediate, /all authority and preconditions before the side effect/);
  assert.match(remediate, /idempotent replay\/reconciliation after provider success/);
  assert.match(remediate, /FORGE:REINVESTIGATE_REQUIRED pr=/);
  assert.match(remediate, /FORGE:REMEDIATION:COMPLETE pr=.*REMEDIATION_ROUND/s);
  assert.match(remediate, /Skill\(skill="work-on\/investigate"/);
  assert.match(remediate, /--match-head-commit "\$POST_REVIEW_HEAD"/);
  assert.match(remediate, /FORGE:REMEDIATION_MERGE_RECEIPT/);
  assert.match(remediate, /PR_ALREADY_MERGED/);
  assert.match(remediate, /Require issue-close, trajectory, and cleanup read-back/);
  assert.match(forgeYaml, /remediation_max_rounds:\s*4/);
  for (const contract of [workOn, coordinator, adapter, remediate]) {
    assert.match(contract, /--inline-review-blockers/);
    assert.match(contract, /--reviewed-head/);
    assert.match(contract, /--round/);
    assert.match(contract, /review\.remediation_max_rounds/);
  }
  assert.match(remediate, /Legacy standalone mode:[\s\S]*needs-human/);
  assert.match(remediate, /Inline mode:[\s\S]*workflow:in-review/);
  assert.match(remediate, /INLINE_REMEDIATION=false/);
  assert.match(remediate, /REPOSITORY_ROOT=\$\(git rev-parse --show-toplevel\)/);
  assert.match(remediate, /CONFIG_FILE="\$REPOSITORY_ROOT\/forge\.yaml"/);
  assert.match(remediate, /import YAML from "yaml"/);
  assert.match(remediate, /STAGING_BRANCH=\$\(echo "\$CONFIG_VALUES"/);
  assert.match(remediate, /MAX_REMEDIATION_ROUNDS=\$\(echo "\$CONFIG_VALUES"/);
  assert.doesNotMatch(remediate, /FORGE_CONFIG/);
  assert.match(remediate, /TARGET_REVIEWED_HEAD="\$REVIEWED_HEAD"/);
  assert.match(remediate, /TARGET_REVIEWED_HEAD="\$CURRENT_PR_HEAD"/);
  assert.match(remediate, /FORGE:REMEDIATION_BINDING finding=.* head=\{TARGET_REVIEWED_HEAD\}/);
  assert.equal(
    [...remediate.matchAll(/gh api repos\/\{GH_REPO\}\/issues\/\{(?:PR_NUMBER|ISSUE_NUMBER)\}\/comments \\\n  \| jq --arg marker/g)].length,
    2,
  );
  assert.doesNotMatch(remediate, /gh api[^\n]*--jq --arg/);
  assert.match(remediate, /PARTIAL_PR_COMMENT_ID=.*\.id \/\/ empty/);
  assert.match(remediate, /PARTIAL_ISSUE_COMMENT_ID=.*\.id \/\/ empty/);
  assert.match(remediate, /issues\/comments\/\$PARTIAL_PR_COMMENT_ID -X DELETE/);
  assert.match(remediate, /issues\/comments\/\$PARTIAL_ISSUE_COMMENT_ID -X DELETE/);
  assert.equal(
    [...remediate.matchAll(/--body "\$\{START_MARKER\}/g)].length,
    2,
  );
  assert.match(remediate, /POST_REVIEW_HEAD=\$\(gh pr view/);
  assert.match(remediate, /COMPLETE_MARKER="<!-- FORGE:REMEDIATION:COMPLETE pr=/);
  assert.match(remediate, /COMPLETION_TRAILER=""/);
  assert.match(remediate, /COMPLETION_TRAILER="<!-- FORGE:REMEDIATION:COMPLETE -->"/);
  assert.match(remediate, /INLINE_COMPLETED_TUPLES=/);
  assert.match(remediate, /EXPECTED_REMEDIATION_ROUND=\$\(\(MAX_COMPLETED_ROUND \+ 1\)\)/);
  assert.match(remediate, /ALREADY_DONE/);
  assert.match(remediate, /round cap exhausted before mutation/);
  assert.match(remediate, /checkout, quality-gate, push, provider, or publication failures produce automated `GATED`\/`review-degraded`/);
  assert.doesNotMatch(remediate, /post a comment, add `needs-human`/);
  assert.match(remediate, /fresh deterministic code blockers remain `workflow:in-review`/);
  assert.match(remediate, /unknown branch name.*fail closed as deploy-gate\/hold/s);
  assert.match(remediate, /\[ \"\$LIVE_BASE_REF\" = \"\$STAGING_BRANCH\" \]/);
  assert.match(remediate, /\[\[ \"\$LIVE_BASE_REF\" == milestone\/\* \]\]/);
  const idempotencyOrder = [
    "INLINE_COMPLETED_TUPLES=",
    "EXPECTED_REMEDIATION_ROUND=",
    "## Phase M1: Load Prior Findings",
  ].map((needle) => remediate.indexOf(needle));
  assert.ok(idempotencyOrder.every((index) => index >= 0));
  assert.deepEqual(idempotencyOrder, idempotencyOrder.toSorted((a, b) => a - b));
  const remediationOrder = [
    "FORGE:REMEDIATION_PLAN",
    "Before Phase M4",
    "## Phase M4: Commit, Push",
    "## Phase M6: Re-Invoke /review-pr",
  ].map((needle) => remediate.indexOf(needle));
  assert.ok(remediationOrder.every((index) => index >= 0));
  assert.deepEqual(remediationOrder, remediationOrder.toSorted((a, b) => a - b));
  assert.ok(remediate.indexOf("## Phase M6: Re-Invoke /review-pr") < remediate.indexOf("POST_REVIEW_HEAD=$(gh pr view"));
  assert.ok(remediate.indexOf("## Phase M6: Re-Invoke /review-pr") < remediate.indexOf("After Phase M6"));
  assert.doesNotMatch(adapter, /forgedock_(?:github|preflight)|forge_(?:prepare|verify|push)_lane/);
  const entrypoint = await readFile("src/index.ts", "utf8");
  assert.match(entrypoint, /registerForgePromptRouter\(pi\)/);
  assert.doesNotMatch(entrypoint, /registerForgeRuntimeTools|registerForgeWorktreeContainment/);
  assert.doesNotMatch(
    adapter,
    /Load the `forgedock-review-pr` skill in a fresh subagent when invoked from work-on/,
  );
});

test("packaged review contracts require guarded official publication", async () => {
  const review = await readFile("skills/forgedock-review-pr/SKILL.md", "utf8");
  const workOn = await readFile("skills/forgedock-work-on/SKILL.md", "utf8");
  const adapter = await readFile("specs/pi-adapter.md", "utf8");
  const protocol = await readFile("specs/qualitative-review-protocol.md", "utf8");
  for (const document of [review, workOn, adapter, protocol]) {
    assert.match(document, /official review publication/i);
    assert.match(document, /COMMENT/);
    assert.match(document, /merge-base/);
    assert.match(document, /GATED/);
  }
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
