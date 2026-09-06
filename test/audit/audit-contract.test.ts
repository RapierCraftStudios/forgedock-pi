import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const fixtureRoot = "test/fixtures/audit";
const requiredStates = ["PASS", "FAIL", "MISSING", "SKIPPED", "CONTRADICTED", "UNKNOWN"];

test("audit specification defines safe run selectors, proof states, and read-only boundaries", async () => {
  const spec = await readFile("specs/original/commands/audit.md", "utf8");
  for (const phrase of [
    "--run-id <id>",
    "--run-dir <absolute-directory>",
    "--anchor <artifact-id-or-URL>",
    "symlink escape",
    "never a guessed",
    "criterion",
    "invariants",
    "failureModes",
    "production.exposure",
    "UNVERIFIED",
    "never creates one",
    "never grants merge authority",
  ]) assert.match(spec, new RegExp(phrase.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")), phrase);
  for (const state of requiredStates) assert.match(spec, new RegExp(`\\b${state}\\b`), state);
  assert.doesNotMatch(spec, /audit_status|production_exposure|productionExposure/);
});

test("anonymized audit fixtures cover the terminal and disagreement matrix", async () => {
  const names = (await readdir(fixtureRoot)).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, [
    "cross-repository.json",
    "decomposed.json",
    "first-pass.json",
    "review-capped.json",
    "transport-disagreement.json",
  ]);
  for (const name of names) {
    const fixture = JSON.parse(await readFile(`${fixtureRoot}/${name}`, "utf8")) as Record<string, unknown>;
    assert.equal(fixture.schemaVersion, 1, name);
    assert.equal(typeof fixture.runId, "string", name);
    assert.equal(typeof fixture.terminal, "string", name);
    assert.ok(Array.isArray(fixture.evidence), name);
    assert.ok(Array.isArray(fixture.timeline), name);
    assert.ok(fixture.evidenceGraph && typeof fixture.evidenceGraph === "object", name);
    assert.ok(Array.isArray(fixture.coverage), name);
    assert.ok(fixture.production && typeof fixture.production === "object", name);
    assert.ok(!JSON.stringify(fixture).match(/gho_|github_pat_|Bearer [A-Za-z0-9]/), name);
  }
});

test("audit output retains disagreements and required-capability limitations", async () => {
  const fixture = JSON.parse(await readFile(`${fixtureRoot}/transport-disagreement.json`, "utf8")) as {
    disagreements: string[];
    requiredCapability: { state: string };
    production: { exposure: string };
  };
  assert.ok(fixture.disagreements.length > 0);
  assert.equal(fixture.requiredCapability.state, "SKIPPED");
  assert.equal(fixture.production.exposure, "UNVERIFIED");
});
