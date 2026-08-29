import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerForgePromptRouter } from "./prompt-router.ts";
import { registerForgeRuntimeTools } from "./runtime-tools.ts";

export {
  FORGEDOCK_EVENT_SCHEMA,
  FORGEDOCK_LEASE_SCHEMA,
  FORGEDOCK_PI_VERSION,
} from "./core/version.ts";
export {
  resolveStagingBundle,
  resolveStagingBundleAsync,
  StagingBundleResolutionError,
} from "./core/staging-bundle-resolver.ts";
export type {
  AsyncStagingBundleReachability,
  FrozenStagingBundleRoute,
  ResolvedStagingPullRequest,
  StagingBundleCandidate,
  StagingBundleDerivation,
  StagingBundleEvidence,
  StagingBundleEvidenceKind,
  StagingBundleReachability,
  StagingBundleResolution,
} from "./core/staging-bundle-resolver.ts";

/**
 * ForgeDock's extension layer is intentionally lexical only.
 * Skills and their visible coordinator own every workflow decision.
 */
export default function forgedockPiExtension(pi: ExtensionAPI): void {
  registerForgePromptRouter(pi);
  registerForgeRuntimeTools(pi);
}

export {
  forgeCapabilityDiagnostics,
  FORGE_COORDINATOR_CAPABILITY_PROFILE,
  validateForgeAgentCapabilityProfile,
} from "./agents/profile.ts";
export { loadForgeYaml, parseForgeYaml, ForgeYamlError } from "./adapters/forge-yaml.ts";
export { preflightGitHubCapabilities, GitHubCapabilityError } from "./adapters/github-capabilities.ts";
export {
  assertReviewFindingReadbackPaths,
  normalizeReviewFindingMetadata,
  trustedAffectedPathsForDag,
} from "./core/review-integrity.ts";
export {
  VERIFICATION_DIAGNOSTIC_SCHEMA,
  classifyVerificationDiagnostics,
  classifyVerificationOutput,
  formatSkippedVerification,
  isVerificationDiagnosticReport,
  parseVerificationDiagnostics,
} from "./core/verification-diagnostics.ts";
export type {
  DiagnosticKind,
  FallbackStatus,
  SkippedVerification,
  ValidationFallback,
  ValidationEnvironment,
  VerificationDiagnostic,
  VerificationDiagnosticReport,
} from "./core/verification-diagnostics.ts";
export {
  FORGE_NESTED_SKILL_TRANSLATIONS,
  FORGE_PUBLIC_SKILLS,
  resolveForgeSkillReference,
  resolveReachableForgeSkillReferences,
} from "./package-contract.ts";
