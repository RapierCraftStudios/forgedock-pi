import { readFileSync } from "node:fs";
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

function allowedStagingSubagent(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const candidate = input as { agent?: unknown; workflowScript?: unknown; workflowScriptPath?: unknown };
  if (candidate.agent !== undefined) return candidate.agent === "forgedock-reviewer";
  if (typeof candidate.workflowScript === "string") return candidate.workflowScript.includes("forgedock-reviewer") && !/forgedock-owner|worker|writer|delegate/.test(candidate.workflowScript);
  if (typeof candidate.workflowScriptPath === "string") {
    try {
      const script = readFileSync(candidate.workflowScriptPath, "utf8");
      return script.includes("forgedock-reviewer") && !/forgedock-owner|worker|writer|delegate/.test(script);
    } catch {
      return false;
    }
  }
  return false;
}

/** Narrow route guard: staging may inspect/check/publish evidence, never mutate product code or deliver it. */
export function isStagingMutationBlocked(toolName: string, input: unknown): boolean {
  if (["edit", "write", "bash", "powershell"].includes(toolName)) return true;
  if (toolName === "subagent" && !allowedStagingSubagent(input)) return true;
  return false;
}

export default function forgedockCandidateExtension(pi: ExtensionAPI): void {
  let stagingGuard = false;
  registerCandidateTools(pi);
  pi.registerCommand("forge-status", {
    description: "Show that the isolated ForgeDock candidate extension is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("ForgeDock candidate extension loaded; run the external doctor for full readiness.", "info");
    },
  });
  pi.on("input", (event) => {
    if (event.source === "extension") return { action: "continue" };
    stagingGuard = stagingInput(event.text);
    const rewritten = rewriteForgePromptAlias(event.text);
    return rewritten === undefined
      ? { action: "continue" }
      : { action: "transform", text: rewritten };
  });
  pi.on("tool_call", (event) => {
    if (stagingGuard && isStagingMutationBlocked(event.toolName, event.input)) {
      return { block: true, reason: "The staging review route is non-mutating; use read-only inspection and configured checks." };
    }
    return undefined;
  });
}
