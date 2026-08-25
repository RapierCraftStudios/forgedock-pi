import assert from "node:assert/strict";
import test from "node:test";

import {
  isPhaseArtifact,
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
