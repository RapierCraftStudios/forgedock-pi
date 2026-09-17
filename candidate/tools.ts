import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
    name: "forge_publish_record",
    label: "Publish candidate record",
    description: "Refresh the bound PR policy, then save and optionally publish one file-backed candidate gate record without changing source.",
    parameters: RECORD_INPUT,
    async execute(_toolCallId, params) {
      const input = params as RecordInput;
      if ((input.issue === undefined) === (input.pullRequest === undefined)) throw new Error("Record needs exactly one issue or pull request destination");
      if (input.kind !== "STAGING_GATE") throw new Error("The staging publication tool only publishes STAGING_GATE records");
      if (!input.reviewRoot || !input.artifactKey || !input.head || !input.baseRef || !input.baseSha || !input.gate || input.pullRequest === undefined) throw new Error("Staging gate publication requires its prepared review authorization");
      const review = await preparedReview(input.reviewRoot, input.artifactKey);
      if (review.repository !== input.repository || review.pullRequest !== input.pullRequest || review.head !== input.head || review.baseRef !== input.baseRef || review.baseSha !== input.baseSha || review.publish !== input.publish) throw new Error("Staging gate does not match the prepared frozen review");
      const policy = await refreshPolicyArtifact(pi, review);
      if (input.gate === "PASS") await requirePassEvidence(input, review, policy);
      const priorGate = input.publish && input.pullRequest !== undefined && !input.supersedes
        ? await existingGateForHead(pi, input.repository, input.pullRequest, input.head, String(review.sourceRoot))
        : undefined;
      const supersedes = input.supersedes ?? (priorGate && !priorGate.body.includes(input.body.trim()) ? priorGate.url : undefined);
      const bodyPath = await tempArtifact("forgedock-record-", "body.md", input.body);
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
      return { content: [{ type: "text", text: bounded(result.stdout) }], details: { reportPath, publication: input.publish ? "published" : "saved" } };
    },
  });
}
