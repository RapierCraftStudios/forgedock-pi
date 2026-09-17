import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

function allowedStagingSubagent(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const candidate = input as { agent?: unknown; workflowScript?: unknown; workflowScriptPath?: unknown };
  if (candidate.agent !== undefined || typeof candidate.workflowScript !== "undefined") return false;
  if (typeof candidate.workflowScriptPath === "string") {
    try {
      const workflowPath = resolve(candidate.workflowScriptPath);
      const reviewRoot = resolve(dirname(workflowPath));
      const authorization = JSON.parse(readFileSync(join(reviewRoot, "review.json"), "utf8")) as { schema?: unknown; artifactRoot?: unknown; artifactKey?: unknown; workflowPath?: unknown; workflowSha256?: unknown; roles?: unknown };
      const script = readFileSync(workflowPath, "utf8");
      const prefix = "const assignments = ";
      const executionMarker = ";\nreturn ";
      if (!script.startsWith(prefix)) return false;
      const marker = script.indexOf(executionMarker, prefix.length);
      if (marker < 0) return false;
      let assignments: unknown;
      try {
        assignments = JSON.parse(script.slice(prefix.length, marker));
      } catch {
        return false;
      }
      const execution = script.slice(marker + 1).trim();
      const executionMatch = execution.match(/^return \(await runs\.all\(assignments\.map\(\(assignment\) => \(\{ key: "review-" \+ assignment\.role, agent: "([^"]+)", task: assignment\.task, model: assignment\.model, context: "([^"]+)", cwd: ("(?:\\\\.|[^"\\\\])*"), worktree: (true|false), output: (true|false), artifacts: (true|false), acceptance: (true|false), maxRuntimeMs: ([0-9]+) \}\){4};$/);
      const roles = Array.isArray(authorization.roles) ? authorization.roles : [];
      const assignmentsValid = Array.isArray(assignments) && roles.length > 0 && roles.every((role) => typeof role === "string") && assignments.length === roles.length && assignments.every((assignment: unknown, index) => {
        if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) return false;
        const record = assignment as Record<string, unknown>;
        return Object.keys(record).sort().join(",") === "model,role,task" && record.role === roles[index] && typeof record.task === "string" && typeof record.model === "string";
      });
      return authorization.schema === "forgedock.candidate-review/v1" && authorization.artifactRoot === reviewRoot && authorization.workflowPath === workflowPath && authorization.workflowSha256 === sha256(script) && typeof authorization.artifactKey === "string" && roles.includes("correctness") && assignmentsValid && executionMatch !== null && executionMatch[1] === "forgedock-reviewer" && executionMatch[2] === "fresh" && executionMatch[4] === "false" && executionMatch[5] === "false" && executionMatch[6] === "true" && executionMatch[7] === "false" && Number.isSafeInteger(Number(executionMatch[8])) && Number(executionMatch[8]) > 0;
    } catch {
      return false;
    }
  }
  return false;
}

function protectedPromotionPrepared(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const value = details as { reviewRoot?: unknown; policySummary?: unknown };
  if (typeof value.reviewRoot !== "string" || !value.policySummary || typeof value.policySummary !== "object" || Array.isArray(value.policySummary)) return false;
  const summary = value.policySummary as { baseRef?: unknown };
  if (typeof summary.baseRef !== "string") return false;
  try {
    const review = JSON.parse(readFileSync(join(resolve(value.reviewRoot), "review.json"), "utf8")) as { config?: unknown };
    const config = review.config;
    const protectedBranch = config && typeof config === "object" && !Array.isArray(config) ? (config as { protectedBranch?: unknown }).protectedBranch : undefined;
    return typeof protectedBranch === "string" && summary.baseRef === protectedBranch;
  } catch {
    return false;
  }
}

/** Narrow route guard: staging may inspect/check/publish evidence, never mutate product code or deliver it. */
export function isStagingMutationBlocked(toolName: string, input: unknown): boolean {
  const allowedTools = new Set(["read", "grep", "find", "ls", "forge_prepare_review", "forge_run_check", "forge_publish_record", "subagent"]);
  if (!allowedTools.has(toolName)) return true;
  if (toolName === "subagent" && !allowedStagingSubagent(input)) return true;
  return false;
}

export default function forgedockCandidateExtension(pi: ExtensionAPI): void {
  let stagingGuard = false;
  registerCandidateTools(pi);
  pi.registerCommand("forge-status", {
    description: "Show that the isolated ForgeDock candidate extension is loaded",
    handler: async (_args, ctx) => {
      const tools = new Set(pi.getAllTools().map((tool) => tool.name));
      ctx.ui.notify(`ForgeDock candidate loaded; helper=${process.env.FORGEDOCK_CANDIDATE_BIN}; native subagent=${tools.has("subagent") ? "available" : "unavailable"}; staging tools=${["forge_prepare_review", "forge_run_check", "forge_publish_record"].filter((name) => tools.has(name)).length}/3.`, "info");
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
    if (event.toolName === "forge_prepare_review" && !event.isError && protectedPromotionPrepared(event.details)) stagingGuard = true;
  });
  pi.on("tool_call", (event) => {
    if (stagingGuard && isStagingMutationBlocked(event.toolName, event.input)) {
      return { block: true, reason: "The staging review route is non-mutating; use read-only inspection and configured checks." };
    }
    return undefined;
  });
}
