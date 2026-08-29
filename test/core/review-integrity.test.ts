import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReviewFindingMetadata, trustedAffectedPathsForDag, trustedAffectedPathsFromReviewFinding, assertReviewFindingReadbackPaths, ReviewFindingIntegrityError } from "../../src/core/review-integrity.ts";
import type { ForgeReviewFindingResult } from "../../src/agents/contracts.ts";

const finding: ForgeReviewFindingResult = {
  id: "SEC-1", reviewer: "security", runId: "run", headSha: "abcdef1", confidence: "confirmed", severity: "high", category: "security", file: "./src/auth.ts", line: 4, summary: "unsafe auth", evidence: [],
  affectedFiles: [{ path: "src/auth.ts", startLine: 4, endLine: 8 }, { path: "src\\token.ts", startLine: 1, endLine: 1 }],
};

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
