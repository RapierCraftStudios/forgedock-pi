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
    assert.equal(typeof fixture.auditStatus, "string", name);
    assert.ok(fixture.selector && typeof fixture.selector === "object", name);
    assert.ok(fixture.identity && typeof fixture.identity === "object", name);
    const identity = fixture.identity as Record<string, unknown>;
    assert.ok(identity.runId && identity.repository && identity.request, name);
    assert.ok(Array.isArray(fixture.sources), name);
    assert.ok(Array.isArray(fixture.timeline), name);
    assert.ok(fixture.evidenceGraph && typeof fixture.evidenceGraph === "object", name);
    const graph = fixture.evidenceGraph as { edges?: Array<Record<string, unknown>> };
    assert.ok(graph.edges?.every((edge) => edge.source && edge.confidence), name);
    assert.ok(Array.isArray(fixture.coverage), name);
    const coverage = fixture.coverage as Array<Record<string, unknown>>;
    assert.ok(coverage.every((row) => row.invariants && row.failureModes && row.boundaries && row.sources && row.state && row.reason && "capturedAt" in row), name);
    assert.ok(fixture.causes && typeof fixture.causes === "object", name);
    assert.ok(fixture.production && typeof fixture.production === "object", name);
    const production = fixture.production as Record<string, unknown>;
    assert.equal(production.exposure, "NOT_REQUESTED", name);
    assert.ok(Array.isArray(fixture.disagreements), name);
    assert.ok(Array.isArray(fixture.recommendations), name);
    assert.ok(Array.isArray(fixture.limitations), name);
    assert.ok(!JSON.stringify(fixture).match(/gho_|github_pat_|Bearer [A-Za-z0-9]/), name);
  }
});

test("audit output retains disagreements and required-capability limitations", async () => {
  const fixture = JSON.parse(await readFile(`${fixtureRoot}/transport-disagreement.json`, "utf8")) as {
    disagreements: string[];
    limitations: string[];
    production: { exposure: string };
  };
  assert.ok(fixture.disagreements.length > 0);
  assert.ok(fixture.limitations.some((item) => item.includes("capability")));
  assert.equal(fixture.production.exposure, "NOT_REQUESTED");
});
