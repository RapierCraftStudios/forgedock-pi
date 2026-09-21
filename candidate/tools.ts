import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
  sourceReference: Type.String({ minLength: 1 }),
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
  })),
  historicalDecisions: Type.Optional(Type.Array(HISTORICAL_DECISION)),
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
  priorConcerns: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
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
    if (identity.repository !== input.repository || identity.pullRequest !== input.pullRequest || identity.head !== input.head || identity.baseRef !== input.baseRef || identity.baseSha !== input.baseSha || identity.role !== role) throw new Error(`Reviewer report for ${role} is not bound to the frozen role`);
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
      const handoff = `\n\nPR policy evidence saved at ${policyPath}. The existing restricted publication operation refreshes this same artifact before a gate decision; do not echo the policy object. Compact summary: ${JSON.stringify(summary)}.`;
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
      if (!root || !fullPath) return { content: [{ type: "text", text: bounded(JSON.stringify({ schema: "forgedock.candidate-review-history-index/v1", repository: input.repository, pullRequest: input.pullRequest, completeness: { commentCount: raw.commentCount ?? null, recordCount: raw.recordCount ?? null, unclassifiedCount: Array.isArray(raw.unclassifiedComments) ? raw.unclassifiedComments.length : null }, records: Array.isArray(raw.records) ? raw.records.map((record: any) => ({ id: record.id, url: record.url, createdAt: record.createdAt, kind: record.kind, record: record.record })) : [] }, null, 2)) }], details: { repository: input.repository, pullRequest: input.pullRequest, historyIndexPath, recordCount: Array.isArray(raw.records) ? raw.records.length : 0 } };
      const historyDir = join(root, "review-history");
      await mkdir(historyDir, { recursive: true, mode: 0o700 });
      const records = Array.isArray(raw.records) ? await Promise.all(raw.records.map(async (record: any) => {
        const bodyPath = join(historyDir, `comment-${String(record.id)}.md`);
        await writeFile(bodyPath, `${typeof record.body === "string" ? record.body : ""}`, { flag: "wx", mode: 0o600 }).catch(async (error) => { if (await readFile(bodyPath, "utf8") !== String(record.body ?? "")) throw error; });
        return { id: record.id, url: record.url, createdAt: record.createdAt, kind: record.kind, record: record.record, bodyPath };
      })) : [];
      const index = { schema: "forgedock.candidate-review-history-index/v1", repository: input.repository, pullRequest: input.pullRequest, artifactKey: input.artifactKey, completeness: { commentCount: raw.commentCount ?? null, recordCount: raw.recordCount ?? null, unclassifiedCount: Array.isArray(raw.unclassifiedComments) ? raw.unclassifiedComments.length : null, sourceArtifact: sourcePath }, records };
      await stableJsonFile(fullPath, index);
      return { content: [{ type: "text", text: bounded(JSON.stringify(index, null, 2)) }], details: { repository: input.repository, pullRequest: input.pullRequest, historyIndexPath, recordCount: records.length } };
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
    name: "forge_publish_adjudication",
    label: "Publish parent adjudication",
    description: "Validate every current reviewer observation, publish one parent REVIEW-PANEL decision, and publish only explicitly authorized deduplicated follow-up issues.",
    parameters: ADJUDICATION_INPUT,
    async execute(_toolCallId, params) {
      const input = params as Record<string, unknown>;
      const review = await preparedReview(String(input.reviewRoot), String(input.artifactKey));
      if (review.repository !== input.repository || review.pullRequest !== input.pullRequest || review.head !== input.head || review.baseRef !== input.baseRef || review.baseSha !== input.baseSha || review.publish !== input.publish) throw new Error("Adjudication does not match the prepared frozen review");
      const revision = Number(input.revision ?? 0);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Adjudication revision must be a non-negative integer");
      const inputPath = await revisionedJsonFile(resolve(String(input.reviewRoot)), "adjudication-input", revision, input);
      const result = await pi.exec("node", [helperPath(), "record", "adjudication", "--input", inputPath, "--cwd", String(review.configRoot ?? review.sourceRoot)], { timeout: 120_000 });
      if (result.code !== 0) throw new Error(`Parent adjudication failed: ${bounded(result.stderr)}`);
      const output = result.stdout.trim();
      let details: Record<string, unknown> = {};
      try { details = JSON.parse(output) as Record<string, unknown>; } catch { /* bounded text remains model-visible */ }
      return { content: [{ type: "text", text: bounded(output) }], details: { ...details, inputPath } };
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
      const policy = await refreshPolicyArtifact(pi, review);
      if (input.gate === "PASS") await requirePassEvidence(input, review, policy);
      let body = input.body;
      let adjudication: Record<string, unknown> | undefined;
      if (input.adjudicationPath) {
        const adjudicationPath = artifactFile(String(input.reviewRoot), input.adjudicationPath, "adjudication artifact");
        adjudication = JSON.parse(await readFile(adjudicationPath, "utf8")) as Record<string, unknown>;
        if (adjudication.schema !== "forgedock.candidate-adjudication/v1" || adjudication.artifactKey !== input.artifactKey || adjudication.repository !== input.repository || adjudication.pullRequest !== input.pullRequest || adjudication.head !== input.head || adjudication.baseRef !== input.baseRef || adjudication.baseSha !== input.baseSha || adjudication.gate !== input.gate) throw new Error("Gate does not match the parent adjudication artifact");
        const roles = Array.isArray(review.roles) ? review.roles : [];
        const adjudicatedRoles = Array.isArray(adjudication.roles) ? adjudication.roles : [];
        if (!Array.isArray(adjudication.reports) || adjudicatedRoles.length !== roles.length || !roles.every((role) => adjudicatedRoles.includes(role)) || !Array.isArray(adjudication.decisions) || typeof adjudication.verdict !== "string") throw new Error("Gate requires a completed parent panel decision");
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
