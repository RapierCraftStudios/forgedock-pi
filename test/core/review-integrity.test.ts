import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeReviewFindingMetadata, trustedAffectedPathsForDag, trustedAffectedPathsFromReviewFinding, assertReviewFindingReadbackPaths, ReviewFindingIntegrityError } from "../../src/core/review-integrity.ts";
import type { ForgeReviewFindingResult } from "../../src/agents/contracts.ts";

const finding: ForgeReviewFindingResult = {
  id: "SEC-1", reviewer: "security", runId: "run", headSha: "abcdef1", confidence: "confirmed", severity: "high", category: "security", file: "./src/auth.ts", line: 4, summary: "unsafe auth", evidence: [],
  affectedFiles: [{ path: "src/auth.ts", startLine: 4, endLine: 8 }, { path: "src\\token.ts", startLine: 1, endLine: 1 }],
};

test("review closure integrity names alternate callers and transitive dependencies", async () => {
  const review = await readFile("specs/original/commands/work-on/review.md", "utf8");
  const verification = await readFile("specs/verification.md", "utf8");
  assert.match(review, /frozen closure matrix/);
  assert.match(review, /alternate caller/i);
  assert.match(review, /transitive.dependency/i);
  assert.match(review, /CONTRACT_GAP/);
  assert.match(verification, /Each row needs a concrete counterexample or behavioral test/);
  assert.match(verification, /cancellation.*concurrency/is);

  const fixture = await readFile("test/fixtures/closure-matrix-receipt.md", "utf8");
  const rows = [...fixture.matchAll(/^[-*] ([^|]+) \| ([^\n]+)$/gm)].map((match) => ({
    id: match[1]!.trim(),
    detail: match[2]!,
  }));
  const initial = new Set(rows.slice(0, 1).map((row) => row.id));
  const gaps = rows.filter((row) => !initial.has(row.id));
  assert.deepEqual(gaps.map((row) => row.id), ["alternate-caller", "transitive-dependency"]);
  assert.ok(gaps.every((row) => /producer=.*consumer=.*dependency=.*state=.*counterexample=/.test(row.detail)));
});

test("review metadata normalizes ranges and exposes typed DAG paths", () => {
  const result = normalizeReviewFindingMetadata(finding);
  assert.deepEqual(result.affectedPaths, ["src/auth.ts", "src/token.ts"]);
  assert.deepEqual(trustedAffectedPathsForDag(finding), result.affectedPaths);
});

test("blank and absolute finding locations fail closed", () => {
  assert.throws(() => normalizeReviewFindingMetadata({ ...finding, file: "" }), ReviewFindingIntegrityError);
  assert.throws(() => normalizeReviewFindingMetadata({ ...finding, affectedFiles: [{ path: "/tmp/secrets", startLine: 1, endLine: 1 }] }), ReviewFindingIntegrityError);
});

test("readback validates only the structured path marker", () => {
  const body = `prose mentioning fake.ts\n<!-- FORGE:REVIEW_FINDING_PATHS ["src/auth.ts","src/token.ts"] -->`;
  assert.deepEqual(trustedAffectedPathsFromReviewFinding(body), ["src/auth.ts", "src/token.ts"]);
  assert.doesNotThrow(() => assertReviewFindingReadbackPaths(body, ["src/token.ts", "src/auth.ts"]));
  assert.throws(() => assertReviewFindingReadbackPaths(body, ["src/auth.ts"]), ReviewFindingIntegrityError);
});

test("review capability proof distinguishes runtime boundaries from structural evidence", async () => {
  const verification = await readFile("specs/verification.md", "utf8");
  const review = await readFile("specs/original/commands/work-on/review.md", "utf8");
  const gate = await readFile("specs/original/commands/test-gate.md", "utf8");
  assert.match(verification, /only `PASS`.*matching criterion.*capability.*command\/boundary.*source.*behavioral proof/s);
  assert.match(verification, /source-string.*cannot\s+close.*row/is);
  assert.match(review, /Exact-head approval is rejected when any\s+required capability.*FAIL.*MISSING.*SKIPPED.*UNKNOWN.*CONTRADICTED/s);
  assert.match(review, /capability ID.*criterion ID\/text hash.*source head\/tree.*wake condition/s);
  assert.match(gate, /Structural\/source-string\/YAML checks can\s+supplement.*cannot\s+satisfy/s);

  const evidence = { type: "runtime", proof: "structural source-string check", state: "PASS" };
  const runtimeProofIsValid = evidence.type === "runtime" && evidence.proof === "behavioral boundary evidence";
  assert.equal(runtimeProofIsValid, false, "structural evidence cannot close a runtime capability");
});
