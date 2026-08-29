import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerForgePromptRouter } from "./prompt-router.ts";

/**
 * ForgeDock's extension layer is intentionally lexical only.
 * Skills and their visible coordinator own every workflow decision.
 */
export default function forgedockPiExtension(pi: ExtensionAPI): void {
  registerForgePromptRouter(pi);
}
