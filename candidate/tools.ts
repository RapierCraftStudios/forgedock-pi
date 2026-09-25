import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";

const HELPER = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/forgedock-candidate.mjs");
const REPOSITORY = Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" });
const SHA = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
const ROLE = Type.String({ pattern: "^[a-z][a-z0-9-]*$" });
const REVIEW_INPUT = Type.Object({
  repository: REPOSITORY,
  pullRequest: Type.Integer({ minimum: 1 }),
  head: SHA,
  baseRef: Type.String({ minLength: 1 }),
  baseSha: SHA,
  sourceRoot: Type.String({ minLength: 1 }),
  configRoot: Type.Optional(Type.String({ minLength: 1 })),
  acceptance: Type.Optional(Type.Array(Type.String())),
  roles: Type.Optional(Type.Array(ROLE, { minItems: 1, maxItems: 3 })),
  rationale: Type.Optional(Type.Array(Type.String())),
  history: Type.Optional(Type.Array(Type.String())),
  evidence: Type.Optional(Type.Array(Type.String())),
  limitations: Type.Optional(Type.Array(Type.String())),
  acceptanceSources: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  materialSecurityBoundary: Type.Optional(Type.Boolean()),
  specialistQuestion: Type.Optional(Type.String()),
  publish: Type.Optional(Type.Boolean()),
});

type ReviewInput = {
  repository: string;
  pullRequest: number;
  head: string;
  baseRef: string;
  baseSha: string;
  sourceRoot: string;
  configRoot?: string;
  acceptance?: string[];
  roles?: string[];
  rationale?: string[];
  history?: string[];
  evidence?: string[];
  limitations?: string[];
  acceptanceSources?: string[];
  materialSecurityBoundary?: boolean;
  specialistQuestion?: string;
  publish?: boolean;
};

const CHECK_INPUT = Type.Object({
  name: Type.String({ pattern: "^[A-Za-z0-9_.-]+$" }),
  configPath: Type.String({ minLength: 1 }),
  configSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  reviewRoot: Type.String({ minLength: 1 }),
  artifactKey: Type.String({ minLength: 1 }),
  sourceRoot: Type.String({ minLength: 1 }),
  head: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
});
const TRACKING_DRAFT = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 240 }),
  problem: Type.String({ minLength: 1 }),
  rootCause: Type.String({ minLength: 1 }),
  affectedFiles: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  expectedBehavior: Type.String({ minLength: 1 }),
  acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  stage: Type.String({ minLength: 1 }),
  sourceLinks: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  labels: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z0-9_.:-]+$" }))),
  linkedIssueNumbers: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 })),
});
const HISTORICAL_DECISION = Type.Object({
  id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.-]*$" }),
  sourceReference: Type.String({ minLength: 1, description: "Original report, comment, or record that raised this historical concern." }),
  disposition: Type.String({ pattern: "^(?:IMMEDIATE REPAIR|NON-BLOCKING FOLLOW-UP|REJECTED/NOT APPLICABLE|EVIDENCE/AUTHORITY PREREQUISITE)$", description: "The current parent disposition; a disproven historical allegation must use REJECTED/NOT APPLICABLE." }),
  resolution: Type.String({ pattern: "^(?:confirmed|resolved-by-evidence|superseded|duplicate|unsupported)$" }),
  summary: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
  evidence: Type.Array(Type.String({ minLength: 1 })),
  stage: Type.String({ minLength: 1 }),
  proofSource: Type.Optional(Type.String({ minLength: 1 })),
  blocksCurrentStage: Type.Boolean(),
  tracking: Type.Optional(Type.Object({
    status: Type.String({ pattern: "^(?:none|existing|source-issue|new|pending)$" }),
    issueNumber: Type.Optional(Type.Integer({ minimum: 1 })),
    issueUrl: Type.Optional(Type.String({ minLength: 1 })),
    draft: Type.Optional(TRACKING_DRAFT),
  })),
}, { description: "One explicit current-attempt adjudication of a prior concern, including source, disposition, rationale, evidence, stage, and applicable tracking." });
const REVIEW_RECOVERY_INPUT = Type.Object({
  repository: REPOSITORY,
  pullRequest: Type.Integer({ minimum: 1 }),
  head: SHA,
  baseRef: Type.String({ minLength: 1 }),
  baseSha: SHA,
  reviewRoot: Type.String({ minLength: 1 }),
  artifactKey: Type.String({ minLength: 1 }),
  role: ROLE,
  nativeRunId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$" }),
  nativeTerminal: Type.String({ pattern: "^(?:completed|failed|stopped|interrupted|timed-out|detached|execution-limit|nonterminal|unknown)$" }),
});
const INCOMPLETE_REVIEW_INPUT = Type.Object({
  repository: REPOSITORY,
  pullRequest: Type.Integer({ minimum: 1 }),
  head: SHA,
  baseRef: Type.String({ minLength: 1 }),
  baseSha: SHA,
  reviewRoot: Type.String({ minLength: 1 }),
  artifactKey: Type.String({ minLength: 1 }),
  role: ROLE,
  nativeRunId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$" })),
  nativeTerminal: Type.String({ pattern: "^(?:completed|failed|stopped|interrupted|timed-out|detached|execution-limit|nonterminal|unknown)$" }),
  deliveryError: Type.String({ minLength: 1, maxLength: 1000 }),
  recoveryBlocker: Type.Optional(Type.Literal("execution-limit")),
  blockerEvidence: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  publish: Type.Boolean(),
});
const ADJUDICATION_INPUT = Type.Object({
  repository: REPOSITORY,
  pullRequest: Type.Integer({ minimum: 1 }),
  head: SHA,
  baseRef: Type.String({ minLength: 1 }),
  baseSha: SHA,
  mode: Type.String({ pattern: "^(?:standard|staging)$" }),
  reviewRoot: Type.String({ minLength: 1 }),
  artifactKey: Type.String({ minLength: 1 }),
  verdict: Type.String({ pattern: "^(?:APPROVE|APPROVE_WITH_FOLLOW_UP|CHANGES_REQUESTED|GATED)$" }),
  gate: Type.String({ pattern: "^(?:PASS|FAIL)$" }),
  decisions: Type.Array(Type.Object({
    id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.-]*$" }),
    sourceObservationIds: Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*:F[1-9][0-9]*$" }), { minItems: 1 }),
    disposition: Type.String({ pattern: "^(?:IMMEDIATE REPAIR|NON-BLOCKING FOLLOW-UP|REJECTED/NOT APPLICABLE|EVIDENCE/AUTHORITY PREREQUISITE)$" }),
    resolution: Type.String({ pattern: "^(?:confirmed|resolved-by-evidence|superseded|duplicate|unsupported)$" }),
    summary: Type.String({ minLength: 1 }),
    rationale: Type.String({ minLength: 1 }),
    evidence: Type.Array(Type.String({ minLength: 1 })),
    stage: Type.String({ minLength: 1 }),
    proofSource: Type.Optional(Type.String({ minLength: 1 })),
    blocksCurrentStage: Type.Boolean(),
    tracking: Type.Optional(Type.Object({
      status: Type.String({ pattern: "^(?:none|existing|source-issue|new|pending)$" }),
      issueNumber: Type.Optional(Type.Integer({ minimum: 1 })),
      issueUrl: Type.Optional(Type.String({ minLength: 1 })),
      draft: Type.Optional(TRACKING_DRAFT),
    })),
  }), { description: "Map every current reviewer observation ID to one explicit disposition; duplicate observations may be grouped while retaining all source IDs." }),
  historicalDecisions: Type.Array(HISTORICAL_DECISION, { description: "The only representation of prior concerns. Re-adjudicate each applicable historical concern with an explicit record; use [] when history has no applicable concerns. Do not pass legacy prose priorConcerns." }),
  checks: Type.Array(Type.Object({
    name: Type.String({ minLength: 1 }),
    required: Type.Boolean(),
    conclusion: Type.String({ minLength: 1 }),
    executedProof: Type.Boolean(),
    executedProofRequired: Type.Boolean(),
    policyAccepted: Type.Boolean(),
    proofSource: Type.Optional(Type.String({ minLength: 1 })),
    stage: Type.String({ minLength: 1 }),
    evidence: Type.Array(Type.String({ minLength: 1 })),
  })),
  limitations: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  nextAction: Type.String({ minLength: 1 }),
  allowIssueWrites: Type.Boolean(),
  supersedes: Type.Optional(Type.String({ minLength: 1 })),
  round: Type.Optional(Type.Integer({ minimum: 0 })),
  revision: Type.Optional(Type.Integer({ minimum: 0 })),
  publish: Type.Boolean(),
});
const TRACKING_SEARCH_INPUT = Type.Object({
  repository: REPOSITORY,
  pullRequest: Type.Integer({ minimum: 1 }),
  head: SHA,
  concernId: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*:F[1-9][0-9]*$" }),
  draft: TRACKING_DRAFT,
  reviewRoot: Type.String({ minLength: 1 }),
  artifactKey: Type.String({ minLength: 1 }),
});
const RECORD_INPUT = Type.Object({
  repository: REPOSITORY,
  issue: Type.Optional(Type.Integer({ minimum: 1 })),
  pullRequest: Type.Optional(Type.Integer({ minimum: 1 })),
  kind: Type.String({ pattern: "^[A-Z_]+$" }),
  head: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40,64}$" })),
  baseRef: Type.Optional(Type.String({ minLength: 1 })),
  baseSha: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40,64}$" })),
  gate: Type.Optional(Type.String({ pattern: "^(?:PASS|FAIL)$" })),
  checks: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_. -]*$" }))),
  body: Type.String({ minLength: 8 }),
  reviewRoot: Type.Optional(Type.String({ minLength: 1 })),
  artifactKey: Type.Optional(Type.String({ minLength: 1 })),
  supersedes: Type.Optional(Type.String({ minLength: 1 })),
  adjudicationPath: Type.Optional(Type.String({ minLength: 1 })),
  preReviewInfrastructure: Type.Optional(Type.Boolean()),
  publish: Type.Boolean(),
});

type RecordInput = {
  repository: string;
  issue?: number;
  pullRequest?: number;
  kind: string;
  head?: string;
  baseRef?: string;
  baseSha?: string;
  gate?: string;
  checks?: string[];
  body: string;
  reviewRoot?: string;
  artifactKey?: string;
  supersedes?: string;
  adjudicationPath?: string;
  preReviewInfrastructure?: boolean;
  publish: boolean;
};

function helperPath(): string {
  return process.env.FORGEDOCK_CANDIDATE_BIN ?? HELPER;
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function preparedReview(root: string, artifactKey: string): Promise<Record<string, unknown>> {
  const reviewRoot = resolve(root);
  if (!existsSync(reviewRoot) || realpathSync(reviewRoot) !== reviewRoot) throw new Error("Prepared review root must be a canonical directory");
  const reviewPath = resolve(reviewRoot, "review.json");
  if (!existsSync(reviewPath) || realpathSync(reviewPath) !== reviewPath) throw new Error("Prepared review authorization must be a regular file");
  const review = JSON.parse(await readFile(reviewPath, "utf8")) as Record<string, unknown>;
  if (review.schema !== "forgedock.candidate-review/v1" || review.artifactRoot !== reviewRoot || review.artifactKey !== artifactKey) {
    throw new Error("Prepared review authorization is missing or does not match the artifact root");
  }
  return review;
}

function reviewRoles(review: Record<string, unknown>): string[] {
  if (!Array.isArray(review.roles) || review.roles.length < 1 || review.roles.length > 3 || review.roles.some((role) => typeof role !== "string" || !/^[a-z][a-z0-9-]*$/.test(role))) throw new Error("Prepared review has no valid selected reviewer roster");
  return [...review.roles] as string[];
}

function roleArtifactKey(review: Record<string, unknown>, role: string): string {
  const keys = review.roleArtifactKeys;
  const key = keys && typeof keys === "object" && !Array.isArray(keys) ? (keys as Record<string, unknown>)[role] : undefined;
  if (typeof key !== "string" || !key.trim()) throw new Error(`Prepared review has no role authorization key for ${role}`);
  return key;
}

function preparedReviewMode(review: Record<string, unknown>): "standard" | "staging" {
  const config = review.config && typeof review.config === "object" && !Array.isArray(review.config) ? review.config as Record<string, unknown> : {};
  const baseRef = review.baseRef;
  const derived = baseRef === config.protectedBranch ? "staging" : baseRef === config.integrationBranch ? "standard" : undefined;
  const mode = derived ?? (review.config === undefined && (review.mode === "standard" || review.mode === "staging") ? review.mode : undefined);
  if (!mode || review.mode !== undefined && review.mode !== mode) throw new Error("Prepared review route does not match its canonical base branch");
  return mode;
}

function reviewerReportIdentity(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path) || realpathSync(path) !== path) return undefined;
  const report = readFileSync(path, "utf8");
  const marker = report.match(/^<!-- FORGE:REVIEWER_REPORT (\{.*\}) -->$/m);
  if (!marker?.[1]) return undefined;
  try { return JSON.parse(marker[1]) as Record<string, unknown>; } catch { return undefined; }
}

async function requireReviewerReports(pi: ExtensionAPI, review: Record<string, unknown>, input: Record<string, unknown>): Promise<Array<{ role: string; path: string; reportId: string }>> {
  const root = resolve(String(input.reviewRoot));
  const missing: string[] = [];
  const invalid: string[] = [];
  const undelivered: string[] = [];
  const reports: Array<{ role: string; path: string; reportId: string }> = [];
  const roles = reviewRoles(review);
  for (const role of roles) {
    const authorizationPath = join(root, `${role}.authorization.json`);
    let authorizedRole = false;
    try {
      const authorization = JSON.parse(await readFile(authorizationPath, "utf8")) as Record<string, unknown>;
      authorizedRole = existsSync(authorizationPath) && realpathSync(authorizationPath) === authorizationPath && authorization.schema === "forgedock.candidate-review-role/v1" && authorization.artifactRoot === root && authorization.artifactKey === roleArtifactKey(review, role) && authorization.role === role && authorization.repository === review.repository && authorization.pullRequest === review.pullRequest && authorization.head === review.head && authorization.baseRef === review.baseRef && authorization.baseSha === review.baseSha && authorization.publish === review.publish;
    } catch { authorizedRole = false; }
    if (!authorizedRole) invalid.push(role);
  }
  if (invalid.length) throw new Error(`Reviewer report or authored recovery content does not match its prepared role: ${invalid.join(", ")}`);
  const recoveryByRole = new Map<string, Record<string, unknown>>();
  for (const role of roles) {
    const recoveryPath = join(root, `${role}.publication-recovery.json`);
    let recovery: Record<string, unknown>;
    try {
      if (!existsSync(recoveryPath) || realpathSync(recoveryPath) !== recoveryPath) throw new Error("recovery sidecar is missing or not a regular file");
      recovery = JSON.parse(await readFile(recoveryPath, "utf8")) as Record<string, unknown>;
    } catch { invalid.push(role); continue; }
    const bodyPath = join(root, `${role}.body.md`);
    const reportPath = join(root, `${role}.report.md`);
    const observationsPath = join(root, `${role}.observations.json`);
    const execution = await verifiedReviewerExecutionResult(root, review, role);
    const body = typeof recovery.body === "string" ? `${recovery.body.trim()}\n` : "";
    const observations = Array.isArray(recovery.observations) ? `${JSON.stringify(recovery.observations, null, 2)}\n` : "";
    const materializedBodyMatches = !existsSync(bodyPath) || realpathSync(bodyPath) === bodyPath && await readFile(bodyPath, "utf8") === body;
    const materializedObservationsMatch = !existsSync(observationsPath) || realpathSync(observationsPath) === observationsPath && await readFile(observationsPath, "utf8") === observations;
    if (recovery.schema !== "forgedock.candidate-review-publication-recovery/v1" || recovery.reviewArtifactKey !== review.artifactKey || recovery.roleArtifactKey !== roleArtifactKey(review, role) || recovery.repository !== review.repository || recovery.pullRequest !== review.pullRequest || recovery.head !== review.head || recovery.baseRef !== review.baseRef || recovery.baseSha !== review.baseSha || recovery.role !== role || recovery.publish !== review.publish || typeof recovery.nativeRunId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(recovery.nativeRunId) || recovery.bodyPath !== bodyPath || recovery.reportPath !== reportPath || recovery.observationsPath !== observationsPath || !body || body.trim().length < 32 || !observations || digest(body) !== recovery.bodySha256 || digest(observations) !== recovery.observationsSha256 || !execution || execution.nativeRunId !== recovery.nativeRunId || !materializedBodyMatches || !materializedObservationsMatch) { invalid.push(role); continue; }
    recoveryByRole.set(role, recovery);
  }
  if (invalid.length) throw new Error(`Reviewer report or authored recovery content does not match its prepared role: ${invalid.join(", ")}`);
  for (const role of roles) {
    const path = join(root, `${role}.report.md`);
    const recovery = recoveryByRole.get(role)!;
    const delivery = await verifyReviewerReportDelivery(pi, review, root, role, recovery);
    if (delivery.outcome === "missing") { missing.push(role); continue; }
    if (delivery.outcome === "invalid" || delivery.reportId !== roleArtifactKey(review, role) || delivery.authoredEvidence !== "verified") { invalid.push(role); continue; }
    if (review.publish === true && delivery.outcome !== "published" || review.publish !== true && delivery.outcome !== "saved") { undelivered.push(role); continue; }
    reports.push({ role, path: delivery.reportPath, reportId: roleArtifactKey(review, role) });
  }
  if (invalid.length) throw new Error(`Reviewer report or authored recovery content does not match its prepared role: ${invalid.join(", ")}`);
  if (missing.length) {
    const recovery = missing.map((role) => `${role}=${join(root, `${role}.publication-recovery.json`)}`).join(", ");
    throw new Error(`Adjudication was not attempted: required reviewer report missing for role ${missing.join(", ")}. Preserve the current verdict semantics and use only exact-run readback/recovery when its bound input and native result permit. Recovery artifacts: ${recovery}`);
  }
  if (undelivered.length) throw new Error(`Adjudication was not attempted: exact authored report exists but publication is not verified for role ${undelivered.join(", ")}. Use only the bounded exact-run recovery/finalization path; do not relaunch reviewers.`);
  return reports;
}

async function stableTextArtifact(path: string, content: string): Promise<void> {
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (await readFile(path, "utf8") !== content) throw error; }
}

async function verifyReviewerReportDelivery(pi: ExtensionAPI, review: Record<string, unknown>, root: string, role: string, recovery?: Record<string, unknown>): Promise<{ outcome: "published" | "saved" | "unverified" | "missing" | "invalid"; reportPath: string; reportId?: string; url?: string; error?: string; authoredEvidence: "verified" | "unavailable" | "mismatch" }> {
  const reportPath = join(root, `${role}.report.md`);
  const bodyPath = join(root, `${role}.body.md`);
  const observationsPath = join(root, `${role}.observations.json`);
  const roleKey = roleArtifactKey(review, role);
  let authoredEvidence: "verified" | "unavailable" | "mismatch" = "unavailable";
  if (recovery && (recovery.schema !== "forgedock.candidate-review-publication-recovery/v1" || recovery.reviewArtifactKey !== review.artifactKey || recovery.roleArtifactKey !== roleKey || recovery.repository !== review.repository || recovery.pullRequest !== review.pullRequest || recovery.head !== review.head || recovery.baseRef !== review.baseRef || recovery.baseSha !== review.baseSha || recovery.role !== role || recovery.publish !== review.publish)) return { outcome: "invalid", reportPath, error: "recovery input does not match the prepared role and frozen source", authoredEvidence: "mismatch" };
  const hasAuthoredEvidence = recovery && typeof recovery.body === "string" && Array.isArray(recovery.observations) && typeof recovery.bodySha256 === "string" && typeof recovery.observationsSha256 === "string";
  if (hasAuthoredEvidence) {
    const body = `${String(recovery.body).trim()}\n`;
    const observations = `${JSON.stringify(recovery.observations, null, 2)}\n`;
    if (digest(body) !== recovery.bodySha256 || digest(observations) !== recovery.observationsSha256) return { outcome: "invalid", reportPath, error: "retained authored body/observations failed their recorded digest check", authoredEvidence: "mismatch" };
    try {
      await stableTextArtifact(bodyPath, body);
      await stableTextArtifact(observationsPath, observations);
    } catch (error) {
      return { outcome: "invalid", reportPath, error: `retained authored artifacts do not match the recovery input: ${error instanceof Error ? error.message : String(error)}`, authoredEvidence: "mismatch" };
    }
    // Re-entry may materialize the canonical local report for byte-exact readback, but must never publish here.
    const render = await pi.exec("node", [helperPath(), "record", "reviewer", "--repo", String(review.repository), "--pr", String(review.pullRequest), "--head", String(review.head), "--base-ref", String(review.baseRef), "--base-sha", String(review.baseSha), "--role", role, "--report-id", roleKey, "--body-file", bodyPath, "--report-file", reportPath, "--observations-file", observationsPath, "--cwd", String(review.configRoot ?? review.sourceRoot)], { timeout: 120_000 });
    if (render.code !== 0) return { outcome: "invalid", reportPath, error: bounded(render.stderr), authoredEvidence: "mismatch" };
    authoredEvidence = "verified";
  }
  const identity = reviewerReportIdentity(reportPath);
  if (!identity) return { outcome: existsSync(reportPath) ? "invalid" : "missing", reportPath, error: existsSync(reportPath) ? "report file is not a canonical regular role report" : undefined, authoredEvidence };
  if (identity.repository !== review.repository || identity.pullRequest !== review.pullRequest || identity.head !== review.head || identity.baseRef !== review.baseRef || identity.baseSha !== review.baseSha || identity.role !== role || identity.reportId !== roleKey) return { outcome: "invalid", reportPath, error: "report identity does not match the prepared role and frozen source", authoredEvidence };
  if (review.publish !== true) return { outcome: "saved", reportPath, reportId: roleKey, authoredEvidence };
  const verification = await pi.exec("node", [helperPath(), "verify-reviewer", "--repo", String(review.repository), "--pr", String(review.pullRequest), "--head", String(review.head), "--base-ref", String(review.baseRef), "--base-sha", String(review.baseSha), "--role", role, "--report-id", roleKey, "--report-file", reportPath, "--cwd", String(review.configRoot ?? review.sourceRoot)], { timeout: 120_000 });
  if (verification.code !== 0) return { outcome: "unverified", reportPath, reportId: roleKey, error: bounded(verification.stderr) || "exact published comment was not found", authoredEvidence };
  try {
    const result = JSON.parse(verification.stdout) as Record<string, unknown>;
    if (result.schema !== "forgedock.candidate-review-report-verification/v1" || result.publication !== "published" || result.repository !== review.repository || result.pullRequest !== review.pullRequest || result.head !== review.head || result.baseRef !== review.baseRef || result.baseSha !== review.baseSha || result.role !== role || result.reportId !== roleKey || typeof result.url !== "string") throw new Error("readback identity mismatch");
    return { outcome: "published", reportPath, reportId: roleKey, url: result.url, authoredEvidence };
  } catch (error) {
    return { outcome: "unverified", reportPath, reportId: roleKey, error: `report publication readback could not be validated: ${error instanceof Error ? error.message : String(error)}`, authoredEvidence };
  }
}

function verifiedReviewerLaunchClaim(root: string, review: Record<string, unknown>, toolCallId?: unknown): boolean {
  const path = join(root, "panel-launch.claim");
  if (!existsSync(path) || realpathSync(path) !== path) return false;
  try {
    const claim = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return claim.schema === "forgedock.candidate-review-panel-launch/v1" && claim.artifactKey === review.artifactKey && claim.workflowSha256 === review.workflowSha256 && typeof claim.claimedAt === "string" && Number.isFinite(Date.parse(claim.claimedAt)) && (claim.toolCallId === undefined || typeof claim.toolCallId === "string" && (toolCallId === undefined || claim.toolCallId === toolCallId));
  } catch { return false; }
}

async function verifiedReviewerExecutionResult(root: string, review: Record<string, unknown>, role: string): Promise<Record<string, unknown> | undefined> {
  const path = join(root, "reviewer-execution.json");
  if (!existsSync(path) || realpathSync(path) !== path) return undefined;
  try {
    const receipt = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const roles = reviewRoles(review);
    const validStatuses = new Set(["completed", "failed", "stopped", "interrupted", "timed-out", "detached", "execution-limit", "nonterminal"]);
    if (!verifiedReviewerLaunchClaim(root, review, receipt.toolCallId) || receipt.schema !== "forgedock.candidate-review-execution/v1" || receipt.repository !== review.repository || receipt.pullRequest !== review.pullRequest || receipt.head !== review.head || receipt.baseRef !== review.baseRef || receipt.baseSha !== review.baseSha || receipt.artifactKey !== review.artifactKey || receipt.mode !== preparedReviewMode(review) || receipt.workflowPath !== review.workflowPath || receipt.workflowSha256 !== review.workflowSha256 || typeof receipt.workflowRunId !== "string" || !receipt.workflowRunId.trim() || typeof receipt.toolCallId !== "string" || !receipt.toolCallId.trim() || typeof receipt.completedAt !== "string" || !Array.isArray(receipt.roleResults) || receipt.roleResults.length !== roles.length) return undefined;
    let selected: Record<string, unknown> | undefined;
    for (let index = 0; index < roles.length; index++) {
      const row = receipt.roleResults[index];
      if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
      const result = row as Record<string, unknown>;
      if (result.role !== roles[index] || !validStatuses.has(String(result.nativeStatus)) || !(result.nativeRunId === null || typeof result.nativeRunId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(result.nativeRunId)) || result.reportPath !== join(root, `${roles[index]}.report.md`) || result.recoveryPath !== join(root, `${roles[index]}.publication-recovery.json`) || !(result.exitCode === null || Number.isSafeInteger(result.exitCode))) return undefined;
      if (roles[index] === role) selected = result;
    }
    return selected;
  } catch { return undefined; }
}

async function publishedIncompleteDeliverySupersedes(root: string, review: Record<string, unknown>): Promise<string | undefined> {
  const found: Array<{ url: string; role: string }> = [];
  for (const role of reviewRoles(review)) {
    const prefix = `review-delivery-incomplete-${role}-`;
    for (const name of await readdir(root)) {
      if (!name.startsWith(prefix) || !name.endsWith(".receipt.json")) continue;
      const path = join(root, name);
      if (realpathSync(path) !== path) continue;
      let receipt: Record<string, unknown>;
      try { receipt = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; } catch { continue; }
      if (receipt.schema !== "forgedock.candidate-review-delivery-receipt/v1" || receipt.repository !== review.repository || receipt.pullRequest !== review.pullRequest || receipt.head !== review.head || receipt.baseRef !== review.baseRef || receipt.baseSha !== review.baseSha || receipt.role !== role || receipt.artifactKey !== review.artifactKey || !(receipt.nativeRunId === null || typeof receipt.nativeRunId === "string") || typeof receipt.recordUrl !== "string") continue;
      found.push({ url: receipt.recordUrl, role });
    }
  }
  const unique = [...new Map(found.map((record) => [record.url, record])).values()];
  if (unique.length > 1) throw new Error("Multiple published incomplete-delivery records exist; explicitly resolve their supersession before adjudication");
  return unique[0]?.url;
}

function sanitizedOneLine(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
}

function artifactFile(root: string, requested: string, label: string): string {
  const canonicalRoot = resolve(root);
  const file = resolve(requested);
  const distance = relative(canonicalRoot, file);
  if (!distance || distance === ".." || distance.startsWith("../")) throw new Error(`${label} must remain under the prepared review artifact root`);
  return file;
}

async function revisionedJsonFile(root: string, prefix: string, revision: number, value: unknown): Promise<string> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const fingerprint = digest(JSON.stringify(value)).slice(0, 12);
  const fileName = `${prefix}-r${revision}-${fingerprint}.json`;
  const entries = await readdir(root);
  const priorRevisions = entries.map((entry) => entry.match(new RegExp(`^${prefix}-r([0-9]+)-`))?.[1]).filter((value): value is string => value !== undefined).map(Number);
  if (!entries.includes(fileName) && priorRevisions.some((value) => value >= revision)) throw new Error(`${prefix} revision ${revision} must advance the existing review artifact revision`);
  return stableJsonFile(join(root, fileName), JSON.parse(content));
}

async function stableJsonFile(path: string, value: unknown): Promise<string> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (await readFile(path, "utf8") !== content) throw error;
  }
  return path;
}

async function atomicallyReplaceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function bounded(text: string): string {
  return text.length > 50_000 ? `${text.slice(-50_000)}\n[output truncated]` : text;
}

function forbiddenStagingCheck(command: string): boolean {
  return command.includes(">") || /\b(?:git|gh|npm)\b[^\n]*(?:push|commit|merge|rebase|reset|checkout|switch|branch\s+-D|deploy|publish|issue\s+(?:create|close|edit)|pr\s+(?:create|merge|close|edit))\b/i.test(command);
}

async function writeCheckReceipt(root: string, receipt: Record<string, unknown>): Promise<string> {
  const directory = join(resolve(root), "checks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${String(receipt.name)}.json`);
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    await writeFile(file, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (await readFile(file, "utf8") !== content) throw error;
  }
  return file;
}

function policyCheckPassed(row: Record<string, unknown>): boolean {
  const bucket = typeof row.bucket === "string" ? row.bucket.toLowerCase() : "";
  const state = typeof row.state === "string" ? row.state.toUpperCase() : "";
  const conclusion = typeof row.conclusion === "string" ? row.conclusion.toUpperCase() : "";
  if (["pending", "fail", "cancel"].includes(bucket)) return false;
  if (["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "CANCELLED"].includes(state)) return false;
  if (["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(conclusion)) return false;
  return bucket === "pass" || state === "SUCCESS" || conclusion === "SUCCESS" || ["SKIPPED", "NEUTRAL"].includes(state) || ["SKIPPED", "NEUTRAL"].includes(conclusion);
}

function policyArtifactPath(reviewRoot: string): string {
  const root = resolve(reviewRoot);
  const path = join(root, "policy.json");
  if (!existsSync(path) || realpathSync(path) !== path) throw new Error("Prepared review policy artifact is missing or not a regular file");
  return path;
}

async function writePolicyArtifact(reviewRoot: string, artifact: Record<string, unknown>): Promise<string> {
  const path = join(resolve(reviewRoot), "policy.json");
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (await readFile(path, "utf8") !== content) throw error;
  }
  return path;
}

function policySummary(policy: unknown): Record<string, unknown> {
  const value = policy && typeof policy === "object" && !Array.isArray(policy) ? policy as Record<string, any> : {};
  const required = value.policy?.evaluatedRequiredChecks;
  const requirements = value.policy?.requirements;
  const rows = Array.isArray(required?.data) ? required.data : [];
  return {
    schema: value.schema ?? null,
    repository: value.repository ?? null,
    pullRequest: value.pullRequest ?? null,
    head: value.identity?.head ?? null,
    baseRef: value.identity?.baseRef ?? null,
    baseSha: value.identity?.baseSha ?? null,
    applicability: requirements?.applicability ?? "unknown",
    requiredNames: requirements?.requiredNames ?? rows.map((row: any) => row?.name).filter(Boolean),
    observedCount: rows.length,
    requiredStatus: required?.status ?? "unknown",
    requiredExitCode: required?.exitCode ?? null,
    localCommands: Object.keys(value.configuration?.verificationCommands ?? {}),
  };
}

function loadPolicyArtifact(reviewRoot: string, review: Record<string, unknown>): Record<string, unknown> {
  const path = policyArtifactPath(reviewRoot);
  const artifact = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  if (artifact.schema !== "forgedock.candidate-policy/v1" || artifact.artifactKey !== review.artifactKey || artifact.repository !== review.repository || artifact.pullRequest !== review.pullRequest || artifact.head !== review.head || artifact.baseRef !== review.baseRef || artifact.baseSha !== review.baseSha) throw new Error("Prepared review policy evidence is not bound to the existing review identity");
  const policy = artifact.current;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("Prepared review policy evidence has no current observation");
  return policy;
}

async function refreshPolicyArtifact(pi: ExtensionAPI, review: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reviewRoot = String(review.artifactRoot);
  loadPolicyArtifact(reviewRoot, review);
  const policyRoot = String(review.configRoot ?? review.sourceRoot);
  const result = await pi.exec("node", [helperPath(), "inspect-pr", "--repo", String(review.repository), "--pr", String(review.pullRequest), "--cwd", policyRoot], { timeout: 120_000 });
  let current: Record<string, unknown>;
  try {
    current = result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : { schema: "forgedock.candidate-pr-policy/v1", status: "unavailable", error: result.stderr.trim() || "policy collector returned no data" };
  } catch {
    current = { schema: "forgedock.candidate-pr-policy/v1", status: "malformed", error: result.stderr.trim() || "policy collector returned invalid JSON" };
  }
  const path = policyArtifactPath(reviewRoot);
  const artifact = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const updated = { ...artifact, current, refreshedAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  return current;
}

function requireGithubPolicyEvidence(policy: unknown, input: RecordInput, review: Record<string, unknown>): void {
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || (policy as Record<string, unknown>).schema !== "forgedock.candidate-pr-policy/v1") throw new Error("A staging PASS requires repository PR-policy evidence");
  const value = policy as Record<string, any>;
  const identity = value.identity;
  if (!identity || identity.head !== input.head || identity.baseRef !== input.baseRef || identity.baseSha !== input.baseSha || Number(value.pullRequest) !== input.pullRequest || value.repository !== input.repository) throw new Error("PR-policy evidence is not bound to the prepared frozen review");
  const requirements = value.policy?.requirements;
  const required = value.policy?.evaluatedRequiredChecks;
  if (requirements?.applicability === "unknown") throw new Error("Applicable GitHub check requirements are unknown; PASS is not safe");
  if (requirements?.applicability === "confirmed-none" && Array.isArray(required?.data) && required.data.length > 0) throw new Error("Policy evidence contradicts its confirmed-no-requirements classification");
  if (requirements?.applicability === "known-required-missing") throw new Error(`Required GitHub checks are missing: ${(requirements.missingRequiredNames ?? []).join(", ")}`);
  if (requirements?.applicability !== "confirmed-none" && (!required || required.status !== "available" || required.exitCode !== 0 || !Array.isArray(required.data) || required.data.length === 0)) throw new Error("Required GitHub check evidence is missing or empty; do not infer that no requirement exists");
  const failed = Array.isArray(required?.data) ? required.data.filter((row: unknown) => !row || typeof row !== "object" || !policyCheckPassed(row as Record<string, unknown>)) : [];
  if (requirements?.applicability !== "confirmed-none" && failed.length > 0) throw new Error(`Required GitHub checks are not all satisfied: ${failed.map((row: any) => String(row?.name ?? "unnamed check")).join(", ")}`);
  const configured = review.config && typeof review.config === "object" && !Array.isArray(review.config) ? (review.config as Record<string, any>).verificationCommands : undefined;
  const configuredNames = configured && typeof configured === "object" && !Array.isArray(configured) ? Object.keys(configured) : [];
  const localChecks = input.checks ?? [];
  const missingLocal = configuredNames.filter((name) => !localChecks.includes(name));
  if (missingLocal.length > 0) throw new Error(`Required local verification receipts are missing: ${missingLocal.join(", ")}`);
}

async function requirePassEvidence(input: RecordInput, review: Record<string, unknown>, policy: unknown): Promise<void> {
  const roles = Array.isArray(review.roles) ? review.roles.filter((role): role is string => typeof role === "string") : [];
  if (!roles.includes("correctness")) throw new Error("A staging PASS requires the correctness reviewer");
  const localChecks = input.checks ?? [];
  if (!Array.isArray(localChecks) || new Set(localChecks).size !== localChecks.length) throw new Error("A staging PASS requires unique completed check receipts");
  requireGithubPolicyEvidence(policy, input, review);
  for (const role of roles) {
    const report = join(resolve(input.reviewRoot as string), `${role}.report.md`);
    if (!existsSync(report) || realpathSync(report) !== report) throw new Error(`A staging PASS requires the ${role} reviewer report`);
    const reportText = readFileSync(report, "utf8");
    const marker = reportText.match(/^<!-- FORGE:REVIEWER_REPORT (\{.*\}) -->$/m);
    let identity: Record<string, unknown>;
    try { identity = marker?.[1] ? JSON.parse(marker[1]) as Record<string, unknown> : {}; } catch { identity = {}; }
    if (identity.repository !== input.repository || identity.pullRequest !== input.pullRequest || identity.head !== input.head || identity.baseRef !== input.baseRef || identity.baseSha !== input.baseSha || identity.role !== role || identity.reportId !== roleArtifactKey(review, role)) throw new Error(`Reviewer report for ${role} is not bound to the frozen role and authorization`);
  }
  for (const name of localChecks) {
    const receiptPath = join(resolve(input.reviewRoot as string), "checks", `${name}.json`);
    if (!existsSync(receiptPath) || realpathSync(receiptPath) !== receiptPath) throw new Error(`Missing completed check receipt: ${name}`);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    if (receipt.schema !== "forgedock.candidate-check/v1" || receipt.status !== "passed" || receipt.name !== name || receipt.head !== input.head || receipt.sourceRoot !== review.sourceRoot || receipt.configPath !== review.configPath || receipt.configSha256 !== review.configSha256) throw new Error(`Check receipt is not bound to the frozen review: ${name}`);
  }
}

async function tempArtifact(prefix: string, name: string, content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const file = join(root, name);
  await writeFile(file, content, { mode: 0o600 });
  return file;
}

async function failWithDiagnostic(prefix: string, detail: string): Promise<never> {
  const text = detail.trim() || "no diagnostic output";
  const diagnosticPath = await tempArtifact("forgedock-diagnostic-", "full.log", text);
  const preview = text.length > 1_600 ? `${text.slice(0, 1_600)}\n[full diagnostic saved outside model context]` : text;
  throw new Error(`${prefix}: ${preview}\nFull diagnostic: ${diagnosticPath}. Do not retry the unchanged request.`);
}

function worktreePaths(porcelain: string): string[] {
  return porcelain.split(/\n\n+/).map((entry) => entry.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length)).filter((path): path is string => typeof path === "string" && path.length > 0).map((path) => resolve(path));
}

async function reviewWorktreePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const result = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd, timeout: 20_000 });
  return result.code === 0 ? worktreePaths(result.stdout) : [];
}

async function resolveReviewSourceRoot(pi: ExtensionAPI, requestedRoot: string, head: string): Promise<{ sourceRoot: string; configRoot?: string }> {
  const requested = resolve(requestedRoot);
  const current = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: requested, timeout: 20_000 });
  if (current.code !== 0 || current.stdout.trim() === head) return { sourceRoot: requested };
  const paths = await reviewWorktreePaths(pi, requested);
  if (paths.length === 0) return { sourceRoot: requested };
  const matches: string[] = [];
  for (const actual of paths) {
    const revision = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: actual, timeout: 20_000 });
    if (revision.code !== 0 || revision.stdout.trim() !== head) continue;
    const status = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: actual, timeout: 20_000 });
    if (status.code === 0 && !status.stdout.trim()) matches.push(actual);
  }
  if (matches.length !== 1) throw new Error(matches.length > 1 ? `Review head ${head} has multiple clean worktrees; select one explicitly.` : `Review source checkout is not at ${head}; no clean exact-head worktree was found.`);
  return { sourceRoot: matches[0]!, ...(existsSync(join(requested, "forge.yaml")) ? { configRoot: requested } : {}) };
}

async function resolveReviewConfigRoot(pi: ExtensionAPI, requestedRoot: string, sourceRoot: string, configuredRoot?: string): Promise<string> {
  const requested = resolve(requestedRoot);
  const configured = configuredRoot ? resolve(configuredRoot) : undefined;
  if (configured && existsSync(join(configured, "forge.yaml"))) return configured;
  if (!configured && existsSync(join(requested, "forge.yaml"))) return requested;
  if (configured && configured !== sourceRoot) throw new Error(`Review config root ${configured} has no canonical forge.yaml.`);
  const reviewPaths = await reviewWorktreePaths(pi, sourceRoot);
  if (reviewPaths.length === 0) return configured ?? requested;
  const candidates = reviewPaths.filter((path) => path !== sourceRoot && !path.split(/[\\\\/]/).includes(".forge") && existsSync(join(path, "forge.yaml")));
  if (candidates.length === 1) return candidates[0]!;
  throw new Error(candidates.length > 1 ? "Multiple possible canonical forge.yaml worktrees found; provide configRoot explicitly." : "No canonical forge.yaml worktree found for the exact review source.");
}

async function existingGateForHead(pi: ExtensionAPI, repository: string, pullRequest: number, head: string, cwd: string): Promise<{ url: string; body: string } | undefined> {
  const result = await pi.exec("gh", ["api", "--paginate", "--slurp", `repos/${repository}/issues/${pullRequest}/comments`], { cwd, timeout: 120_000 });
  if (result.code !== 0) return undefined;
  try {
    const pages = JSON.parse(result.stdout);
    if (!Array.isArray(pages)) return undefined;
    let latest: { url: string; body: string } | undefined;
    for (const comment of pages.flatMap((page: unknown) => Array.isArray(page) ? page : [])) {
      const body = typeof comment?.body === "string" ? comment.body : "";
      const marker = body.split(/\r?\n/, 1)[0]?.match(/^<!-- FORGE:(?:CANDIDATE:)?STAGING_GATE (\{.*\}) -->$/);
      if (!marker) continue;
      const identity = JSON.parse(marker[1]);
      if ((identity.head === head || identity.source_head === head) && typeof comment.html_url === "string") latest = { url: comment.html_url, body };
    }
    return latest;
  } catch {
    return undefined;
  }
}

function configuredCommand(raw: unknown, name: string): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const commands = (raw as { verification?: { commands?: unknown } }).verification?.commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) return undefined;
  const direct = (commands as Record<string, unknown>)[name];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const [group, leaf] = name.split(".");
  const nested = group ? (commands as Record<string, unknown>)[group] : undefined;
  if (nested && typeof nested === "object" && !Array.isArray(nested) && leaf) {
    const value = (nested as Record<string, unknown>)[leaf];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Small child-safe mechanical tools used by the non-mutating staging route. */
export default function registerCandidateTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "forge_prepare_review",
    label: "Prepare frozen review",
    description: "Prepare a validated frozen review request in a disposable artifact directory.",
    parameters: REVIEW_INPUT,
    async execute(_toolCallId, params) {
      const input = params as ReviewInput;
      let resolvedInput: ReviewInput;
      try {
        const resolution = await resolveReviewSourceRoot(pi, input.sourceRoot, input.head);
        const configRoot = await resolveReviewConfigRoot(pi, input.sourceRoot, resolution.sourceRoot, input.configRoot ?? resolution.configRoot);
        resolvedInput = { ...input, sourceRoot: resolution.sourceRoot, configRoot };
      } catch (error) {
        throw await failWithDiagnostic("Review source preparation failed", error instanceof Error ? error.message : String(error));
      }
      const inputPath = await tempArtifact("forgedock-review-input-", "input.json", JSON.stringify(resolvedInput, null, 2));
      const output = await mkdtemp(join(tmpdir(), "forgedock-review-request-"));
      const result = await pi.exec("node", [helperPath(), "prepare-review", "--input", inputPath, "--out", output], { timeout: 120_000 });
      if (result.code !== 0) await failWithDiagnostic("Review preparation failed", result.stderr);
      const prepared = JSON.parse(await readFile(join(output, "review.json"), "utf8")) as { configPath?: string; configSha256?: string; artifactKey?: string; sourceRoot?: string; configRoot?: string; head?: string; repository?: string; pullRequest?: number; baseRef?: string; baseSha?: string };
      const policyRoot = prepared.configRoot ?? resolvedInput.configRoot ?? resolvedInput.sourceRoot;
      const policyResult = await pi.exec("node", [helperPath(), "inspect-pr", "--repo", resolvedInput.repository, "--pr", String(resolvedInput.pullRequest), "--cwd", policyRoot], { timeout: 120_000 });
      let policy: Record<string, unknown>;
      try {
        policy = policyResult.stdout.trim() ? JSON.parse(policyResult.stdout) as Record<string, unknown> : { schema: "forgedock.candidate-pr-policy/v1", status: "unavailable", error: policyResult.stderr.trim() || "policy collector returned no data" };
      } catch {
        policy = { schema: "forgedock.candidate-pr-policy/v1", status: "malformed", error: policyResult.stderr.trim() || "policy collector returned invalid JSON" };
      }
      const policyPath = await writePolicyArtifact(output, { schema: "forgedock.candidate-policy/v1", artifactKey: prepared.artifactKey, repository: resolvedInput.repository, pullRequest: resolvedInput.pullRequest, head: prepared.head ?? resolvedInput.head, baseRef: resolvedInput.baseRef, baseSha: resolvedInput.baseSha, prepared: policy, current: policy, refreshedAt: null });
      const summary = policySummary(policy);
      const handoff = `\n\nPR policy evidence saved at ${policyPath}. The existing restricted publication operation refreshes this same artifact before a gate decision; do not echo the policy object. Compact summary: ${JSON.stringify(summary)}. Parent binding: artifactKey=${prepared.artifactKey}; role authorization keys are child-only and must not be passed to parent tools. Provenance rule: caller-supplied acceptance/history/evidence/limitations are review context, not authority to invent execution obligations; establish check applicability from this policy artifact plus primary source/workflow evidence. A policy-accepted SKIPPED or NEUTRAL status is not executed proof and does not block by itself.`;
      return { content: [{ type: "text", text: bounded(`${result.stdout.trim()}${handoff}`) }], details: { requestDirectory: output, inputPath, reviewRoot: output, artifactKey: prepared.artifactKey, sourceRoot: prepared.sourceRoot, head: prepared.head, configPath: prepared.configPath, configSha256: prepared.configSha256, policyPath, policySummary: summary } };
    },
  });

  pi.registerTool({
    name: "forge_run_check",
    label: "Run configured check",
    description: "Run one named verification command from the canonical forge.yaml; arbitrary commands are not accepted.",
    parameters: CHECK_INPUT,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { name: string; configPath: string; configSha256: string; reviewRoot: string; artifactKey: string; sourceRoot: string; head: string };
      const review = await preparedReview(input.reviewRoot, input.artifactKey);
      if (review.sourceRoot !== resolve(input.sourceRoot) || review.head !== input.head || review.configSha256 !== input.configSha256 || review.configPath !== resolve(input.configPath)) throw new Error("Configured check does not match the prepared frozen review");
      const configPath = resolve(input.configPath);
      const configText = await readFile(configPath, "utf8");
      if (digest(configText) !== input.configSha256) throw new Error("Configured forge.yaml changed after review preparation");
      const sourceHead = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: resolve(input.sourceRoot), timeout: 20_000 });
      if (sourceHead.code !== 0 || sourceHead.stdout.trim() !== input.head) throw new Error("Configured check source checkout moved after review preparation");
      const name = input.name;
      const config = parseYaml(configText);
      const command = configuredCommand(config, name);
      if (!command) throw new Error(`No configured verification command named '${name}'`);
      if (forbiddenStagingCheck(command)) throw new Error(`Configured check '${name}' is not a read-only verification command`);
      const before = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: resolve(input.sourceRoot), timeout: 20_000 });
      if (before.code !== 0 || before.stdout.trim()) throw new Error("Configured checks require a clean frozen source checkout");
      const result = await pi.exec("sh", ["-lc", command], { cwd: resolve(input.sourceRoot), timeout: 1_200_000 });
      const after = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: resolve(input.sourceRoot), timeout: 20_000 });
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
      if (after.code !== 0 || after.stdout.trim()) throw new Error(`Configured check '${name}' changed the frozen source checkout`);
      if (result.code !== 0) await failWithDiagnostic(`Configured check '${name}' failed`, output);
      const receiptPath = await writeCheckReceipt(input.reviewRoot, { schema: "forgedock.candidate-check/v1", name, status: "passed", sourceRoot: resolve(input.sourceRoot), head: input.head, configPath, configSha256: input.configSha256 });
      return { content: [{ type: "text", text: bounded(output || `${name}: passed`) }], details: { name, command, exitCode: result.code, receiptPath } };
    },
  });

  pi.registerTool({
    name: "forge_discover_review_records",
    label: "Discover prior review records",
    description: "Read the bounded prior review records for this PR so the parent can carry applicable concerns into the current attempt.",
    parameters: Type.Object({
      repository: REPOSITORY,
      pullRequest: Type.Integer({ minimum: 1 }),
      cwd: Type.String({ minLength: 1 }),
      reviewRoot: Type.Optional(Type.String({ minLength: 1 })),
      artifactKey: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolCallId, params) {
      const input = params as { repository: string; pullRequest: number; cwd: string; reviewRoot?: string; artifactKey?: string };
      if ((input.reviewRoot === undefined) !== (input.artifactKey === undefined)) throw new Error("Prior review discovery needs both reviewRoot and artifactKey when bound to a prepared review");
      if (input.reviewRoot) await preparedReview(input.reviewRoot, input.artifactKey!);
      const root = input.reviewRoot ? resolve(input.reviewRoot) : undefined;
      const digest = createHash("sha256").update(`${input.repository}:${input.pullRequest}`).digest("hex").slice(0, 12);
      const sourcePath = root ? join(root, `review-history-source-${digest}.json`) : undefined;
      const fullPath = root ? join(root, `review-history-${digest}.json`) : undefined;
      const historyIndexPath: string | null = fullPath ?? null;
      const args = [helperPath(), "discover", "--repo", input.repository, "--pr", String(input.pullRequest), "--cwd", resolve(input.cwd)];
      if (sourcePath) args.push("--out", sourcePath);
      const result = await pi.exec("node", args, { timeout: 120_000 });
      if (result.code !== 0) throw new Error(`Prior review discovery failed: ${bounded(result.stderr)}`);
      let raw: Record<string, any>;
      try { raw = JSON.parse(result.stdout) as Record<string, any>; } catch { throw new Error("Prior review discovery returned invalid JSON"); }
      const rawRecords = Array.isArray(raw.records) ? raw.records : [];
      const compactRecord = (record: any) => {
        const metadata = record.metadata ?? {};
        const review = metadata.review ?? {};
        return { id: record.id, url: record.url, createdAt: record.createdAt, kind: record.kind, sourceHead: metadata.source_head ?? metadata.head ?? null, baseRef: review.base_ref ?? metadata.baseRef ?? null, baseSha: review.base_sha ?? metadata.baseSha ?? null, mode: review.mode ?? metadata.mode ?? null, reviewAttempt: metadata.review_attempt ?? metadata.reportId ?? null, supersedes: metadata.supersedes ?? null };
      };
      const allCompactRecords = rawRecords.map(compactRecord);
      const displayedRecords = allCompactRecords.length <= 24 ? allCompactRecords : [...allCompactRecords.slice(0, 12), ...allCompactRecords.slice(-12)];
      const summary = { schema: "forgedock.candidate-review-history-index/v1", repository: input.repository, pullRequest: input.pullRequest, historyIndexPath, sourceArtifactPath: sourcePath, completeness: { totalComments: raw.commentCount ?? null, totalRecords: raw.recordCount ?? rawRecords.length, unclassifiedRecords: Array.isArray(raw.unclassifiedComments) ? raw.unclassifiedComments.length : null, displayedRecords: displayedRecords.length }, records: displayedRecords };
      if (!root || !fullPath) return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], details: { repository: input.repository, pullRequest: input.pullRequest, historyIndexPath, sourceArtifactPath: sourcePath, recordCount: rawRecords.length, displayedRecords: displayedRecords.length } };
      const historyDir = join(root, `review-history-${digest}`);
      await mkdir(historyDir, { recursive: true, mode: 0o700 });
      const records = await Promise.all(rawRecords.map(async (record: any) => {
        const bodyPath = join(historyDir, `comment-${String(record.id)}.md`);
        await writeFile(bodyPath, `${typeof record.body === "string" ? record.body : ""}`, { flag: "wx", mode: 0o600 }).catch(async (error) => { if (await readFile(bodyPath, "utf8") !== String(record.body ?? "")) throw error; });
        return { id: record.id, url: record.url, createdAt: record.createdAt, kind: record.kind, record: compactRecord(record), bodyPath };
      }));
      const index = { schema: "forgedock.candidate-review-history-index/v1", repository: input.repository, pullRequest: input.pullRequest, artifactKey: input.artifactKey, completeness: { totalComments: raw.commentCount ?? null, totalRecords: raw.recordCount ?? records.length, unclassifiedRecords: Array.isArray(raw.unclassifiedComments) ? raw.unclassifiedComments.length : null }, records };
      await stableJsonFile(fullPath, index);
      return { content: [{ type: "text", text: JSON.stringify({ ...summary, historyIndexPath: fullPath, sourceArtifactPath: sourcePath }, null, 2) }], details: { repository: input.repository, pullRequest: input.pullRequest, historyIndexPath: fullPath, sourceArtifactPath: sourcePath, recordCount: records.length, displayedRecords: displayedRecords.length } };
    },
  });

  pi.registerTool({
    name: "forge_resolve_review_tracking",
    label: "Resolve review tracking",
    description: "Search all target-repository issues, including closed issues, for plausible or exact causal tracking before the parent publishes a follow-up.",
    parameters: TRACKING_SEARCH_INPUT,
    async execute(_toolCallId, params) {
      const input = params as { repository: string; pullRequest: number; head: string; concernId: string; draft: Record<string, unknown>; reviewRoot: string; artifactKey: string };
      const review = await preparedReview(input.reviewRoot, input.artifactKey);
      if (review.repository !== input.repository || review.pullRequest !== input.pullRequest || review.head !== input.head) throw new Error("Tracking search does not match the prepared frozen review");
      const concern = input.concernId.replace(/[^A-Za-z0-9_.-]/g, "-");
      const inputPath = join(resolve(input.reviewRoot), `tracking-search-${concern}-${digest(JSON.stringify(input)).slice(0, 12)}.json`);
      await stableJsonFile(inputPath, input);
      const result = await pi.exec("node", [helperPath(), "review-issues", "--input", inputPath, "--cwd", String(review.configRoot ?? review.sourceRoot)], { timeout: 120_000 });
      if (result.code !== 0) throw new Error(`Review tracking search failed: ${bounded(result.stderr)}`);
      return { content: [{ type: "text", text: bounded(result.stdout) }], details: { inputPath } };
    },
  });

  pi.registerTool({
    name: "forge_recover_reviewer_publication",
    label: "Recover one reviewer report",
    description: "Make at most one parent-side publication attempt from an existing, exact-run reviewer recovery input; it cannot launch or resume a reviewer.",
    parameters: REVIEW_RECOVERY_INPUT,
    async execute(_toolCallId, params) {
      const input = params as { repository: string; pullRequest: number; head: string; baseRef: string; baseSha: string; reviewRoot: string; artifactKey: string; role: string; nativeRunId: string; nativeTerminal: string };
      const root = resolve(input.reviewRoot);
      const review = await preparedReview(root, input.artifactKey);
      if (review.repository !== input.repository || review.pullRequest !== input.pullRequest || review.head !== input.head || review.baseRef !== input.baseRef || review.baseSha !== input.baseSha || typeof review.publish !== "boolean") throw new Error("Reviewer recovery does not match the prepared frozen review");
      if (!reviewRoles(review).includes(input.role)) throw new Error("Reviewer recovery role was not selected for this prepared review");
      const expectedRoleKey = roleArtifactKey(review, input.role);
      const authorizationPath = join(root, `${input.role}.authorization.json`);
      if (!existsSync(authorizationPath) || realpathSync(authorizationPath) !== authorizationPath) throw new Error("Prepared role authorization is missing or not a regular file");
      const authorization = JSON.parse(await readFile(authorizationPath, "utf8")) as Record<string, unknown>;
      const recoveryPath = join(root, `${input.role}.publication-recovery.json`);
      if (!existsSync(recoveryPath) || realpathSync(recoveryPath) !== recoveryPath) throw new Error(`No role-bound publication recovery input exists for ${input.role}`);
      const recovery = JSON.parse(await readFile(recoveryPath, "utf8")) as Record<string, unknown>;
      const bodyPath = join(root, `${input.role}.body.md`);
      const reportPath = join(root, `${input.role}.report.md`);
      const observationsPath = join(root, `${input.role}.observations.json`);
      const expected = recovery.schema === "forgedock.candidate-review-publication-recovery/v1" && recovery.repository === input.repository && recovery.pullRequest === input.pullRequest && recovery.head === input.head && recovery.baseRef === input.baseRef && recovery.baseSha === input.baseSha && recovery.role === input.role && recovery.reviewArtifactKey === input.artifactKey && recovery.roleArtifactKey === expectedRoleKey && recovery.roleArtifactKey === authorization.artifactKey && authorization.schema === "forgedock.candidate-review-role/v1" && authorization.artifactRoot === root && authorization.artifactKey === expectedRoleKey && authorization.role === input.role && authorization.repository === input.repository && authorization.pullRequest === input.pullRequest && authorization.head === input.head && authorization.baseRef === input.baseRef && authorization.baseSha === input.baseSha && authorization.publish === review.publish && recovery.nativeRunId === input.nativeRunId && recovery.bodyPath === bodyPath && recovery.reportPath === reportPath && recovery.observationsPath === observationsPath && recovery.publish === review.publish;
      if (!expected) throw new Error("Reviewer recovery input does not match the exact prepared role, frozen head/base, report destinations, or native run identity");
      const executionResult = await verifiedReviewerExecutionResult(root, review, input.role);
      const claimPath = join(root, `${input.role}.publication-recovery.lock`);
      const claimExists = existsSync(claimPath);
      const recoveryStarted = claimExists || Number(recovery.recoveryAttempts) > 0 || ["publication-attempted", "recovery-attempted", "recovery-unresolved", "recovery-failed"].includes(String(recovery.state));
      const canStartRecovery = recovery.state === "recovery-available" && recovery.recoveryAttempts === 0 && !recoveryStarted && input.nativeTerminal === "completed" && executionResult?.nativeRunId === input.nativeRunId && executionResult.nativeStatus === "completed";
      if (!canStartRecovery) {
        const readback = await verifyReviewerReportDelivery(pi, review, root, input.role, recovery);
        if (readback.outcome === "published" || readback.outcome === "saved") {
          const latest = JSON.parse(await readFile(recoveryPath, "utf8")) as Record<string, unknown>;
          const finalized = { ...latest, state: "recovered", publication: readback.outcome, recoveryReadbackAt: new Date().toISOString(), recoveryReadback: { outcome: readback.outcome, reportId: readback.reportId, url: readback.url ?? null, authoredEvidence: readback.authoredEvidence } };
          await atomicallyReplaceJson(recoveryPath, finalized);
          return { content: [{ type: "text", text: `Readback verified ${input.role} report delivery for native run ${input.nativeRunId}; no publisher was invoked during finalization. ${readback.url ?? readback.reportPath}` }], details: { role: input.role, nativeRunId: input.nativeRunId, recoveryPath, reportPath: readback.reportPath, publication: readback.outcome, deliveryVerified: true, authoredEvidence: readback.authoredEvidence, operationState: "finalized", repeated: true, recovered: true, error: null as string | null } };
        }
        return { content: [{ type: "text", text: `No second publication attempt was made for ${input.role}. Readback is ${readback.outcome}; the original claim/outcome remains ${String(recovery.state)} and is not treated as exhausted or cancelled. ${readback.error ?? ""}` }], details: { role: input.role, nativeRunId: input.nativeRunId, recoveryPath, reportPath: readback.reportPath, publication: "unverified", deliveryVerified: false, authoredEvidence: readback.authoredEvidence, operationState: claimExists ? "claimed-or-active" : String(recovery.state), repeated: true, recovered: false, error: readback.error ?? null } };
      }
      if (typeof recovery.body !== "string" || recovery.body.trim().length < 32 || !Array.isArray(recovery.observations)) throw new Error("Reviewer recovery input has no complete authored body and observations");
      const body = `${recovery.body.trim()}\n`;
      const observations = `${JSON.stringify(recovery.observations, null, 2)}\n`;
      if (digest(body) !== recovery.bodySha256 || digest(observations) !== recovery.observationsSha256) throw new Error("Reviewer recovery input failed its authored-content digest check");
      await stableTextArtifact(bodyPath, body);
      await stableTextArtifact(observationsPath, observations);
      try { await mkdir(claimPath, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const readback = await verifyReviewerReportDelivery(pi, review, root, input.role, recovery);
          return { content: [{ type: "text", text: `Another exact-run recovery claim exists; no second publisher was invoked. Readback is ${readback.outcome}. ${readback.error ?? ""}` }], details: { role: input.role, nativeRunId: input.nativeRunId, recoveryPath, reportPath: readback.reportPath, publication: readback.outcome === "published" ? "published" : "unverified", deliveryVerified: readback.outcome === "published", authoredEvidence: readback.authoredEvidence, operationState: "claimed-or-active", repeated: true, recovered: readback.outcome === "published", error: readback.error ?? null } };
        }
        throw error;
      }
      const attempted = { ...recovery, state: "recovery-attempted", recoveryAttempts: 1, recoveryClaimedAt: new Date().toISOString() };
      await atomicallyReplaceJson(recoveryPath, attempted);
      const args = [helperPath(), "record", "reviewer", "--repo", input.repository, "--pr", String(input.pullRequest), "--head", input.head, "--base-ref", input.baseRef, "--base-sha", input.baseSha, "--role", input.role, "--report-id", String(authorization.artifactKey), "--body-file", bodyPath, "--report-file", reportPath, "--observations-file", observationsPath, "--cwd", String(review.configRoot ?? review.sourceRoot)];
      if (review.publish) args.push("--publish");
      let publisherError: string | undefined;
      let publisherOutput = "";
      try {
        const result = await pi.exec("node", args, { timeout: 120_000 });
        publisherOutput = result.stdout.trim();
        if (result.code !== 0) publisherError = result.stderr.trim().slice(-500) || `helper exited ${result.code}`;
      } catch (error) {
        publisherError = error instanceof Error ? error.message : String(error);
      }
      const readback = await verifyReviewerReportDelivery(pi, review, root, input.role, attempted);
      if (readback.outcome === "published" || readback.outcome === "saved") {
        const latest = JSON.parse(await readFile(recoveryPath, "utf8")) as Record<string, unknown>;
        const recovered = { ...latest, state: "recovered", recoveryAttempts: 1, publication: readback.outcome, publicationResult: publisherOutput, recoveryReadbackAt: new Date().toISOString(), recoveryReadback: { outcome: readback.outcome, reportId: readback.reportId, url: readback.url ?? null, authoredEvidence: readback.authoredEvidence } };
        await atomicallyReplaceJson(recoveryPath, recovered);
        return { content: [{ type: "text", text: `Recovered and read back ${input.role} report for native run ${input.nativeRunId}; no additional publisher attempt will be made. ${readback.url ?? publisherOutput}` }], details: { role: input.role, nativeRunId: input.nativeRunId, recoveryPath, reportPath: readback.reportPath, publication: readback.outcome, deliveryVerified: true, authoredEvidence: readback.authoredEvidence, operationState: "finalized", repeated: false, recovered: true, error: publisherError ?? null } };
      }
      const latest = JSON.parse(await readFile(recoveryPath, "utf8")) as Record<string, unknown>;
      const unresolved = { ...latest, state: "recovery-unresolved", recoveryAttempts: 1, recoveryError: publisherError ?? readback.error ?? "report delivery was not verified", recoveryReadbackAt: new Date().toISOString(), recoveryReadback: { outcome: readback.outcome, reportId: readback.reportId ?? null, url: readback.url ?? null, authoredEvidence: readback.authoredEvidence } };
      await atomicallyReplaceJson(recoveryPath, unresolved);
      return { content: [{ type: "text", text: `The single authorized ${input.role} recovery operation returned without verified delivery. No reviewer or publisher will be retried. Record honest incompleteness and preserve the claim for readback. ${publisherError ?? readback.error ?? ""}` }], details: { role: input.role, nativeRunId: input.nativeRunId, recoveryPath, reportPath: readback.reportPath, publication: "unverified", deliveryVerified: false, authoredEvidence: readback.authoredEvidence, operationState: "recovery-unresolved", repeated: false, recovered: false, error: publisherError ?? readback.error ?? null } };
    },
  });

  pi.registerTool({
    name: "forge_publish_incomplete_review",
    label: "Record incomplete review",
    description: "Publish a truthful GATED delivery record when a selected reviewer report is absent or its publication remains unverified after permitted recovery; it is not a verdict or pre-review infrastructure classification.",
    parameters: INCOMPLETE_REVIEW_INPUT,
    async execute(_toolCallId, params) {
      const input = params as { repository: string; pullRequest: number; head: string; baseRef: string; baseSha: string; reviewRoot: string; artifactKey: string; role: string; nativeRunId?: string; nativeTerminal: string; deliveryError: string; recoveryBlocker?: "execution-limit"; blockerEvidence?: string; publish: boolean };
      const root = resolve(input.reviewRoot);
      const review = await preparedReview(root, input.artifactKey);
      if (review.repository !== input.repository || review.pullRequest !== input.pullRequest || review.head !== input.head || review.baseRef !== input.baseRef || review.baseSha !== input.baseSha || review.publish !== input.publish) throw new Error("Incomplete-review record does not match the prepared frozen review");
      if (!reviewRoles(review).includes(input.role)) throw new Error("Incomplete-review role was not selected for this prepared review");
      const reportPath = join(root, `${input.role}.report.md`);
      const recoveryPath = join(root, `${input.role}.publication-recovery.json`);
      let recovery: Record<string, unknown> | undefined;
      let recoveryProblem: string | undefined;
      if (existsSync(recoveryPath)) {
        try {
          if (realpathSync(recoveryPath) !== recoveryPath) throw new Error("recovery evidence path is not a regular file");
          recovery = JSON.parse(await readFile(recoveryPath, "utf8")) as Record<string, unknown>;
          if (recovery.schema !== "forgedock.candidate-review-publication-recovery/v1" || recovery.reviewArtifactKey !== input.artifactKey || recovery.roleArtifactKey !== roleArtifactKey(review, input.role) || recovery.repository !== input.repository || recovery.pullRequest !== input.pullRequest || recovery.head !== input.head || recovery.baseRef !== input.baseRef || recovery.baseSha !== input.baseSha || recovery.role !== input.role || recovery.publish !== review.publish || typeof recovery.nativeRunId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(recovery.nativeRunId) || (input.nativeRunId !== undefined && recovery.nativeRunId !== input.nativeRunId)) throw new Error("recovery evidence does not match the prepared role/run identity");
        } catch (error) {
          recoveryProblem = error instanceof Error ? error.message : String(error);
          recovery = undefined;
        }
      }
      const authorizationPath = join(root, `${input.role}.authorization.json`);
      let authorizedRole = false;
      try {
        const authorization = JSON.parse(await readFile(authorizationPath, "utf8")) as Record<string, unknown>;
        authorizedRole = realpathSync(authorizationPath) === authorizationPath && authorization.schema === "forgedock.candidate-review-role/v1" && authorization.artifactRoot === root && authorization.artifactKey === roleArtifactKey(review, input.role) && authorization.role === input.role && authorization.repository === input.repository && authorization.pullRequest === input.pullRequest && authorization.head === input.head && authorization.baseRef === input.baseRef && authorization.baseSha === input.baseSha && authorization.publish === review.publish;
      } catch { authorizedRole = false; }
      const executionReceiptPath = join(root, "reviewer-execution.json");
      const executionReceiptPresent = existsSync(executionReceiptPath);
      const executionResult = await verifiedReviewerExecutionResult(root, review, input.role);
      if (executionReceiptPresent && !executionResult) throw new Error("Reviewer execution receipt is present but does not match the prepared frozen role/run or launch claim");
      if (!executionResult && recovery !== undefined && !verifiedReviewerLaunchClaim(root, review)) throw new Error("Reviewer publication recovery input has no matching prepared panel-launch claim");
      const reportIdentity = reviewerReportIdentity(reportPath);
      if (!executionResult && recovery === undefined) throw new Error("Incomplete-review GATED record requires a completed per-role native execution receipt or exact role-bound publication recovery input; preparation, launch claims, or local reports alone are pre-review");
      if (executionResult && recovery && executionResult.nativeRunId !== null && executionResult.nativeRunId !== recovery.nativeRunId) throw new Error("Native execution and reviewer publication evidence disagree on the role run identity");
      const evidencedRunId = executionResult ? executionResult.nativeRunId : recovery?.nativeRunId;
      if (input.nativeRunId !== undefined && input.nativeRunId !== evidencedRunId) throw new Error("Incomplete-review native run ID does not match durable role execution/publication evidence");
      const nativeRunId = typeof evidencedRunId === "string" ? evidencedRunId : undefined;
      if (executionResult ? input.nativeTerminal !== executionResult.nativeStatus : input.nativeTerminal !== "unknown") throw new Error("Incomplete-review native terminal state must match the durable role execution receipt or be unknown when no receipt exists");
      const claimPath = join(root, `${input.role}.publication-recovery.lock`);
      const claimExists = existsSync(claimPath);
      if (Boolean(input.recoveryBlocker) !== Boolean(input.blockerEvidence)) throw new Error("A recovery blocker requires specific evidence, and blocker evidence requires a blocker classification");
      const recoveryBody = recovery && typeof recovery.body === "string" ? `${recovery.body.trim()}\n` : "";
      const recoveryObservations = recovery && Array.isArray(recovery.observations) ? `${JSON.stringify(recovery.observations, null, 2)}\n` : "";
      const recoveryContentValid = Boolean(recoveryBody && recoveryObservations && digest(recoveryBody) === recovery?.bodySha256 && digest(recoveryObservations) === recovery?.observationsSha256);
      const recoveryAvailable = authorizedRole && recovery !== undefined && executionResult?.nativeStatus === "completed" && nativeRunId !== undefined && recovery.nativeRunId === nativeRunId && recovery.state === "recovery-available" && recovery.recoveryAttempts === 0 && !claimExists && recoveryContentValid;
      if (recoveryAvailable && !input.recoveryBlocker) throw new Error(`The exact completed ${input.role} role has authorized unused recovery; use forge_recover_reviewer_publication before recording GATED delivery`);
      const readback = await verifyReviewerReportDelivery(pi, review, root, input.role, recovery);
      if (readback.outcome === "published" || readback.outcome === "saved") throw new Error(`The ${input.role} report delivery is verified; do not record incomplete review delivery`);
      if (input.recoveryBlocker && !recoveryAvailable) throw new Error("A recovery blocker may be recorded only while the exact authorized recovery remains available");
      const identity = reportIdentity;
      const savedButUndelivered = Boolean(identity && readback.authoredEvidence === "verified" && readback.outcome !== "invalid" && readback.outcome !== "missing");
      const reportEvidence = savedButUndelivered
        ? `- ${input.role}: canonical role-bound report saved at \`${reportPath}\` (reportId=\`${String(identity?.reportId)}\`); published readback is ${readback.outcome}`
        : readback.outcome === "invalid"
          ? `- ${input.role}: local report/evidence is preserved but did not pass content/identity verification (${readback.error ?? "unspecified mismatch"}); it is not counted as an authored report`
          : `- ${input.role}: no verified report delivery at \`${reportPath}\`; readback=${readback.outcome}${readback.error ? ` (${sanitizedOneLine(readback.error)})` : ""}`;
      const roleStatus = reviewRoles(review).map((role) => {
        if (role === input.role) return reportEvidence;
        const otherPath = join(root, `${role}.report.md`);
        const other = reviewerReportIdentity(otherPath);
        if (!other) return `- ${role}: required report missing at \`${otherPath}\``;
        if (other.repository !== input.repository || other.pullRequest !== input.pullRequest || other.head !== input.head || other.baseRef !== input.baseRef || other.baseSha !== input.baseSha || other.role !== role || other.reportId !== roleArtifactKey(review, role)) return `- ${role}: report file preserved but identity/content has not been verified at \`${otherPath}\``;
        return `- ${role}: prepared role-bound report saved at \`${otherPath}\` (reportId=\`${String(other.reportId)}\`); delivery is not adjudicated by this record`;
      }).join("\n");
      const runLabel = nativeRunId ?? "(native run id unavailable)";
      const unresolvedClaim = claimExists || ["publication-attempted", "recovery-attempted", "recovery-unresolved", "recovery-failed"].includes(String(recovery?.state));
      const claimState = unresolvedClaim ? "A durable recovery claim exists or a publisher operation was recorded; its result is unresolved. This record does not clear the claim or call the attempt exhausted." : recoveryProblem ? `Recovery evidence is unavailable or misbound (${sanitizedOneLine(recoveryProblem)}); no recovery attempt was started.` : recoveryAvailable ? `One exact role-only recovery remains authorized and unconsumed (attempts=${String(recovery?.recoveryAttempts)}); parent reported this execution limit: ${sanitizedOneLine(input.blockerEvidence ?? "")}.` : input.nativeTerminal === "completed" ? "No currently authorized exact-run recovery input is available." : `Native role result is ${input.nativeTerminal}; recovery is not permitted until an exact completed native run is established.`;
      const nextPrerequisite = unresolvedClaim
        ? "Use exact-run readback/finalization only. Do not clear the claim, retry publication, resume, or relaunch the reviewer. If delivery becomes verified, complete adjudication and supersede this GATED record."
        : recoveryAvailable
          ? "The bounded role-only recovery remains available but was not attempted because of the reported execution limit. Resolve that limit, then use the same exact run; do not rerun the panel."
          : input.nativeTerminal !== "completed" || !nativeRunId
            ? "Establish the exact native run's terminal outcome or obtain explicit operator authorization; do not invent a run id or rerun the panel."
            : "A role authorization or valid authored recovery input is unavailable; preserve evidence and obtain operator resolution without rerunning the reviewer.";
      const error = sanitizedOneLine(input.deliveryError);
      const body = [
        "## Review report delivery incomplete (not a verdict)",
        "",
        `**Pull request**: #${input.pullRequest} in ${input.repository}`,
        `**Frozen source**: \`${input.head}\``,
        `**Frozen base**: \`${input.baseRef}\` at \`${input.baseSha}\``,
        `**Native reviewer result**: ${input.nativeTerminal}; run ${runLabel}`,
        "",
        "### Per-role delivery",
        roleStatus,
        "",
        claimState,
        savedButUndelivered && recovery ? `Authored body and observations passed recorded SHA-256 checks in \`${recoveryPath}\` (body=${recovery.bodySha256}; observations=${recovery.observationsSha256}).` : `Authored body/observation verification: ${readback.authoredEvidence}${recoveryProblem ? `; sidecar issue: ${sanitizedOneLine(recoveryProblem)}` : ""}.`,
        `Last reported delivery error: ${error || "(none supplied)"}.`,
        nextPrerequisite,
        "",
        "No parent adjudication, approval, gate PASS/FAIL, issue, or code-defect finding is claimed by this record. It records post-review delivery state only, is not a pre-review infrastructure failure, and never clears merge authorization or starts another reviewer.",
      ].join("\n");
      const deliveryKey = nativeRunId ?? "run-unavailable";
      const bodyPath = join(root, `review-delivery-incomplete-${input.role}-${digest(deliveryKey).slice(0, 12)}.md`);
      const gatedReportPath = join(root, `review-delivery-incomplete-${input.role}-${digest(deliveryKey).slice(0, 12)}.record.md`);
      const receiptPath = join(root, `review-delivery-incomplete-${input.role}-${digest(deliveryKey).slice(0, 12)}.receipt.json`);
      await stableTextArtifact(bodyPath, `${body}\n`);
      const args = [helperPath(), "record", "--kind", "GATED", "--repo", input.repository, "--pr", String(input.pullRequest), "--head", input.head, "--body-file", bodyPath, "--report-file", gatedReportPath, "--cwd", String(review.configRoot ?? review.sourceRoot)];
      if (input.publish) args.push("--publish");
      const result = await pi.exec("node", args, { timeout: 120_000 });
      if (result.code !== 0) throw new Error(`Incomplete-review GATED record failed: ${bounded(result.stderr)}`);
      let publication: Record<string, unknown> = {};
      try { publication = JSON.parse(result.stdout) as Record<string, unknown>; } catch { /* output remains model-visible */ }
      if (publication.publication === "published" && typeof publication.url === "string") await stableJsonFile(receiptPath, { schema: "forgedock.candidate-review-delivery-receipt/v1", repository: input.repository, pullRequest: input.pullRequest, head: input.head, baseRef: input.baseRef, baseSha: input.baseSha, role: input.role, nativeRunId: nativeRunId ?? null, artifactKey: input.artifactKey, recordUrl: publication.url, recordId: publication.recordId ?? null, deliveryState: readback.outcome, recoveryState: recovery?.state ?? (claimExists ? "claim-unresolved" : "unavailable") });
      return { content: [{ type: "text", text: bounded(result.stdout) }], details: { role: input.role, nativeRunId: nativeRunId ?? null, reportPath, bodyPath, recordPath: gatedReportPath, receiptPath: publication.publication === "published" ? receiptPath : null, recordKind: "GATED", adjudicationPublished: false, deliveryState: readback.outcome, recoveryState: recovery?.state ?? (claimExists ? "claim-unresolved" : "unavailable"), recordUrl: publication.url ?? null, publication: input.publish ? "published" : "saved" } };
    },
  });

  pi.registerTool({
    name: "forge_publish_adjudication",
    label: "Publish parent adjudication",
    description: "Validate every current reviewer observation and publish one parent REVIEW-PANEL decision. decisions maps current reviewer observations; historicalDecisions is the only model-facing representation of prior concerns and must contain an explicit sourceReference, disposition, rationale, evidence, stage, and applicable tracking for each concern. Use historicalDecisions: [] when there are none. A rejected historical allegation still requires an explicit rejection record; do not pass legacy prose priorConcerns.",
    parameters: ADJUDICATION_INPUT,
    async execute(_toolCallId, params) {
      const input = params as Record<string, unknown>;
      const review = await preparedReview(String(input.reviewRoot), String(input.artifactKey));
      if (review.repository !== input.repository || review.pullRequest !== input.pullRequest || review.head !== input.head || review.baseRef !== input.baseRef || review.baseSha !== input.baseSha || review.publish !== input.publish) throw new Error("Adjudication does not match the prepared frozen review");
      if (input.mode !== preparedReviewMode(review)) throw new Error("Adjudication mode does not match the route derived from the prepared review base");
      await requireReviewerReports(pi, review, input);
      const revision = Number(input.revision ?? 0);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Adjudication revision must be a non-negative integer");
      const supersededIncomplete = await publishedIncompleteDeliverySupersedes(resolve(String(input.reviewRoot)), review);
      if (supersededIncomplete && input.supersedes !== undefined && input.supersedes !== supersededIncomplete) throw new Error("Adjudication must supersede the published incomplete-delivery record from this prepared review");
      const effectiveInput = supersededIncomplete ? { ...input, supersedes: supersededIncomplete } : input;
      const inputPath = await revisionedJsonFile(resolve(String(input.reviewRoot)), "adjudication-input", revision, effectiveInput);
      const result = await pi.exec("node", [helperPath(), "record", "adjudication", "--input", inputPath, "--cwd", String(review.configRoot ?? review.sourceRoot)], { timeout: 120_000 });
      if (result.code !== 0) throw new Error(`Parent adjudication failed: ${bounded(result.stderr)}`);
      const output = result.stdout.trim();
      let details: Record<string, unknown> = {};
      try { details = JSON.parse(output) as Record<string, unknown>; } catch { /* bounded text remains model-visible */ }
      const terminal = details.publication === "published" || details.publication === "saved" ? "ADJUDICATION_RESULT: terminal publication returned; do not repeat the unchanged revision. Use a new revision only for a real decision change." : "";
      return { content: [{ type: "text", text: bounded(`${output}${terminal ? `\n${terminal}` : ""}`) }], details: { ...details, inputPath } };
    },
  });

  pi.registerTool({
    name: "forge_publish_record",
    label: "Publish candidate record",
    description: "Refresh the bound PR policy, then save and optionally publish one file-backed candidate gate record without changing source.",
    parameters: RECORD_INPUT,
    async execute(_toolCallId, params) {
      const input = params as RecordInput;
      if ((input.issue === undefined) === (input.pullRequest === undefined)) throw new Error("Record needs exactly one issue or pull request destination");
      if (input.kind !== "STAGING_GATE") throw new Error("The staging publication tool only publishes STAGING_GATE records");
      if (input.gate === "PASS" && !input.adjudicationPath) throw new Error("PASS requires the completed parent adjudication artifact");
      if (input.gate === "FAIL" && !input.adjudicationPath && input.preReviewInfrastructure !== true) throw new Error("A completed review gate requires parent adjudication; mark only a pre-review infrastructure failure explicitly");
      if (!input.reviewRoot || !input.artifactKey || !input.head || !input.baseRef || !input.baseSha || !input.gate || input.pullRequest === undefined) throw new Error("Staging gate publication requires its prepared review authorization");
      const review = await preparedReview(input.reviewRoot, input.artifactKey);
      if (review.repository !== input.repository || review.pullRequest !== input.pullRequest || review.head !== input.head || review.baseRef !== input.baseRef || review.baseSha !== input.baseSha || review.publish !== input.publish) throw new Error("Staging gate does not match the prepared frozen review");
      if (preparedReviewMode(review) !== "staging") throw new Error("A STAGING_GATE record requires a prepared protected-branch review");
      const policy = await refreshPolicyArtifact(pi, review);
      if (input.gate === "PASS") await requirePassEvidence(input, review, policy);
      let body = input.body;
      let adjudication: Record<string, unknown> | undefined;
      if (input.adjudicationPath) {
        const adjudicationPath = artifactFile(String(input.reviewRoot), input.adjudicationPath, "adjudication artifact");
        adjudication = JSON.parse(await readFile(adjudicationPath, "utf8")) as Record<string, unknown>;
        if (adjudication.schema !== "forgedock.candidate-adjudication/v1" || adjudication.artifactKey !== input.artifactKey || adjudication.repository !== input.repository || adjudication.pullRequest !== input.pullRequest || adjudication.head !== input.head || adjudication.baseRef !== input.baseRef || adjudication.baseSha !== input.baseSha || adjudication.mode !== "staging" || adjudication.gate !== input.gate) throw new Error("Gate does not match the prepared protected-route parent adjudication artifact");
        const roles = Array.isArray(review.roles) ? review.roles : [];
        const adjudicatedRoles = Array.isArray(adjudication.roles) ? adjudication.roles : [];
        const adjudicationReports = adjudication && Array.isArray(adjudication.reports) ? adjudication.reports as Array<Record<string, unknown>> : [];
        const reportsMatch = adjudicationReports.length === roles.length && roles.every((role) => adjudicationReports.filter((report) => report.role === role && report.reportId === roleArtifactKey(review, String(role))).length === 1);
        if (!Array.isArray(adjudication.reports) || !reportsMatch || adjudicatedRoles.length !== roles.length || !roles.every((role) => adjudicatedRoles.includes(role)) || !Array.isArray(adjudication.decisions) || typeof adjudication.verdict !== "string") throw new Error("Gate requires a completed parent panel decision with every prepared role report");
        if (input.gate === "PASS" && !["APPROVE", "APPROVE_WITH_FOLLOW_UP"].includes(String(adjudication.verdict))) throw new Error("PASS requires an approving parent adjudication");
        if (input.gate === "PASS" && adjudication.decisions.some((decision: any) => decision.disposition === "IMMEDIATE REPAIR" || decision.blocksCurrentStage === true)) throw new Error("PASS cannot coexist with unresolved parent adjudication blockers");
        if (input.publish && typeof adjudication.panelUrl !== "string") throw new Error("Published gate requires a published parent adjudication");
        body = String(adjudication.gateBody ?? "");
        if (body.length < 8) throw new Error("Parent adjudication artifact has no rendered gate body");
      }
      const priorGate = input.publish && input.pullRequest !== undefined && !input.supersedes
        ? await existingGateForHead(pi, input.repository, input.pullRequest, input.head, String(review.sourceRoot))
        : undefined;
      const supersedes = input.supersedes ?? (priorGate && !priorGate.body.includes(body.trim()) ? priorGate.url : undefined);
      const bodyPath = await tempArtifact("forgedock-record-", "body.md", body);
      const reportPath = resolve(dirname(bodyPath), "record.md");
      const args = [helperPath(), "record", "--kind", input.kind, "--repo", input.repository, "--body-file", bodyPath, "--report-file", reportPath];
      args.push(input.issue === undefined ? "--pr" : "--issue", String(input.issue ?? input.pullRequest));
      if (input.kind === "STAGING_GATE") {
        if (!input.head || !input.baseRef || !input.baseSha || !input.gate) throw new Error("Staging gate publication requires frozen head/base and PASS or FAIL");
        args.push("--head", input.head, "--base-ref", input.baseRef, "--base-sha", input.baseSha, "--gate", input.gate);
      }
      if (supersedes) args.push("--supersedes", supersedes);
      if (input.publish) args.push("--publish");
      const result = await pi.exec("node", args, { timeout: 120_000 });
      if (result.code !== 0) throw new Error(`Record publication failed: ${bounded(result.stderr)}`);
      return { content: [{ type: "text", text: bounded(result.stdout) }], details: { reportPath, publication: input.publish ? "published" : "saved", ...(adjudication ? { panelUrl: adjudication.panelUrl, trackingPublication: adjudication.trackingPublication } : {}) } };
    },
  });
}
