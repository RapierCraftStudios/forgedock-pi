// The coding-agent package is a dev dependency for the lexical Pi extension contract.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerForgePromptRouter } from "./prompt-router.ts";

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
}

export {
  forgeCapabilityDiagnostics,
  FORGE_COORDINATOR_CAPABILITY_PROFILE,
  validateForgeAgentCapabilityProfile,
} from "./agents/profile.ts";
export {
  loadForgeYaml,
  parseForgeYaml,
  projectForgeYaml,
  ForgeYamlError,
} from "./adapters/forge-yaml.ts";
export { preflightGitHubCapabilities, GitHubCapabilityError } from "./adapters/github-capabilities.ts";
export {
  createIntegrationLane,
  legacyFastLane,
  normalizeIntegrationSlug,
  normalizeStableId,
  validateGitRef,
  validateIntegrationLane,
  workOrderBranchName,
  INTEGRATION_LANE_SCHEMA,
  IntegrationLaneValidationError,
} from "./core/integration-lane.ts";
export type {
  IntegrationLane,
  IntegrationLaneBase,
  IntegrationLaneInput,
  IntegrationLaneKind,
  IntegrationLaneMember,
  IntegrationLanePromotion,
  IntegrationLaneStatus,
} from "./core/integration-lane.ts";
export {
  ORCHESTRATION_EVENT_SCHEMA,
  ORCHESTRATION_STATE_SCHEMA,
  aggregateOrchestrationStatus,
  applyOrchestrationEvent,
  blockedOrchestrationLanes,
  createOrchestrationEvent,
  hashOrchestrationGraph,
  isTerminalLane,
  nextIntegrationLane,
  readyOrchestrationLanes,
  replayOrchestrationEvents,
  OrchestrationTransitionError,
} from "./core/orchestration.ts";
export type {
  BlockedOrchestrationLane,
  OrchestrationDependencyEdge,
  OrchestrationEvent,
  OrchestrationEventType,
  OrchestrationLane,
  OrchestrationLaneStatus,
  OrchestrationState,
  OrchestrationStatus,
} from "./core/orchestration.ts";
export {
  ORCHESTRATION_RECOVERY_SCHEMA,
  classifyOrchestrationLane,
  createOrchestrationBatchState,
  orchestrationChildKey,
  planOrchestrationReload,
  renderOrchestrationReloadReport,
} from "./core/orchestration-recovery.ts";
export type {
  OrchestrationBatchState,
  OrchestrationClassification,
  OrchestrationQueueEntry,
  OrchestrationReloadPlan,
  RetainedOrchestrationChild,
} from "./core/orchestration-recovery.ts";
export {
  assertReviewFindingReadbackPaths,
  normalizeReviewFindingMetadata,
  trustedAffectedPathsForDag,
} from "./core/review-integrity.ts";
export {
  FORGE_NESTED_SKILL_TRANSLATIONS,
  FORGE_PUBLIC_SKILLS,
  resolveForgeSkillReference,
  resolveReachableForgeSkillReferences,
} from "./package-contract.ts";
