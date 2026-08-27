import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import {
  FORGE_PHASE_ARTIFACT_SCHEMA,
  isPhaseArtifact,
  phaseArtifactValidationError,
  renderPhaseArtifact,
  type InvestigationArtifact,
  type PlanArtifact,
} from "../../src/core/comment-contract.ts";

const investigation: InvestigationArtifact = {
  schema: "forgedock.phase-artifact/v1",
  phase: "investigate",
  verdict: "confirmed",
  confidence: "high",
  severity: "low",
  taskType: "focused unit test",
  complexity: "trivial",
  claimed: "The integration auto-merge gate lacks regression coverage.",
  observed: "The implementation exists and the focused test is absent.",
  rootCause: "An existing branch was not covered by the test matrix.",
  affectedFiles: [
    { path: "test/core/review.test.ts", reason: "Missing focused assertion" },
  ],
  evidence: ["evaluateReviewGate already returns needs-human"],
  history: ["The adjacent protected-branch test establishes the style."],
  recommendation: "Add one test without changing production code.",
  relatedIssues: [],
  decomposition: { required: false, reason: "One test and one concern." },
  skippedPhases: [
    { phase: "architecture", reason: "No production design change." },
  ],
  acceptanceChecks: [
    {
      id: "AC-1",
      description: "Decision is needs-human",
      status: "pending",
      evidence: [],
    },
  ],
};

const plan: PlanArtifact = {
  schema: "forgedock.phase-artifact/v1",
  phase: "plan",
  objective: "Add one regression test.",
  allowedPaths: ["test/core/review.test.ts"],
  forbiddenChanges: ["Production source"],
  invariants: ["Existing gate behavior remains unchanged"],
  deliverables: ["One focused test"],
  acceptanceMapping: [
    { checkId: "AC-1", implementation: "Assert needs-human." },
  ],
  context: {
    history: ["Adjacent coverage exists."],
    callersAndDataFlow: ["Test invokes evaluateReviewGate directly."],
    ciSurface: ["npm run check"],
    priorFindings: ["None."],
    hazards: ["Do not alter fixtures globally."],
  },
  steps: [{ order: 1, action: "Add the assertion.", checkIds: ["AC-1"] }],
  outOfScope: ["Production changes"],
};

test("phase output schema and trusted validator accept every advertised phase", () => {
  const artifacts = [
    {
      schema: "forgedock.phase-artifact/v1",
      phase: "resolve",
      issueNumber: 1,
      title: "Issue",
      eligible: true,
      baseBranch: "staging",
      evidence: [],
    },
    investigation,
    plan,
    {
      schema: "forgedock.phase-artifact/v1",
      phase: "prepare-worktree",
      branch: "forge/1",
      baseBranch: "staging",
      baseSha: "abcdef1",
      worktree: "/tmp/worktree",
    },
    {
      schema: "forgedock.phase-artifact/v1",
      phase: "implement",
      branch: "forge/1",
      baseSha: "abcdef1",
      commitSha: "bcdefa2",
      changedFiles: [
        { path: "src/a.ts", additions: 1, deletions: 0, change: "added" },
      ],
      acceptanceChecks: investigation.acceptanceChecks,
      checksRun: [{ name: "test", status: "passed", evidence: "ok" }],
    },
    {
      schema: "forgedock.phase-artifact/v1",
      phase: "verify",
      headSha: "bcdefa2",
      checks: [
        { name: "test", required: true, status: "passed", evidence: "ok" },
      ],
      readiness: "ready-for-ci",
      reason: "passed",
    },
    {
      schema: "forgedock.phase-artifact/v1",
      phase: "prepare-pr",
      pullNumber: 1,
      baseBranch: "staging",
      headSha: "bcdefa2",
      reviewRound: 1,
      domains: ["correctness", "security"],
    },
  ];
  for (const artifact of artifacts) {
    assert.equal(
      Check(FORGE_PHASE_ARTIFACT_SCHEMA, artifact),
      true,
      String(artifact.phase),
    );
    assert.equal(isPhaseArtifact(artifact), true, String(artifact.phase));
  }
});

test("resolve schema rejects investigation-only fields with a field diagnostic", () => {
  const invalid = {
    schema: "forgedock.phase-artifact/v1",
    phase: "resolve",
    claimed: "investigation-shaped",
    evidence: ["evidence"],
  };
  assert.equal(Check(FORGE_PHASE_ARTIFACT_SCHEMA, invalid), false);
  assert.equal(isPhaseArtifact(invalid), false);
  assert.match(
    phaseArtifactValidationError(invalid),
    /issueNumber, title, eligible, baseBranch/,
  );
});

test("typed phase artifacts reject marker-only Markdown substitutes", () => {
  assert.equal(isPhaseArtifact(investigation), true);
  assert.equal(
    isPhaseArtifact({
      schema: "forgedock.phase-artifact/v1",
      phase: "investigate",
      evidence: ["marker only"],
    }),
    false,
  );
});

test("investigation rendering is deterministic and never invents routing", () => {
  const first = renderPhaseArtifact(investigation);
  const second = renderPhaseArtifact(structuredClone(investigation));
  assert.equal(first, second);
  assert.match(first, /Task type \| focused unit test/);
  assert.match(first, /Complexity \| TRIVIAL/);
  assert.match(first, /architecture: skipped — No production design change/);
  assert.match(first, /<!-- FORGE:FAST_PATH -->/);
  assert.doesNotMatch(first, /Legacy Routing Classification|NOT RECORDED/);
  assert.doesNotMatch(first, /Bug Fix|STANDARD/);
});

test("plan rendering deterministically separates contract, context, and architecture", () => {
  const markdown = renderPhaseArtifact(plan);
  assert.match(markdown, /<!-- FORGE:CONTRACT -->/);
  assert.match(markdown, /<!-- FORGE:CONTEXT -->/);
  assert.match(markdown, /<!-- FORGE:ARCHITECT -->/);
  assert.match(markdown, /test\/core\/review\.test\.ts/);
  assert.match(markdown, /Assert needs-human/);
});
