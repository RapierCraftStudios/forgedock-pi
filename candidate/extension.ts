import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
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
const FORGEDOCK_COMMAND_LINE = /^\/(?:forge:)?(?:forge-status|orchestrate|work-on|review-pr|review-pr-staging)(?=$|\s)/;
const INSTALLED_CANDIDATE_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/forgedock-candidate.mjs");
const OWNER_OPERATION_AUTHORITY_BINDING = "forgedock.candidate-owner-authority/1";
process.env.FORGEDOCK_CANDIDATE_BIN = INSTALLED_CANDIDATE_BIN;

type OwnerOperationAuthority = {
  schema: "forgedock.candidate-owner-authority/v1";
  scope: string;
  repository: string;
  issue: number;
  deliveryMode: "github" | "local-replay";
  target: string;
  protectedTarget: string;
  mergeTargets: string[];
  closeIssueAfterMerge: boolean;
  closeInvalidIssue: boolean;
  createIssues: boolean;
};

function ownerOperationAuthority(): { present: boolean; value?: OwnerOperationAuthority } {
  const raw = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  if (!raw) return { present: false };
  try {
    const bindings = JSON.parse(raw) as Record<string, unknown>;
    if (!Object.hasOwn(bindings, OWNER_OPERATION_AUTHORITY_BINDING)) return { present: false };
    const value = bindings[OWNER_OPERATION_AUTHORITY_BINDING];
    if (!value || typeof value !== "object" || Array.isArray(value)) return { present: true };
    const authority = value as Record<string, unknown>;
    if (authority.schema !== "forgedock.candidate-owner-authority/v1" || typeof authority.scope !== "string" || typeof authority.repository !== "string" || !Number.isSafeInteger(authority.issue) || !["github", "local-replay"].includes(String(authority.deliveryMode)) || typeof authority.target !== "string" || typeof authority.protectedTarget !== "string" || !Array.isArray(authority.mergeTargets) || !authority.mergeTargets.every((target) => typeof target === "string") || typeof authority.closeIssueAfterMerge !== "boolean" || typeof authority.closeInvalidIssue !== "boolean" || typeof authority.createIssues !== "boolean") return { present: true };
    return { present: true, value: authority as OwnerOperationAuthority };
  } catch {
    return { present: true };
  }
}

function normalizeShellCommand(command: string): string {
  return command.replace(/\\\r?\n/g, " ");
}

export function ownerMergeBlockReason(command: string, authority: OwnerOperationAuthority | undefined, pullReadback?: Record<string, unknown>): string | undefined {
  const shellCommand = normalizeShellCommand(command);
  const mergeOperations = shellCommand.match(/\bgh\s+pr\s+(?:merge|auto-merge)\b|\bgh\s+api\b[^\n;&|]*\/pulls\/\d+\/merge\b|\bmergePullRequest\b/gi) ?? [];
  if (mergeOperations.length > 1) return "Compound commands with multiple PR merge operations are blocked; authorize one merge at a time.";
  const directMerge = /\bgh\s+pr\s+(?:merge|auto-merge)\b/i.test(shellCommand);
  const apiMerge = /\bgh\s+api\b[^\n]*\/pulls\/\d+\/merge/i.test(shellCommand) || /mergePullRequest/i.test(shellCommand);
  if (!directMerge && !apiMerge) return undefined;
  if (!authority) return "No validated ForgeDock owner authority is bound; PR merge is blocked.";
  if (authority.deliveryMode === "local-replay") return "Local replay cannot merge a GitHub PR.";
  if (apiMerge) return "Direct merge API calls are blocked; use the exact scoped gh pr merge operation.";
  if (/--auto(?:\s|$)/i.test(shellCommand) || /auto-merge/i.test(shellCommand)) return "Automatic merge is not authorized for candidate work-on owners.";
  if (!authority.mergeTargets.includes(authority.target) || authority.target === authority.protectedTarget) return `Merge to ${authority.target} is not explicitly authorized.`;
  const pull = shellCommand.match(/\bgh\s+pr\s+merge\s+(\d+)\b/i);
  if (!pull) return "Merge must name one exact PR number; branch/URL selectors are blocked.";
  const matchHead = shellCommand.match(/--match-head-commit\s+([a-f0-9]{40,64})/i)?.[1];
  if (!matchHead) return "Merge must bind --match-head-commit to the reviewed PR head.";
  const explicitRepo = shellCommand.match(/(?:--repo|-R)\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i)?.[1];
  if (explicitRepo && explicitRepo.toLowerCase() !== authority.repository.toLowerCase()) return "Merge repository does not match the bound issue owner.";
  if (!pullReadback) return "Exact PR merge identity could not be read back; merge is blocked.";
  if (Number(pullReadback.number) !== Number(pull[1])) return "PR readback does not match the requested pull request.";
  if (pullReadback.state !== "OPEN" || pullReadback.baseRefName !== authority.target || pullReadback.headRefOid !== matchHead) return "PR state/base/head does not match the bound merge authority.";
  if (!(pullReadback.mergeable === "MERGEABLE" || pullReadback.mergeable === true)) return "PR mergeability is not positively verified.";
  const expectedIssueUrl = `https://github.com/${authority.repository}/issues/${authority.issue}`.toLowerCase();
  const closingIssueReferences = Array.isArray(pullReadback.closingIssuesReferences) ? pullReadback.closingIssuesReferences : [];
  const linkedIssue = closingIssueReferences.length === 1 && closingIssueReferences.some((reference) => reference && Number(reference.number) === authority.issue && typeof reference.url === "string" && reference.url.toLowerCase() === expectedIssueUrl);
  if (!linkedIssue) return `PR is not linked to the exact bound issue #${authority.issue}.`;
  return undefined;
}

type VerifiedOwnerIssueDelivery = { repository: string; issue: number; target: string; pullRequest: number; headSha: string };

function ownerMergedDeliveryReadback(authority: OwnerOperationAuthority): VerifiedOwnerIssueDelivery | undefined {
  try {
    const timelineText = execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${authority.repository}/issues/${authority.issue}/timeline`], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    });
    const pages = JSON.parse(timelineText) as unknown;
    const events = Array.isArray(pages) ? pages.flatMap((page) => Array.isArray(page) ? page : [page]) : [];
    const pullRequests = new Set<number>();
    for (const event of events) {
      const sourceIssue = event && typeof event === "object" ? (event as Record<string, any>).source?.issue : undefined;
      if ((event as Record<string, unknown>)?.event === "cross-referenced" && sourceIssue?.pull_request && Number.isSafeInteger(sourceIssue.number)) pullRequests.add(sourceIssue.number);
    }
    const expectedIssueUrl = `https://github.com/${authority.repository}/issues/${authority.issue}`.toLowerCase();
    for (const pullRequest of pullRequests) {
      const pullText = execFileSync("gh", ["pr", "view", String(pullRequest), "--repo", authority.repository, "--json", "number,state,baseRefName,headRefOid,mergedAt,closingIssuesReferences"], {
        cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000,
      });
      const pull = JSON.parse(pullText) as Record<string, any>;
      const references = Array.isArray(pull.closingIssuesReferences) ? pull.closingIssuesReferences : [];
      const linkedIssue = references.length === 1 && references.some((reference: Record<string, unknown>) => Number(reference.number) === authority.issue && typeof reference.url === "string" && reference.url.toLowerCase() === expectedIssueUrl);
      if (Number(pull.number) === pullRequest && pull.state === "MERGED" && pull.baseRefName === authority.target && typeof pull.headRefOid === "string" && /^[a-f0-9]{40,64}$/.test(pull.headRefOid) && typeof pull.mergedAt === "string" && linkedIssue) {
        return { repository: authority.repository, issue: authority.issue, target: authority.target, pullRequest, headSha: pull.headRefOid };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function ownerIssueCloseBlockReason(command: string, authority: OwnerOperationAuthority | undefined, verifiedDelivery?: VerifiedOwnerIssueDelivery): string | undefined {
  const shellCommand = normalizeShellCommand(command);
  const graphQLCalls = shellCommand.match(/\bgh\s+api\b[^;&|]*\bgraphql\b[^;&|]*/gi) ?? [];
  if (graphQLCalls.some((call) => /\b(?:mutation|closeIssue|updateIssue)\b/i.test(call) || /(?:--input(?:=|\s+)|(?:-f|-F|--field|--raw-field)(?:=|\s+)query=@)/i.test(call))) return "GraphQL issue-state changes are not authorized through the owner shell; use the verified bound close route.";
  const closures: Array<{ issue: number; repository?: string }> = [];
  for (const segment of shellCommand.split(/(?:&&|\|\||[;&|])/g)) {
    const close = segment.match(/\bgh\s+issue\s+close\s+(\d+)\b/i);
    if (close) {
      const repository = segment.match(/(?:--repo|-R)\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i)?.[1];
      closures.push({ issue: Number(close[1]), repository });
      continue;
    }
    const apiCalls = segment.match(/\bgh\s+api\b[^;&|]*/gi) ?? [];
    for (const apiCall of apiCalls) {
      const route = apiCall.match(/(?:^|\s)\/?repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?(?=\s|\?|$)/i);
      if (!route) continue;
      const method = apiCall.match(/(?:^|\s)(?:-X|--method)\s+(PATCH|PUT|DELETE|POST)\b/i)?.[1]?.toUpperCase();
      if (!method || !["PATCH", "PUT", "DELETE"].includes(method)) continue;
      const stateClosed = /(?:-f|-F|--field|--raw-field)\s+["']?state=closed\b/i.test(apiCall);
      if (!stateClosed) return "Direct issue API mutations are blocked; use the bound ForgeDock helper.";
      closures.push({ issue: Number(route[3]), repository: `${route[1]}/${route[2]}` });
    }
  }
  if (closures.length === 0) return undefined;
  if (closures.length > 1) return "Compound commands with multiple issue closures are blocked.";
  const close = closures[0]!;
  if (!authority || close.issue !== authority.issue || close.repository && close.repository.toLowerCase() !== authority.repository.toLowerCase()) return "Issue close does not match a bound ForgeDock owner authority.";
  if (authority.closeIssueAfterMerge && verifiedDelivery && verifiedDelivery.issue === authority.issue && verifiedDelivery.repository.toLowerCase() === authority.repository.toLowerCase() && verifiedDelivery.target === authority.target) return undefined;
  if (authority.closeInvalidIssue) return "INVALID issue closure requires a separately validated no-change outcome; static scope authority alone is insufficient.";
  if (authority.closeIssueAfterMerge) return "Issue closure after delivery requires a read-back-confirmed merged PR to the bound target.";
  return "Issue closure is not authorized by the bound operation scope.";
}

export function ownerIssueCreateBlockReason(command: string, authority: OwnerOperationAuthority | undefined): string | undefined {
  const shellCommand = normalizeShellCommand(command);
  const graphQLCalls = shellCommand.match(/\bgh\s+api\b[^;&|]*\bgraphql\b[^;&|]*/gi) ?? [];
  if (graphQLCalls.some((call) => /\b(?:mutation|createIssue)\b/i.test(call) || /(?:--input(?:=|\s+)|(?:-f|-F|--field|--raw-field)(?:=|\s+)query=@)/i.test(call))) return "GraphQL issue creation is not authorized through the owner shell.";
  const directCreates = shellCommand.match(/\bgh\s+issue\s+create\b/gi) ?? [];
  const apiCreates: Array<{ repository: string }> = [];
  for (const segment of shellCommand.split(/(?:&&|\|\||[;&|])/g)) {
    const apiCalls = segment.match(/\bgh\s+api\b[^;&|]*/gi) ?? [];
    for (const apiCall of apiCalls) {
      const route = apiCall.match(/(?:^|\s)\/?repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/?(?:\?[^\s]*)?(?=\s|$)/i);
      if (!route) continue;
      const method = apiCall.match(/(?:^|\s)(?:-X|--method)\s+(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toUpperCase();
      const fields = /(?:^|\s)(?:-f|-F|--field|--raw-field)\s+\S+/i.test(apiCall);
      const inputFile = /(?:^|\s)--input(?:=|\s+)\S+/i.test(apiCall);
      const writesCollection = method ? ["POST", "PUT", "PATCH", "DELETE"].includes(method) : fields || inputFile;
      if (writesCollection) apiCreates.push({ repository: `${route[1]}/${route[2]}` });
    }
  }
  if (directCreates.length === 0 && apiCreates.length === 0) return undefined;
  if (!authority || !authority.createIssues) return "Creating additional issues is not authorized for this owner lane.";
  if (apiCreates.some((create) => create.repository.toLowerCase() !== authority.repository.toLowerCase())) return "Issue creation outside the bound repository is not authorized.";
  return undefined;
}

export function ownerDirectTargetPushBlockReason(command: string, authority: OwnerOperationAuthority | undefined): string | undefined {
  const match = command.match(/\bgit\s+push\b([^\n;&|]*)/i);
  if (!match) return undefined;
  if (!authority) return "No validated ForgeDock owner authority is bound to this push.";
  const args = match[1]!.trim().split(/\s+/).filter(Boolean);
  if (args.some((arg) => ["--all", "--mirror", "--tags"].includes(arg))) return "Bulk Git pushes are blocked in bound issue worktrees.";
  const protectedBranches = authority.deliveryMode === "local-replay" ? [authority.protectedTarget] : [authority.target, authority.protectedTarget];
  const protectedRefs = new Set(protectedBranches.flatMap((branch) => [branch, `refs/heads/${branch}`]));
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const destination = arg.includes(":") ? arg.slice(arg.lastIndexOf(":") + 1) : arg;
    if (protectedRefs.has(destination)) return `Direct push to protected integration/default ref '${destination}' is blocked; deliver through the authorized PR route.`;
  }
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
    if (protectedBranches.includes(branch)) return `Direct push from protected branch '${branch}' is blocked.`;
  } catch {
    return "Current worktree branch could not be verified before push.";
  }
  return undefined;
}

function ownerPullReadback(command: string, authority: OwnerOperationAuthority | undefined): Record<string, unknown> | undefined {
  if (!authority) return undefined;
  const pull = command.match(/\bgh\s+pr\s+merge\s+(\d+)\b/i);
  if (!pull) return undefined;
  try {
    const output = execFileSync("gh", ["pr", "view", pull[1]!, "--repo", authority.repository, "--json", "number,state,baseRefName,headRefOid,mergeable,closingIssuesReferences"], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000,
    });
    const value = JSON.parse(output) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function rewriteForgePromptAlias(input: string): string | undefined {
  const match = input.match(ALIAS_PATTERN);
  if (!match) return undefined;
  const command = match[1] as keyof typeof FORGEDOCK_ALIASES;
  return `/skill:${FORGEDOCK_ALIASES[command]}${match[2] ?? ""}`;
}

export function combinedForgeCommandLines(input: string): string[] {
  const commands = input.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!FORGEDOCK_COMMAND_LINE.test(trimmed)) return [];
    const matches = [...trimmed.matchAll(/\/(?:forge:)?(?:forge-status|orchestrate|work-on|review-pr|review-pr-staging)(?=$|\s)/g)].map((match) => match[0]);
    return matches.length > 1 ? matches : matches.length === 1 ? [trimmed] : [];
  });
  return commands.length > 1 ? commands : [];
}

function allowedStagingTodoCompletion(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return value.action === "update" && Number.isSafeInteger(value.id) && value.status === "completed"
    && Object.keys(value).every((key) => ["action", "id", "status"].includes(key));
}

function allowedStagingSupervisorAction(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (value.action === "status") return Object.keys(value).every((key) => key === "action");
  if (value.action === "pending" || value.action === "list") {
    return Object.keys(value).every((key) => key === "action" || key === "to")
      && (value.to === undefined || typeof value.to === "string" && value.to.length > 0 && value.to.length <= 256 && !/[\0\r\n]/.test(value.to));
  }
  return value.action === "reply"
    && Object.keys(value).every((key) => ["action", "replyTo", "message"].includes(key))
    && typeof value.replyTo === "string" && value.replyTo.length > 0 && value.replyTo.length <= 256 && !/[\0\r\n]/.test(value.replyTo)
    && typeof value.message === "string" && value.message.trim().length > 0 && !/\0/.test(value.message);
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
  configPath: string;
  configSha256: string;
  configuredChecks: string[];
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
    const verificationCommands = config.verificationCommands && typeof config.verificationCommands === "object" && !Array.isArray(config.verificationCommands) ? config.verificationCommands as Record<string, unknown> : {};
    const configuredChecks = Object.keys(verificationCommands);
    const protectedBranch = config.protectedBranch;
    if (typeof review.configPath !== "string" || typeof review.configSha256 !== "string") return undefined;
    return { reviewRoot, artifactKey: String(review.artifactKey), workflowPath, workflowSha256: review.workflowSha256, identity, repository: review.repository, pullRequest: Number(review.pullRequest), head: review.head, baseRef: review.baseRef, baseSha: review.baseSha, sourceRoot: review.sourceRoot, configPath: review.configPath, configSha256: review.configSha256, configuredChecks, mode: review.mode, roles, protectedPromotion: review.mode === "staging" && typeof protectedBranch === "string" && summary.baseRef === protectedBranch };
  } catch {
    return undefined;
  }
}

function preparedCheckKey(prepared: PreparedReviewerWorkflow, name: string): string {
  return `${prepared.reviewRoot}\u0000${prepared.artifactKey}\u0000${name}`;
}

function hasPreparedCheckReceipt(prepared: PreparedReviewerWorkflow, name: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]*$/.test(name)) return false;
  const path = join(prepared.reviewRoot, "checks", `${name}.json`);
  try {
    if (!existsSync(path) || realpathSync(path) !== path) return false;
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return receipt.schema === "forgedock.candidate-check/v1" && receipt.status === "passed" && receipt.name === name && receipt.sourceRoot === prepared.sourceRoot && receipt.head === prepared.head && receipt.configPath === prepared.configPath && receipt.configSha256 === prepared.configSha256;
  } catch {
    return false;
  }
}

function cleanPreparedSourceProblem(prepared: PreparedReviewerWorkflow): string | undefined {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: prepared.sourceRoot, encoding: "utf8", timeout: 5_000 }).trim();
    if (head !== prepared.head) return `frozen source moved from ${prepared.head} to ${head}`;
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: prepared.sourceRoot, encoding: "utf8", timeout: 5_000 }).trim();
    return status ? `frozen source is dirty before reviewer launch: ${status.slice(0, 320)}` : undefined;
  } catch (error) {
    return `frozen source cleanliness could not be verified: ${error instanceof Error ? error.message : String(error)}`;
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
  if (toolName === "todo") return !allowedStagingTodoCompletion(input);
  if (toolName === "subagent_supervisor") return !allowedStagingSupervisorAction(input);
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
  const attemptedStagingChecks = new Set<string>();
  registerCandidateTools(pi);
  pi.registerCommand("forge-status", {
    description: "Show the active ForgeDock package and registered review tools",
    handler: async (_args, ctx) => {
      const tools = new Set(pi.getAllTools().map((tool) => tool.name));
      const stagingTools = ["forge_prepare_review", "forge_run_check", "forge_discover_review_records", "forge_resolve_review_tracking", "forge_recover_reviewer_publication", "forge_publish_incomplete_review", "forge_publish_adjudication", "forge_publish_record"];
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      ctx.ui.notify(`ForgeDock loaded; package=${packageRoot}; helper=${process.env.FORGEDOCK_CANDIDATE_BIN}; native subagent=${tools.has("subagent") ? "available" : "unavailable"}; review tools=${stagingTools.filter((name) => tools.has(name)).length}/${stagingTools.length}.`, "info");
    },
  });
  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const commands = combinedForgeCommandLines(event.text);
    if (commands.length > 1) {
      const notice = `Pi accepts one slash command per input; none of these commands ran: ${commands.join("; ")}. Submit /forge-status and /review-pr as separate inputs, or run /review-pr directly; it does not depend on a prior status check.`;
      if (ctx.hasUI) {
        ctx.ui.notify(notice, "warning");
        return { action: "handled" };
      }
      return { action: "transform", text: notice };
    }
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
    const ownerAuthority = ownerOperationAuthority();
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
    if (ownerAuthority.present && event.toolName === "forge_publish_adjudication" && event.input && typeof event.input === "object" && (event.input as Record<string, unknown>).allowIssueWrites === true && !ownerAuthority.value?.createIssues) {
      return { block: true, reason: "Publishing a follow-up issue is outside the bound owner authority." };
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
    if (ownerAuthority.present && event.toolName === "bash" && event.input && typeof event.input === "object" && !Array.isArray(event.input)) {
      const command = (event.input as Record<string, unknown>).command;
      if (typeof command === "string") {
        const pushBlock = ownerDirectTargetPushBlockReason(command, ownerAuthority.value);
        if (pushBlock) return { block: true, reason: pushBlock };
        const canReadMergeTarget = ownerAuthority.value && ownerAuthority.value.mergeTargets.includes(ownerAuthority.value.target) && !/--auto(?:\s|$)|auto-merge/i.test(command);
        const mergeReadback = canReadMergeTarget ? ownerPullReadback(command, ownerAuthority.value) : undefined;
        const mergeBlock = ownerMergeBlockReason(command, ownerAuthority.value, mergeReadback);
        if (mergeBlock) return { block: true, reason: mergeBlock };
        const normalizedCommand = normalizeShellCommand(command);
        const closeRequest = /\bgh\s+issue\s+close\b|(?:-f|-F|--field|--raw-field)\s+["']?state=closed\b/i.test(normalizedCommand);
        const verifiedDelivery = closeRequest && ownerAuthority.value?.closeIssueAfterMerge ? ownerMergedDeliveryReadback(ownerAuthority.value) : undefined;
        const closeBlock = ownerIssueCloseBlockReason(command, ownerAuthority.value, verifiedDelivery);
        if (closeBlock) return { block: true, reason: closeBlock };
        const createBlock = ownerIssueCreateBlockReason(command, ownerAuthority.value);
        if (createBlock) return { block: true, reason: createBlock };
      }
    }
    if (stagingGuard && isStagingMutationBlocked(event.toolName, event.input)) {
      return { block: true, reason: "The staging review route is non-mutating; use read-only inspection and configured checks. The prepared reviewer roster cannot be relaunched; recover only an exact completed role or record incomplete delivery." };
    }
    if (event.toolName === "forge_run_check" && event.input && typeof event.input === "object" && !Array.isArray(event.input)) {
      const input = event.input as Record<string, unknown>;
      const preparedCheck = [...preparedReviewerWorkflows.values()].find((candidate) => candidate.protectedPromotion && typeof input.reviewRoot === "string" && resolve(input.reviewRoot) === candidate.reviewRoot && input.artifactKey === candidate.artifactKey);
      if (preparedCheck) {
        if (claimedReviewerIdentities.has(preparedCheck.identity)) return { block: true, reason: "Configured checks must run before reviewer launch; do not rerun checks after native reviewer artifacts may exist. Reuse the exact-head receipt." };
        if (typeof input.name !== "string" || !preparedCheck.configuredChecks.includes(input.name)) return { block: true, reason: "Run only a check named by the prepared canonical forge.yaml." };
        if (input.sourceRoot !== preparedCheck.sourceRoot || input.head !== preparedCheck.head || typeof input.configPath !== "string" || resolve(input.configPath) !== preparedCheck.configPath || input.configSha256 !== preparedCheck.configSha256) return { block: true, reason: "Configured check does not match the prepared frozen review identity." };
        const checkKey = preparedCheckKey(preparedCheck, input.name);
        if (attemptedStagingChecks.has(checkKey) || hasPreparedCheckReceipt(preparedCheck, input.name)) return { block: true, reason: `Configured check '${input.name}' was already attempted for this frozen review; do not rerun it.` };
        attemptedStagingChecks.add(checkKey);
      }
    }
    if (event.toolName === "subagent" && allowedReadOnlySubagentList(event.input)) return undefined;
    if (event.toolName === "subagent" && prepared) {
      if (prepared.mode === "staging" && !stagingGuard) return { block: true, reason: "A protected-branch reviewer roster must pass the staging launch guard." };
      if (!allowedPreparedReviewerSubagent(event.input, prepared.mode)) return { block: true, reason: "The prepared reviewer workflow or runtime request no longer matches its frozen authorization." };
      if (prepared.protectedPromotion) {
        const missingChecks = prepared.configuredChecks.filter((name) => !attemptedStagingChecks.has(preparedCheckKey(prepared, name)) && !hasPreparedCheckReceipt(prepared, name));
        if (missingChecks.length > 0) return { block: true, reason: `Run each configured local check through forge_run_check before reviewer launch: ${missingChecks.join(", ")}.` };
        const cleanlinessProblem = cleanPreparedSourceProblem(prepared);
        if (cleanlinessProblem) return { block: true, reason: `Reviewer launch requires the exact frozen source checkout to remain clean: ${cleanlinessProblem}` };
      }
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
