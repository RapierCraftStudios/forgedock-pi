import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function blockedStagingShell(command: string): boolean {
  return /(?:^|\s)(?:git\s+(?:commit|push|merge|reset|rebase|checkout|switch|branch\s+-D)|gh\s+(?:pr\s+merge|issue\s+(?:create|close|edit)|deploy)|npm\s+publish|rm\s+-rf?\b|(?:mv|cp)\s+[^\n]*|>>?\s*[^\s])/.test(command);
}

function blockedStagingSubagent(input: unknown): boolean {
  const text = JSON.stringify(input);
  return /forgedock-owner|worker|writer|claude-code-writer|codex-exec-writer|cursor-agent-writer/.test(text);
}

/** Narrow route guard: staging may inspect/check/publish evidence, never mutate product code or deliver it. */
export function isStagingMutationBlocked(toolName: string, input: unknown): boolean {
  if (["edit", "write", "powershell"].includes(toolName)) return true;
  if (toolName === "bash" && typeof input === "object" && input !== null && blockedStagingShell((input as { command?: unknown }).command as string ?? "")) return true;
  if (toolName === "subagent" && blockedStagingSubagent(input)) return true;
  return false;
}

export default function forgedockCandidateExtension(pi: ExtensionAPI): void {
  let stagingGuard = false;
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
