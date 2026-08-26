export type PhaseArtifact =
  | ResolveArtifact
  | InvestigationArtifact
  | PlanArtifact
  | WorktreeArtifact
  | ImplementationArtifact
  | VerificationArtifact
  | PreparedReviewArtifact;

interface PhaseArtifactBase {
  schema: "forgedock.phase-artifact/v1";
  phase:
    | "resolve"
    | "investigate"
    | "plan"
    | "prepare-worktree"
    | "implement"
    | "verify"
    | "prepare-pr";
}

export interface AcceptanceCheck {
  id: string;
  description: string;
  status: "pending" | "passed" | "failed" | "not-applicable";
  evidence: string[];
}

export interface ResolveArtifact extends PhaseArtifactBase {
  phase: "resolve";
  issueNumber: number;
  title: string;
  eligible: boolean;
  baseBranch: string;
  evidence: string[];
}

export interface InvestigationArtifact extends PhaseArtifactBase {
  phase: "investigate";
  verdict: "confirmed" | "invalid" | "decompose";
  confidence: "high" | "medium" | "low";
  severity: "critical" | "high" | "medium" | "low";
  taskType: string;
  complexity: "trivial" | "standard" | "complex";
  claimed: string;
  observed: string;
  rootCause: string;
  affectedFiles: Array<{ path: string; reason: string }>;
  evidence: string[];
  history: string[];
  recommendation: string;
  relatedIssues: number[];
  decomposition: { required: boolean; reason: string };
  skippedPhases: Array<{ phase: string; reason: string }>;
  acceptanceChecks: AcceptanceCheck[];
}

export interface PlanArtifact extends PhaseArtifactBase {
  phase: "plan";
  objective: string;
  allowedPaths: string[];
  forbiddenChanges: string[];
  invariants: string[];
  deliverables: string[];
  acceptanceMapping: Array<{ checkId: string; implementation: string }>;
  context: {
    history: string[];
    callersAndDataFlow: string[];
    ciSurface: string[];
    priorFindings: string[];
    hazards: string[];
  };
  steps: Array<{ order: number; action: string; checkIds: string[] }>;
  outOfScope: string[];
}

export interface WorktreeArtifact extends PhaseArtifactBase {
  phase: "prepare-worktree";
  branch: string;
  baseBranch: string;
  baseSha: string;
  worktree: string;
}

export interface ImplementationArtifact extends PhaseArtifactBase {
  phase: "implement";
  branch: string;
  baseSha: string;
  commitSha: string;
  changedFiles: Array<{ path: string; additions: number; deletions: number; change: string }>;
  acceptanceChecks: AcceptanceCheck[];
  checksRun: Array<{ name: string; status: "passed" | "failed" | "skipped" | "not-configured"; evidence: string }>;
}

export interface VerificationArtifact extends PhaseArtifactBase {
  phase: "verify";
  headSha: string;
  checks: Array<{
    name: string;
    required: boolean;
    status:
      | "passed"
      | "failed"
      | "skipped"
      | "pending"
      | "unknown"
      | "not-configured"
      | "policy-exempt";
    evidence: string;
  }>;
  readiness: "ready-for-ci" | "blocked";
  reason: string;
}

export interface PreparedReviewArtifact extends PhaseArtifactBase {
  phase: "prepare-pr";
  pullNumber: number;
  baseBranch: string;
  headSha: string;
  reviewRound: number;
  domains: string[];
}

const schemaString = { type: "string", minLength: 1 } as const;
const schemaStrings = { type: "array", items: schemaString } as const;
const schemaNonEmptyStrings = { type: "array", minItems: 1, items: schemaString } as const;
const acceptanceCheckSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "description", "status", "evidence"],
  properties: {
    id: schemaString,
    description: schemaString,
    status: { type: "string", enum: ["pending", "passed", "failed", "not-applicable"] },
    evidence: schemaStrings,
  },
} as const;
const artifactIdentity = {
  schema: { type: "string", const: "forgedock.phase-artifact/v1" },
} as const;

/** Discriminated model-facing schema kept at least as strict as isPhaseArtifact(). */
export const FORGE_PHASE_ARTIFACT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["schema", "phase", "issueNumber", "title", "eligible", "baseBranch", "evidence"],
      properties: { ...artifactIdentity, phase: { type: "string", const: "resolve" }, issueNumber: { type: "integer", minimum: 1 }, title: schemaString, eligible: { type: "boolean" }, baseBranch: schemaString, evidence: schemaStrings },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schema", "phase", "verdict", "confidence", "severity", "taskType", "complexity", "claimed", "observed", "rootCause", "affectedFiles", "evidence", "history", "recommendation", "relatedIssues", "decomposition", "skippedPhases", "acceptanceChecks"],
      properties: {
        ...artifactIdentity,
        phase: { type: "string", const: "investigate" },
        verdict: { type: "string", enum: ["confirmed", "invalid", "decompose"] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
        taskType: schemaString,
        complexity: { type: "string", enum: ["trivial", "standard", "complex"] },
        claimed: schemaString,
        observed: schemaString,
        rootCause: schemaString,
        affectedFiles: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["path", "reason"], properties: { path: schemaString, reason: schemaString } } },
        evidence: schemaNonEmptyStrings,
        history: schemaNonEmptyStrings,
        recommendation: schemaString,
        relatedIssues: { type: "array", items: { type: "integer", minimum: 1 } },
        decomposition: { type: "object", additionalProperties: false, required: ["required", "reason"], properties: { required: { type: "boolean" }, reason: schemaString } },
        skippedPhases: { type: "array", items: { type: "object", additionalProperties: false, required: ["phase", "reason"], properties: { phase: schemaString, reason: schemaString } } },
        acceptanceChecks: { type: "array", minItems: 1, items: acceptanceCheckSchema },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schema", "phase", "objective", "allowedPaths", "forbiddenChanges", "invariants", "deliverables", "acceptanceMapping", "context", "steps", "outOfScope"],
      properties: {
        ...artifactIdentity,
        phase: { type: "string", const: "plan" },
        objective: schemaString,
        allowedPaths: schemaNonEmptyStrings,
        forbiddenChanges: schemaNonEmptyStrings,
        invariants: schemaNonEmptyStrings,
        deliverables: schemaNonEmptyStrings,
        acceptanceMapping: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["checkId", "implementation"], properties: { checkId: schemaString, implementation: schemaString } } },
        context: { type: "object", additionalProperties: false, required: ["history", "callersAndDataFlow", "ciSurface", "priorFindings", "hazards"], properties: { history: schemaNonEmptyStrings, callersAndDataFlow: schemaNonEmptyStrings, ciSurface: schemaNonEmptyStrings, priorFindings: schemaNonEmptyStrings, hazards: schemaNonEmptyStrings } },
        steps: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["order", "action", "checkIds"], properties: { order: { type: "integer", minimum: 1 }, action: schemaString, checkIds: schemaNonEmptyStrings } } },
        outOfScope: schemaStrings,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schema", "phase", "branch", "baseBranch", "baseSha", "worktree"],
      properties: { ...artifactIdentity, phase: { type: "string", const: "prepare-worktree" }, branch: schemaString, baseBranch: schemaString, baseSha: { type: "string", minLength: 7 }, worktree: schemaString },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schema", "phase", "branch", "baseSha", "commitSha", "changedFiles", "acceptanceChecks", "checksRun"],
      properties: {
        ...artifactIdentity,
        phase: { type: "string", const: "implement" },
        branch: schemaString,
        baseSha: { type: "string", minLength: 7 },
        commitSha: { type: "string", minLength: 7 },
        changedFiles: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["path", "additions", "deletions", "change"], properties: { path: schemaString, additions: { type: "integer", minimum: 0 }, deletions: { type: "integer", minimum: 0 }, change: schemaString } } },
        acceptanceChecks: { type: "array", minItems: 1, items: acceptanceCheckSchema },
        checksRun: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["name", "status", "evidence"], properties: { name: schemaString, status: { type: "string", enum: ["passed", "failed", "skipped", "not-configured"] }, evidence: schemaString } } },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schema", "phase", "headSha", "checks", "readiness", "reason"],
      properties: {
        ...artifactIdentity,
        phase: { type: "string", const: "verify" },
        headSha: { type: "string", minLength: 7 },
        checks: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["name", "required", "status", "evidence"], properties: { name: schemaString, required: { type: "boolean" }, status: { type: "string", enum: ["passed", "failed", "skipped", "pending", "unknown", "not-configured", "policy-exempt"] }, evidence: schemaString } } },
        readiness: { type: "string", enum: ["ready-for-ci", "blocked"] },
        reason: schemaString,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schema", "phase", "pullNumber", "baseBranch", "headSha", "reviewRound", "domains"],
      properties: { ...artifactIdentity, phase: { type: "string", const: "prepare-pr" }, pullNumber: { type: "integer", minimum: 1 }, baseBranch: schemaString, headSha: { type: "string", minLength: 7 }, reviewRound: { type: "integer", minimum: 1 }, domains: schemaNonEmptyStrings },
    },
  ],
} as const;

export function phaseArtifactValidationError(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "artifact must be an object";
  const artifact = value as Record<string, unknown>;
  const phase = typeof artifact.phase === "string" ? artifact.phase : "unknown";
  const required: Record<string, readonly string[]> = {
    resolve: ["schema", "phase", "issueNumber", "title", "eligible", "baseBranch", "evidence"],
    investigate: ["schema", "phase", "verdict", "confidence", "severity", "taskType", "complexity", "claimed", "observed", "rootCause", "affectedFiles", "evidence", "history", "recommendation", "relatedIssues", "decomposition", "skippedPhases", "acceptanceChecks"],
    plan: ["schema", "phase", "objective", "allowedPaths", "forbiddenChanges", "invariants", "deliverables", "acceptanceMapping", "context", "steps", "outOfScope"],
    "prepare-worktree": ["schema", "phase", "branch", "baseBranch", "baseSha", "worktree"],
    implement: ["schema", "phase", "branch", "baseSha", "commitSha", "changedFiles", "acceptanceChecks", "checksRun"],
    verify: ["schema", "phase", "headSha", "checks", "readiness", "reason"],
    "prepare-pr": ["schema", "phase", "pullNumber", "baseBranch", "headSha", "reviewRound", "domains"],
  };
  const fields = required[phase];
  if (!fields) return `artifact.phase ${JSON.stringify(phase)} is unsupported`;
  const missing = fields.filter((field) => artifact[field] === undefined);
  if (missing.length) return `${phase} artifact is missing required field(s): ${missing.join(", ")}`;
  return `${phase} artifact contains one or more invalid field values`;
}

export function isPhaseArtifact(value: unknown): value is PhaseArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  if (artifact.schema !== "forgedock.phase-artifact/v1") return false;
  switch (artifact.phase) {
    case "resolve":
      return (
        Number.isSafeInteger(artifact.issueNumber) &&
        strings(artifact, ["title", "baseBranch"]) &&
        typeof artifact.eligible === "boolean" &&
        stringArray(artifact.evidence)
      );
    case "investigate":
      return (
        enumValue(artifact.verdict, ["confirmed", "invalid", "decompose"]) &&
        enumValue(artifact.confidence, ["high", "medium", "low"]) &&
        enumValue(artifact.severity, ["critical", "high", "medium", "low"]) &&
        enumValue(artifact.complexity, ["trivial", "standard", "complex"]) &&
        strings(artifact, ["taskType", "claimed", "observed", "rootCause", "recommendation"]) &&
        nonEmptyObjectArray(artifact.affectedFiles) &&
        nonEmptyStringArray(artifact.evidence) &&
        nonEmptyStringArray(artifact.history) &&
        numberArray(artifact.relatedIssues) &&
        objectValue(artifact.decomposition) &&
        objectArray(artifact.skippedPhases) &&
        nonEmptyObjectArray(artifact.acceptanceChecks)
      );
    case "plan":
      return (
        strings(artifact, ["objective"]) &&
        nonEmptyStringArray(artifact.allowedPaths) &&
        nonEmptyStringArray(artifact.forbiddenChanges) &&
        nonEmptyStringArray(artifact.invariants) &&
        nonEmptyStringArray(artifact.deliverables) &&
        nonEmptyObjectArray(artifact.acceptanceMapping) &&
        validPlanContext(artifact.context) &&
        nonEmptyObjectArray(artifact.steps) &&
        stringArray(artifact.outOfScope)
      );
    case "prepare-worktree":
      return strings(artifact, ["branch", "baseBranch", "baseSha", "worktree"]);
    case "implement":
      return (
        strings(artifact, ["branch", "baseSha", "commitSha"]) &&
        nonEmptyObjectArray(artifact.changedFiles) &&
        nonEmptyObjectArray(artifact.acceptanceChecks) &&
        nonEmptyObjectArray(artifact.checksRun)
      );
    case "verify":
      return (
        strings(artifact, ["headSha", "readiness", "reason"]) &&
        nonEmptyObjectArray(artifact.checks)
      );
    case "prepare-pr":
      return (
        Number.isSafeInteger(artifact.pullNumber) &&
        Number.isSafeInteger(artifact.reviewRound) &&
        strings(artifact, ["baseBranch", "headSha"]) &&
        nonEmptyStringArray(artifact.domains)
      );
    default:
      return false;
  }
}

export function renderPhaseArtifact(artifact: PhaseArtifact): string {
  switch (artifact.phase) {
    case "resolve":
      return `<!-- FORGE:RUN_CLAIM -->\n## Run Claim\n\n| Field | Value |\n| --- | --- |\n| Issue | #${artifact.issueNumber} — ${artifact.title} |\n| Eligible | ${artifact.eligible ? "yes" : "no"} |\n| Integration base | \`${artifact.baseBranch}\` |\n\n### Evidence\n\n${bullets(artifact.evidence)}`;
    case "investigate":
      return `<!-- FORGE:INVESTIGATOR -->\n## Investigation Report\n\n| Field | Value |\n| --- | --- |\n| Verdict | ${artifact.verdict.toUpperCase()} |\n| Confidence | ${artifact.confidence.toUpperCase()} |\n| Severity | ${artifact.severity.toUpperCase()} |\n| Task type | ${artifact.taskType} |\n| Complexity | ${artifact.complexity.toUpperCase()} |\n\n### Claimed Behavior\n\n${artifact.claimed}\n\n### Observed Behavior\n\n${artifact.observed}\n\n### Root Cause\n\n${artifact.rootCause}\n\n### Affected Files\n\n${table(artifact.affectedFiles.map((file) => [file.path, file.reason]), ["Path", "Reason"])}\n\n### Evidence\n\n${bullets(artifact.evidence)}\n\n### History\n\n${bullets(artifact.history)}\n\n### Recommendation\n\n${artifact.recommendation}\n\n### Related Issues\n\n${artifact.relatedIssues.length ? artifact.relatedIssues.map((issue) => `- #${issue}`).join("\n") : "- None."}\n\n### Decomposition\n\n**Required**: ${artifact.decomposition.required ? "yes" : "no"} — ${artifact.decomposition.reason}\n\n<!-- FORGE:FAST_PATH -->\n### Routing\n\n**Complexity**: ${artifact.complexity.toUpperCase()}  \n**Task type**: ${artifact.taskType}\n\n${artifact.skippedPhases.length ? artifact.skippedPhases.map((entry) => `- ${entry.phase}: skipped — ${entry.reason}`).join("\n") : "- No phases skipped."}\n\n### Acceptance Checks\n\n${renderChecks(artifact.acceptanceChecks)}\n\n<!-- INVESTIGATION:COMPLETE -->`;
    case "plan":
      return `<!-- FORGE:CONTRACT -->\n## Builder Contract\n\n### Objective\n\n${artifact.objective}\n\n### Allowed Paths\n\n${bullets(artifact.allowedPaths)}\n\n### Forbidden Changes\n\n${bullets(artifact.forbiddenChanges)}\n\n### Invariants\n\n${bullets(artifact.invariants)}\n\n### Deliverables\n\n${bullets(artifact.deliverables)}\n\n### Acceptance Mapping\n\n${table(artifact.acceptanceMapping.map((entry) => [entry.checkId, entry.implementation]), ["Check", "Implementation"])}\n\n### Out of Scope\n\n${bullets(artifact.outOfScope)}\n\n<!-- FORGE:CONTEXT -->\n## Implementation Context\n\n### Relevant History\n\n${bullets(artifact.context.history)}\n\n### Callers and Data Flow\n\n${bullets(artifact.context.callersAndDataFlow)}\n\n### CI Surface\n\n${bullets(artifact.context.ciSurface)}\n\n### Prior Findings\n\n${bullets(artifact.context.priorFindings)}\n\n### Hazards\n\n${bullets(artifact.context.hazards)}\n\n<!-- FORGE:CONTEXT:COMPLETE -->\n\n<!-- FORGE:ARCHITECT -->\n## Architecture Plan\n\n${artifact.steps.map((step) => `${step.order}. ${step.action} (${step.checkIds.join(", ")})`).join("\n")}\n\n<!-- FORGE:ARCHITECT:COMPLETE -->`;
    case "prepare-worktree":
      return `<!-- FORGE:WORKTREE -->\n## Worktree Prepared\n\n| Field | Value |\n| --- | --- |\n| Branch | \`${artifact.branch}\` |\n| Base | \`${artifact.baseBranch}\` at \`${artifact.baseSha}\` |\n| Worktree | \`${artifact.worktree}\` |`;
    case "implement":
      return `<!-- FORGE:BUILDER -->\n## Implementation Complete\n\n| Field | Value |\n| --- | --- |\n| Branch | \`${artifact.branch}\` |\n| Base SHA | \`${artifact.baseSha}\` |\n| Commit SHA | \`${artifact.commitSha}\` |\n\n### Changed Files\n\n${table(artifact.changedFiles.map((file) => [file.path, `+${file.additions}/-${file.deletions}`, file.change]), ["Path", "Diff", "Change"])}\n\n### Acceptance Status\n\n${renderChecks(artifact.acceptanceChecks)}\n\n### Checks Run\n\n${table(artifact.checksRun.map((check) => [check.name, check.status, check.evidence]), ["Check", "Status", "Evidence"])}\n\n<!-- FORGE:BUILDER:COMPLETE -->`;
    case "verify":
      return `<!-- FORGE:LOCAL_VERIFICATION -->\n## Local Implementation Readiness — ${artifact.readiness === "ready-for-ci" ? "COMPLETE" : "BLOCKED"}\n\n**Checked head**: \`${artifact.headSha}\`\n\n${table(artifact.checks.map((check) => [check.name, check.required ? "required" : "optional", check.status, check.evidence]), ["Check", "Policy", "Status", "Evidence"])}\n\n**Reason**: ${artifact.reason}\n\n<!-- FORGE:IMPLEMENTATION_READY_FOR_CI -->`;
    case "prepare-pr":
      return `<!-- FORGE:REVIEW_STARTED -->\n## Review Started\n\n| Field | Value |\n| --- | --- |\n| PR | #${artifact.pullNumber} |\n| Target | \`${artifact.baseBranch}\` |\n| Frozen head | \`${artifact.headSha}\` |\n| Round | ${artifact.reviewRound} |\n| Domains | ${artifact.domains.join(", ")} |`;
  }
}

function strings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === "string" && Boolean((value[field] as string).trim()));
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && Boolean(entry.trim()));
}
function nonEmptyStringArray(value: unknown): value is string[] {
  return stringArray(value) && value.length > 0;
}
function numberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => Number.isSafeInteger(entry));
}
function objectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(objectValue);
}
function nonEmptyObjectArray(value: unknown): value is Record<string, unknown>[] {
  return objectArray(value) && value.length > 0;
}
function objectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function validPlanContext(value: unknown): boolean {
  if (!objectValue(value)) return false;
  return [
    value.history,
    value.callersAndDataFlow,
    value.ciSurface,
    value.priorFindings,
    value.hazards,
  ].every(nonEmptyStringArray);
}
function enumValue(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}
function bullets(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- None.";
}
function table(rows: string[][], headers: string[]): string {
  const body = rows.length ? rows : [headers.map(() => "None")];
  return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body.map((row) => `| ${row.join(" | ")} |`).join("\n")}`;
}
function renderChecks(checks: AcceptanceCheck[]): string {
  return checks.length
    ? checks.map((check) => `- [${check.status === "passed" ? "x" : " "}] **${check.id}** ${check.description} — ${check.status}${check.evidence.length ? ` (${check.evidence.join("; ")})` : ""}`).join("\n")
    : "- No acceptance checks supplied.";
}
