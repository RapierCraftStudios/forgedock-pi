import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerCandidateTools from "./tools.ts";

export const FORGEDOCK_ALIASES = Object.freeze({
  orchestrate: "forgedock-orchestrate",
  "work-on": "forgedock-work-on",
  "review-pr": "forgedock-review-pr",
  "review-pr-staging": "forgedock-review-pr-staging",
} as const);

const ALIAS_PATTERN =
  /^\/(?:forge:)?(orchestrate|work-on|review-pr|review-pr-staging)(?=$|\s)([\s\S]*)$/;
const INSTALLED_CANDIDATE_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/forgedock-candidate.mjs");
process.env.FORGEDOCK_CANDIDATE_BIN = INSTALLED_CANDIDATE_BIN;

export function rewriteForgePromptAlias(input: string): string | undefined {
  const match = input.match(ALIAS_PATTERN);
  if (!match) return undefined;
  const command = match[1] as keyof typeof FORGEDOCK_ALIASES;
  return `/skill:${FORGEDOCK_ALIASES[command]}${match[2] ?? ""}`;
}

/** The extension only performs lexical routing; workflow decisions stay in skills. */
function stagingInput(input: string): boolean {
  return /^\/(?:forge:)?review-pr-staging(?:\s|$)/.test(input) || /^\/skill:forgedock-review-pr-staging(?:\s|$)/.test(input);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeAtomicJsonExclusive(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    linkSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* interrupted temp cleanup is harmless */ }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function frozenReviewIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const review = value as Record<string, unknown>;
  if (typeof review.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(review.repository) || !Number.isSafeInteger(review.pullRequest) || Number(review.pullRequest) < 1 || typeof review.head !== "string" || !/^[a-f0-9]{40,64}$/.test(review.head) || typeof review.baseRef !== "string" || !review.baseRef || typeof review.baseSha !== "string" || !/^[a-f0-9]{40,64}$/.test(review.baseSha)) return undefined;
  return stableJson({ repository: review.repository.toLowerCase(), pullRequest: review.pullRequest, head: review.head, baseRef: review.baseRef, baseSha: review.baseSha });
}

function allowedReadOnlySubagentList(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const candidate = input as Record<string, unknown>;
  return candidate.action === "list" && Object.keys(candidate).every((key) => key === "action" || key === "capabilities") && (candidate.capabilities === undefined || typeof candidate.capabilities === "boolean");
}

function allowedPreparedReviewerSubagent(input: unknown, expectedMode: "staging" | "standard"): boolean {
  if (!input || typeof input !== "object") return false;
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.agent !== "undefined" || typeof candidate.workflowScript !== "undefined" || typeof candidate.workflowScriptPath !== "string") return false;
  try {
    const workflowPath = resolve(candidate.workflowScriptPath);
    const reviewRoot = resolve(dirname(workflowPath));
    const authorization = JSON.parse(readFileSync(join(reviewRoot, "review.json"), "utf8")) as Record<string, any>;
    const request = JSON.parse(readFileSync(join(reviewRoot, "request.json"), "utf8")) as Record<string, unknown>;
    if (stableJson(candidate) !== stableJson(request)) return false;
    const script = readFileSync(workflowPath, "utf8");
    const prefix = "const assignments = ";
    const executionMarker = ";\nconst results = ";
    if (!script.startsWith(prefix)) return false;
    const marker = script.indexOf(executionMarker, prefix.length);
    if (marker < 0) return false;
    const assignments = JSON.parse(script.slice(prefix.length, marker)) as unknown;
    const roles = Array.isArray(authorization.roles) ? authorization.roles : [];
    const roleKeys = authorization.roleArtifactKeys && typeof authorization.roleArtifactKeys === "object" ? authorization.roleArtifactKeys as Record<string, unknown> : {};
    const assignmentsValid = Array.isArray(assignments) && roles.length > 0 && roles.every((role) => typeof role === "string") && assignments.length === roles.length && assignments.every((assignment: unknown, index) => {
      if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) return false;
      const record = assignment as Record<string, unknown>;
      const role = roles[index];
      if (Object.keys(record).sort().join(",") !== "model,recoveryPath,reportPath,role,task" || record.role !== role || typeof record.task !== "string" || typeof record.model !== "string") return false;
      if (record.reportPath !== join(reviewRoot, `${role}.report.md`) || record.recoveryPath !== join(reviewRoot, `${role}.publication-recovery.json`)) return false;
      const authPath = join(reviewRoot, `${role}.authorization.json`);
      const roleAuthorization = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
      return roleAuthorization.artifactKey === roleKeys[role as string] && record.task.includes(`authorizationPath=${authPath}`) && record.task.includes(`artifactKey=<read from ${authPath}>`);
    });
    const timeoutMs = Number(authorization.config?.review?.reviewerTimeoutMs);
    const panelTimeoutMs = Number(authorization.config?.review?.panelTimeoutMs);
    const control = request.control && typeof request.control === "object" && !Array.isArray(request.control) ? request.control as Record<string, unknown> : {};
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(panelTimeoutMs) || panelTimeoutMs <= 0) return false;
    const expectedExecution = `const results = await runs.all(assignments.map((assignment) => ({ key: "review-" + assignment.role, agent: "forgedock-reviewer", task: assignment.task, model: assignment.model, context: "fresh", cwd: ${JSON.stringify(authorization.sourceRoot)}, worktree: false, output: false, artifacts: true, acceptance: false, maxRuntimeMs: ${timeoutMs} })));\nreturn assignments.map((assignment, index) => { const result = results[index] ?? {}; const children = Array.isArray(result.results) ? result.results : []; const child = children.length === 1 ? children[0] : {}; const stopped = result.stopped === true || children.some((entry) => entry?.stopped === true); const interrupted = result.interrupted === true || children.some((entry) => entry?.interrupted === true); const detached = result.detached === true || children.some((entry) => entry?.detached === true); const timedOut = result.timedOut === true || result.terminalOutcome?.reason === "timeout" || children.some((entry) => entry?.timedOut === true || entry?.terminalOutcome?.reason === "timeout"); const executionLimit = result.terminalOutcome?.reason === "budget_exhausted" || children.some((entry) => entry?.terminalOutcome?.reason === "budget_exhausted" || entry?.turnBudgetExceeded === true || entry?.toolBudgetBlocked === true); const exitCode = result.exitCode ?? child?.exitCode ?? null; const terminalFailure = [result.exitCode, child?.exitCode].some((code) => Number.isInteger(code) && code !== 0) || result.terminalOutcome?.state === "failed" || child?.terminalOutcome?.state === "failed"; const terminalSuccess = result.exitCode === 0 || child?.exitCode === 0 || result.terminalOutcome?.state === "completed" || child?.terminalOutcome?.state === "completed"; const nativeStatus = stopped ? "stopped" : interrupted ? "interrupted" : detached ? "detached" : timedOut ? "timed-out" : executionLimit ? "execution-limit" : terminalFailure ? "failed" : terminalSuccess ? "completed" : "nonterminal"; return { role: assignment.role, nativeRunId: result.runId ?? null, nativeStatus, nativeFlags: { timedOut, stopped, interrupted, detached, executionLimit }, exitCode, terminalOutcome: result.terminalOutcome ?? child?.terminalOutcome ?? null, publicationState: "unverified", reportPath: assignment.reportPath, recoveryPath: assignment.recoveryPath, output: typeof result.output === "string" ? result.output.slice(-2000) : "", error: typeof result.error === "string" ? result.error.slice(0, 500) : typeof child?.error === "string" ? child.error.slice(0, 500) : null, artifactPaths: Array.isArray(result.artifactPaths) ? result.artifactPaths : [] }; });\n`;
    return authorization.schema === "forgedock.candidate-review/v1" && authorization.artifactRoot === reviewRoot && authorization.mode === expectedMode && authorization.workflowPath === workflowPath && authorization.workflowSha256 === sha256(script) && typeof authorization.artifactKey === "string" && roles.includes("correctness") && assignmentsValid && script.slice(marker + 2) === expectedExecution && Object.keys(request).sort().join(",") === "async,control,cwd,globalConcurrencyLimit,maxSubagentSpawnsPerRun,timeoutMs,workflowScriptPath" && request.async === false && request.cwd === authorization.sourceRoot && request.workflowScriptPath === workflowPath && request.timeoutMs === panelTimeoutMs && Object.keys(control).sort().join(",") === "activeNoticeAfterMs,needsAttentionAfterMs" && control.needsAttentionAfterMs === panelTimeoutMs && control.activeNoticeAfterMs === timeoutMs && request.globalConcurrencyLimit === Math.min(Number(authorization.config?.review?.maxConcurrent), roles.length) && request.maxSubagentSpawnsPerRun === roles.length && !existsSync(join(reviewRoot, "panel-launch.claim"));
  } catch {
    return false;
  }
}

function claimPreparedReviewerSubagent(input: unknown, claimedIdentities: ReadonlySet<string>, expectedMode: "staging" | "standard", toolCallId: string): string | undefined {
  if (!allowedPreparedReviewerSubagent(input, expectedMode) || !input || typeof input !== "object") return undefined;
  const workflowPath = resolve((input as { workflowScriptPath: string }).workflowScriptPath);
  const reviewRoot = resolve(dirname(workflowPath));
  const review = JSON.parse(readFileSync(join(reviewRoot, "review.json"), "utf8")) as Record<string, unknown>;
  const identity = frozenReviewIdentity(review);
  if (!identity || claimedIdentities.has(identity)) return undefined;
  const claimPath = join(reviewRoot, "panel-launch.claim");
  const claim = { schema: "forgedock.candidate-review-panel-launch/v1", artifactKey: review.artifactKey, workflowSha256: review.workflowSha256, toolCallId, claimedAt: new Date().toISOString() };
  try {
    writeFileSync(claimPath, `${JSON.stringify(claim)}\n`, { flag: "wx", mode: 0o600 });
    return identity;
  } catch {
    return undefined;
  }
}

type PreparedReviewerWorkflow = {
  reviewRoot: string;
  artifactKey: string;
  workflowPath: string;
  workflowSha256: string;
  identity: string;
  repository: string;
  pullRequest: number;
  head: string;
  baseRef: string;
  baseSha: string;
  sourceRoot: string;
  mode: "standard" | "staging";
  roles: string[];
  protectedPromotion: boolean;
};

function preparedReviewerWorkflow(details: unknown): PreparedReviewerWorkflow | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const value = details as { reviewRoot?: unknown; artifactKey?: unknown; policySummary?: unknown };
  if (typeof value.reviewRoot !== "string" || typeof value.artifactKey !== "string") return undefined;
  const summary = value.policySummary && typeof value.policySummary === "object" && !Array.isArray(value.policySummary) ? value.policySummary as { baseRef?: unknown } : {};
  try {
    const reviewRoot = resolve(value.reviewRoot);
    const review = JSON.parse(readFileSync(join(reviewRoot, "review.json"), "utf8")) as Record<string, unknown>;
    const workflowPath = typeof review.workflowPath === "string" ? resolve(review.workflowPath) : undefined;
    const roles = Array.isArray(review.roles) && review.roles.every((role) => typeof role === "string") ? review.roles as string[] : undefined;
    const identity = frozenReviewIdentity(review);
    if (review.schema !== "forgedock.candidate-review/v1" || review.artifactRoot !== reviewRoot || review.artifactKey !== value.artifactKey || !identity || (review.mode !== "standard" && review.mode !== "staging") || !roles?.length || !workflowPath || resolve(dirname(workflowPath)) !== reviewRoot || !existsSync(workflowPath) || realpathSync(workflowPath) !== workflowPath || typeof review.workflowSha256 !== "string" || sha256(readFileSync(workflowPath, "utf8")) !== review.workflowSha256 || typeof review.repository !== "string" || !Number.isSafeInteger(review.pullRequest) || typeof review.head !== "string" || typeof review.baseRef !== "string" || typeof review.baseSha !== "string" || typeof review.sourceRoot !== "string") return undefined;
    const config = review.config && typeof review.config === "object" && !Array.isArray(review.config) ? review.config as Record<string, unknown> : {};
    const protectedBranch = config.protectedBranch;
    return { reviewRoot, artifactKey: String(review.artifactKey), workflowPath, workflowSha256: review.workflowSha256, identity, repository: review.repository, pullRequest: Number(review.pullRequest), head: review.head, baseRef: review.baseRef, baseSha: review.baseSha, sourceRoot: review.sourceRoot, mode: review.mode, roles, protectedPromotion: review.mode === "staging" && typeof protectedBranch === "string" && summary.baseRef === protectedBranch };
  } catch {
    return undefined;
  }
}

function reviewerRoleResults(value: unknown, prepared: PreparedReviewerWorkflow): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value) || value.length !== prepared.roles.length) return undefined;
  const statuses = new Set(["completed", "failed", "stopped", "interrupted", "timed-out", "detached", "execution-limit", "nonterminal"]);
  const byRole = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const row = item as Record<string, unknown>;
    const role = row.role;
    if (typeof role !== "string" || !prepared.roles.includes(role) || byRole.has(role) || !statuses.has(String(row.nativeStatus)) || !(row.nativeRunId === null || typeof row.nativeRunId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(row.nativeRunId)) || row.reportPath !== join(prepared.reviewRoot, `${role}.report.md`) || row.recoveryPath !== join(prepared.reviewRoot, `${role}.publication-recovery.json`) || !(row.exitCode === null || Number.isSafeInteger(row.exitCode))) return undefined;
    byRole.set(role, { role, nativeRunId: row.nativeRunId, nativeStatus: row.nativeStatus, reportPath: row.reportPath, recoveryPath: row.recoveryPath, exitCode: row.exitCode });
  }
  return prepared.roles.every((role) => byRole.has(role)) ? prepared.roles.map((role) => byRole.get(role)!) : undefined;
}

/** Narrow route guard: staging may inspect/check/publish evidence, never mutate product code or deliver it. */
export function isStagingMutationBlocked(toolName: string, input: unknown): boolean {
  const allowedTools = new Set(["read", "grep", "find", "ls", "forge_prepare_review", "forge_run_check", "forge_discover_review_records", "forge_resolve_review_tracking", "forge_recover_reviewer_publication", "forge_publish_incomplete_review", "forge_publish_adjudication", "forge_publish_record", "subagent"]);
  if (!allowedTools.has(toolName)) return true;
  if (toolName === "subagent" && !allowedReadOnlySubagentList(input) && !allowedPreparedReviewerSubagent(input, "staging")) return true;
  return false;
}

export default function forgedockCandidateExtension(pi: ExtensionAPI): void {
  let stagingGuard = false;
  const claimedReviewerIdentities = new Set<string>();
  const preparedReviewerWorkflows = new Map<string, PreparedReviewerWorkflow>();
  const pendingReviewerRuns = new Map<string, PreparedReviewerWorkflow>();
  const completedReviewerRuns = new Map<string, Map<string, Record<string, unknown>>>();
  registerCandidateTools(pi);
  pi.registerCommand("forge-status", {
    description: "Show that the isolated ForgeDock candidate extension is loaded",
    handler: async (_args, ctx) => {
      const tools = new Set(pi.getAllTools().map((tool) => tool.name));
      const stagingTools = ["forge_prepare_review", "forge_run_check", "forge_discover_review_records", "forge_resolve_review_tracking", "forge_recover_reviewer_publication", "forge_publish_incomplete_review", "forge_publish_adjudication", "forge_publish_record"];
      ctx.ui.notify(`ForgeDock candidate loaded; helper=${process.env.FORGEDOCK_CANDIDATE_BIN}; native subagent=${tools.has("subagent") ? "available" : "unavailable"}; staging tools=${stagingTools.filter((name) => tools.has(name)).length}/${stagingTools.length}.`, "info");
    },
  });
  pi.on("input", (event) => {
    if (event.source === "extension") return { action: "continue" };
    stagingGuard = stagingGuard || stagingInput(event.text);
    const rewritten = rewriteForgePromptAlias(event.text);
    return rewritten === undefined
      ? { action: "continue" }
      : { action: "transform", text: rewritten };
  });
  pi.on("agent_settled", () => {
    stagingGuard = false;
  });
  pi.on("tool_result", (event) => {
    if (event.toolName === "forge_prepare_review" && !event.isError) {
      const prepared = preparedReviewerWorkflow(event.details);
      if (prepared) {
        preparedReviewerWorkflows.set(prepared.workflowPath, prepared);
        if (prepared.protectedPromotion) stagingGuard = true;
      }
    }
    if (event.toolName !== "subagent") return;
    const prepared = pendingReviewerRuns.get(event.toolCallId);
    if (!prepared) return;
    pendingReviewerRuns.delete(event.toolCallId);
    if (event.isError || !event.details || typeof event.details !== "object" || Array.isArray(event.details)) return;
    const details = event.details as Record<string, unknown>;
    if (details.mode !== "workflow" || typeof details.runId !== "string") return;
    const workflow = details.workflow && typeof details.workflow === "object" && !Array.isArray(details.workflow) ? details.workflow as Record<string, unknown> : {};
    const roleResults = reviewerRoleResults(workflow.value, prepared);
    if (!roleResults) return;
    writeAtomicJsonExclusive(join(prepared.reviewRoot, "reviewer-execution.json"), {
      schema: "forgedock.candidate-review-execution/v1",
      repository: prepared.repository,
      pullRequest: prepared.pullRequest,
      head: prepared.head,
      baseRef: prepared.baseRef,
      baseSha: prepared.baseSha,
      artifactKey: prepared.artifactKey,
      mode: prepared.mode,
      workflowPath: prepared.workflowPath,
      workflowSha256: prepared.workflowSha256,
      toolCallId: event.toolCallId,
      workflowRunId: details.runId,
      completedAt: new Date().toISOString(),
      roleResults,
    });
    completedReviewerRuns.set(`${prepared.reviewRoot}\u0000${prepared.artifactKey}`, new Map(roleResults.map((result) => [String(result.role), result])));
  });
  pi.on("tool_call", (event) => {
    if (event.toolName === "forge_publish_incomplete_review") {
      if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) {
        return { block: true, reason: "GATED delivery requires a post-launch result for the exact prepared reviewer role." };
      }
      const input = event.input as Record<string, unknown>;
      if (typeof input.reviewRoot !== "string" || typeof input.artifactKey !== "string" || typeof input.role !== "string") {
        return { block: true, reason: "GATED delivery requires a post-launch result for the exact prepared reviewer role." };
      }
      // A fresh extension has no process-local result map; the registered tool validates the durable prepared receipt.
      const roleResult = completedReviewerRuns.get(`${resolve(input.reviewRoot)}\u0000${input.artifactKey}`)?.get(input.role);
      if (roleResult && (roleResult.nativeStatus !== input.nativeTerminal || (input.nativeRunId !== undefined && roleResult.nativeRunId !== input.nativeRunId))) {
        return { block: true, reason: "GATED delivery does not match the exact role's completed workflow result." };
      }
    }
    if (event.toolName === "forge_prepare_review") {
      const identity = frozenReviewIdentity(event.input);
      if (identity && claimedReviewerIdentities.has(identity)) {
        return { block: true, reason: "This exact frozen review already claimed its reviewer roster in this Pi session; use exact-run report recovery or adjudicate verified delivery instead of preparing another panel." };
      }
    }
    const hasWorkflowPath = event.toolName === "subagent" && event.input && typeof event.input === "object" && typeof (event.input as Record<string, unknown>).workflowScriptPath === "string";
    const workflowPath = hasWorkflowPath ? resolve((event.input as { workflowScriptPath: string }).workflowScriptPath) : undefined;
    const prepared = workflowPath ? preparedReviewerWorkflows.get(workflowPath) : undefined;
    if (prepared && claimedReviewerIdentities.has(prepared.identity)) {
      return { block: true, reason: "This exact frozen review already claimed its reviewer roster in this Pi session; recover or finalize its reports instead of launching the workflow again." };
    }
    if (stagingGuard && isStagingMutationBlocked(event.toolName, event.input)) {
      return { block: true, reason: "The staging review route is non-mutating; use read-only inspection and configured checks. The prepared reviewer roster cannot be relaunched; recover only an exact completed role or record incomplete delivery." };
    }
    if (event.toolName === "subagent" && allowedReadOnlySubagentList(event.input)) return undefined;
    if (event.toolName === "subagent" && prepared) {
      if (prepared.mode === "staging" && !stagingGuard) return { block: true, reason: "A protected-branch reviewer roster must pass the staging launch guard." };
      if (!allowedPreparedReviewerSubagent(event.input, prepared.mode)) return { block: true, reason: "The prepared reviewer workflow or runtime request no longer matches its frozen authorization." };
      const identity = claimPreparedReviewerSubagent(event.input, claimedReviewerIdentities, prepared.mode, event.toolCallId);
      if (!identity) return { block: true, reason: "The prepared reviewer roster may be launched only once; use exact-run report recovery or record incomplete delivery." };
      claimedReviewerIdentities.add(identity);
      pendingReviewerRuns.set(event.toolCallId, prepared);
      return undefined;
    }
    if (stagingGuard && event.toolName === "subagent") {
      return { block: true, reason: "The staging route may launch only its exact prepared reviewer roster; recover reports instead of starting another child." };
    }
    return undefined;
  });
}
