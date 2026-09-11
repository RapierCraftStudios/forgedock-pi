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
  coverage: {
    productionPath: [
      "review request entrypoint",
      "evaluateReviewGate",
      "needs-human decision observable",
    ],
    boundaries: [
      {
        producer: "review request handler",
        consumer: "evaluateReviewGate",
        invocation: "unapproved merge request",
        evidence: "src/core/review.ts calls the gate",
      },
    ],
    mutationScope: [
      {
        path: "test/core/review.test.ts",
        disposition: "change",
        reason: "Add the missing behavioral assertion.",
        evidence: "Existing test file owns the gate coverage.",
      },
    ],
  },
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
    {
      checkId: "AC-1",
      implementation: {
        proofKind: "behavioral",
        mechanism: "evaluateReviewGate",
        boundary: "protected-branch review gate",
        test: "test/core/review.test.ts",
        trigger: "unapproved merge request",
        assertion: "returns needs-human",
        baseline: "fails before the regression test exists",
        passAfter: "passes after the regression test is added",
        prerequisite: "npm test",
        residualRisk: "none",
      },
    },
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

test("investigation admission requires path, boundary, and mutation coverage", () => {
  const missingCoverage = structuredClone(investigation) as unknown as Record<string, unknown>;
  delete missingCoverage.coverage;
  assert.equal(Check(FORGE_PHASE_ARTIFACT_SCHEMA, missingCoverage), false);
  assert.equal(isPhaseArtifact(missingCoverage), false);

  const missingPath = structuredClone(investigation);
  missingPath.coverage.productionPath = [];
  assert.equal(Check(FORGE_PHASE_ARTIFACT_SCHEMA, missingPath), false);
  assert.equal(isPhaseArtifact(missingPath), false);

  const genericCoverage = structuredClone(investigation);
  genericCoverage.coverage.productionPath = ["entrypoint", "observable result"];
  assert.equal(Check(FORGE_PHASE_ARTIFACT_SCHEMA, genericCoverage), true);
  assert.equal(isPhaseArtifact(genericCoverage), false);

  const missingBoundary = structuredClone(investigation);
  missingBoundary.coverage.boundaries = [];
  assert.equal(Check(FORGE_PHASE_ARTIFACT_SCHEMA, missingBoundary), false);
  assert.equal(isPhaseArtifact(missingBoundary), false);

  const missingMutationScope = structuredClone(investigation);
  missingMutationScope.coverage.mutationScope = [];
  assert.equal(Check(FORGE_PHASE_ARTIFACT_SCHEMA, missingMutationScope), false);
  assert.equal(isPhaseArtifact(missingMutationScope), false);
});

test("investigation rendering is deterministic and never invents routing", () => {
  const first = renderPhaseArtifact(investigation);
  const second = renderPhaseArtifact(structuredClone(investigation));
  assert.equal(first, second);
  assert.match(first, /Task type \| focused unit test/);
  assert.match(first, /Complexity \| TRIVIAL/);
  assert.match(first, /### Production Path/);
  assert.match(first, /### Producer\/Consumer Boundaries/);
  assert.match(first, /### Required Mutation Scope/);
  assert.match(first, /architecture: skipped — No production design change/);
  assert.match(first, /<!-- FORGE:FAST_PATH -->/);
  assert.doesNotMatch(first, /Legacy Routing Classification|NOT RECORDED/);
  assert.doesNotMatch(first, /Bug Fix|STANDARD/);
});

test("plan rendering makes the builder contract a minimal deterministic behavior handoff", () => {
  const markdown = renderPhaseArtifact(plan);
  const contract = markdown.slice(
    markdown.indexOf("<!-- FORGE:CONTRACT -->"),
    markdown.indexOf("<!-- FORGE:CONTEXT -->"),
  );
  assert.match(contract, /### Observable Outcome/);
  assert.match(contract, /### In-Scope Behavior and Files/);
  assert.match(contract, /\*\*Behavior\*\*/);
  assert.match(contract, /\*\*Files\*\*/);
  assert.match(contract, /### Non-Goals/);
  assert.match(contract, /### Smallest Behavioral Proof/);
  assert.deepEqual(
    [...contract.matchAll(/^### (.+)$/gm)].map((match) => match[1]),
    [
      "Observable Outcome",
      "In-Scope Behavior and Files",
      "Non-Goals",
      "Smallest Behavioral Proof",
    ],
  );
  assert.match(contract, /\| Criterion \| Smallest Proof \|/);
  assert.match(contract, /Mechanism: evaluateReviewGate/);
  assert.match(contract, /Trigger: unapproved merge request/);
  assert.match(contract, /Pass-after: passes after the regression test is added/);
  assert.match(contract, /test\/core\/review\.test\.ts/);
  assert.match(contract, /Assertion: returns needs-human/);
  for (const heading of ["Allowed Paths", "Forbidden Changes", "Acceptance Mapping", "Ownership", "Scheduling", "Worktree", "Hash", "Lineage", "Review"]) {
    assert.doesNotMatch(contract, new RegExp(`^### .*${heading}`, "im"));
  }
  assert.doesNotMatch(contract, /Ownership|Scheduling|Worktree|Hash|Lineage|Deep Review/i);
  assert.match(markdown, /<!-- FORGE:CONTEXT -->/);
  assert.match(markdown, /<!-- FORGE:ARCHITECT -->/);
});

test("plan artifacts reject an incomplete acceptance proof", () => {
  const invalid = structuredClone(plan) as unknown as Record<string, unknown>;
  invalid.acceptanceMapping = [
    { checkId: "AC-1", implementation: "Assert needs-human." },
  ];
  assert.equal(Check(FORGE_PHASE_ARTIFACT_SCHEMA, invalid), false);
  assert.equal(isPhaseArtifact(invalid), false);
});

test("invalid verdict markers are detected in comment bodies", async () => {
  const { commentBodySignalsInvalidVerdict } = await import(
    "../../src/core/comment-contract.ts"
  );
  assert.equal(
    commentBodySignalsInvalidVerdict("<!-- FORGE:INVALID -->\nClosed invalid."),
    true,
  );
  assert.equal(
    commentBodySignalsInvalidVerdict("evidence: FORGE:COMMIT:NO-CHANGE"),
    true,
  );
  assert.equal(
    commentBodySignalsInvalidVerdict("normal review comment"),
    false,
  );
});
