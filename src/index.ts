import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerForgePromptRouter } from "./prompt-router.ts";

export {
  FORGEDOCK_EVENT_SCHEMA,
  FORGEDOCK_LEASE_SCHEMA,
  FORGEDOCK_PI_VERSION,
} from "./core/version.ts";

/**
 * ForgeDock's extension layer is intentionally lexical only.
 * Skills and their visible coordinator own every workflow decision.
 */
export default function forgedockPiExtension(pi: ExtensionAPI): void {
  registerForgePromptRouter(pi);
}

export {
  forgeCapabilityDiagnostics,
  FORGE_COORDINATOR_CAPABILITY_PROFILE,
  validateForgeAgentCapabilityProfile,
} from "./agents/profile.ts";
export {
  FORGE_NESTED_SKILL_TRANSLATIONS,
  FORGE_PUBLIC_SKILLS,
  resolveForgeSkillReference,
  resolveReachableForgeSkillReferences,
} from "./package-contract.ts";
