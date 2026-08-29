import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FORGE_PROMPT_ALIASES = Object.freeze({
  orchestrate: "forgedock-orchestrate",
  "work-on": "forgedock-work-on",
  "review-pr": "forgedock-review-pr",
  "review-pr-staging": "forgedock-review-pr-staging",
} as const);

const ALIAS_PATTERN =
  /^\/(?:forge:)?(orchestrate|work-on|review-pr|review-pr-staging)(?=$|\s)([\s\S]*)$/;

/** Rewrite friendly ForgeDock commands into native Pi skill calls. */
export function rewriteForgePromptAlias(input: string): string | undefined {
  const match = input.match(ALIAS_PATTERN);
  if (!match) return undefined;
  const command = match[1] as keyof typeof FORGE_PROMPT_ALIASES;
  return `/skill:${FORGE_PROMPT_ALIASES[command]}${match[2] ?? ""}`;
}

/** Register the lexical command router. Workflow decisions remain in prompt specs. */
export function registerForgePromptRouter(pi: ExtensionAPI): void {
  pi.on("input", (event) => {
    if (event.source === "extension") return { action: "continue" };
    const rewritten = rewriteForgePromptAlias(event.text);
    if (rewritten === undefined) return { action: "continue" };
    return { action: "transform", text: rewritten };
  });
}
