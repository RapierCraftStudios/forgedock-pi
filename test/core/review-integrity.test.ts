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
  assert.match(review, /alternate|caller/i);
  assert.match(review, /transitive.dependenc/i);
  assert.match(review, /CONTRACT_GAP/);
  assert.match(verification, /Each row needs a concrete counterexample or behavioral test/);

  const closure = [
    { producer: "emit", consumer: "primary-caller", dependency: "strict-verifier" },
    { producer: "emit", consumer: "alternate-caller", dependency: "versioned-verifier" },
  ];
  const initial = closure.filter((row) => row.consumer === "primary-caller");
  assert.equal(initial.length, 1);
  assert.deepEqual(closure.filter((row) => !initial.includes(row)).map((row) => row.consumer), ["alternate-caller"]);
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
