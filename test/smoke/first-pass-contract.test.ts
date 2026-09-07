import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = (path: string) => readFile(path, "utf8");
const phase = (name: string) => text(`specs/original/commands/work-on/${name}.md`);

// These preserve the instruction contract, not a claim of live agent compliance.
test("the happy path targets verified closure without remediation or clock resets", async () => {
  const root = await text("specs/original/commands/work-on.md");
  const skill = await text("skills/forgedock-work-on/SKILL.md");
  assert.match(root, /under 30 minutes/);
  assert.match(root, /Remediation is an exceptional fallback/);
  assert.match(root, /not.*reset.*clock.*decompos/s);
  assert.match(root, /first-pass.*review panels.*remediation/s);
  assert.match(skill, /review → \[remediate → re-review\] → merge/);
});

test("investigation independently derives a closure route before implementation", async () => {
  const investigate = await phase("investigate");
  assert.match(investigate, /intake request.*not an implementation plan or proof/s);
  assert.match(investigate, /closure pass/);
  assert.match(investigate, /actual entrypoint.*callers\/consumers/s);
  assert.match(investigate, /Derive the checks[\s\S]*rather than copying the issue/);
  assert.match(investigate, /Acceptance Contract.*closure pass/s);
  assert.match(investigate, /Closure Route/);
  assert.match(investigate, /If the path is incomplete,[\s\S]*do not complete the phase or route to `BUILD`/);
  assert.match(investigate, /GATED.*concrete external condition/s);
});

test("build writes behavioral regressions first and reconciles every acceptance claim", async () => {
  const build = await phase("build");
  assert.match(build, /Before changing production code.*failing/s);
  assert.match(build, /each acceptance criterion.*evidence/s);
  assert.match(build, /Do not request review.*known.*gap/s);
  assert.match(build, /skip.*checks.*deadline|deadline.*skip.*checks/s);
});

test("remediation is bounded across resumes and review names in every authority", async () => {
  const root = await text("specs/original/commands/work-on.md");
  const remediate = await phase("remediate");
  const review = await phase("review");
  const agent = await text("agents/forgedock-work-on-coordinator.md");
  assert.match(root, /remediation_max_rounds`, default `1`/);
  assert.match(root, /Never reset.*resume.*final.*last.*closure/s);
  assert.match(remediate, /Count.*before.*edit/s);
  assert.match(remediate, /cap.*no further.*edit.*panel/s);
  assert.match(review, /remaining\s+remediation\s+budget/);
  assert.match(agent, /remediation cap.*GATED/s);
  for (const content of [root, remediate]) {
    assert.match(content, /A round includes.*fix plus its complete scoped re-review/s);
    assert.match(content, /Complete or resume.*at the limit/s);
    assert.match(content, /bounded missing-role retries/);
  }
  assert.match(root, /authorized remediation round unfinished.*do not charge another round/);
  assert.match(agent, /Finish or resume.*even at the limit/s);
  assert.doesNotMatch(agent, /continue through review, automatic cohesive\s+remediation/);
});

test("dispatcher uses current routing and reconciles prerequisite and ownership evidence", async () => {
  const orchestrate = await text("skills/forgedock-orchestrate/SKILL.md");
  assert.match(orchestrate, /phase labels alone.*ownership/);
  assert.match(orchestrate, /Before presenting.*prerequisite.*target/s);
  assert.match(orchestrate, /archived.*phase.*routing/s);
  assert.match(orchestrate, /wall.*wait.*first-pass/s);
});
