export interface ForgeAgentCapabilityProfile {
  name: string;
  tools?: readonly string[];
  allowNestedSubagents?: boolean;
  maxSubagentDepth?: number;
  /** A profile that owns the mandatory review fanout must say so explicitly. */
  mandatoryNestedReview?: boolean;
}

/**
 * Validate the capability claims that make a ForgeDock agent loadable.
 *
 * This is deliberately a profile check, not a dispatcher: it never launches an
 * agent or chooses a workflow phase. pi-subagents performs the final resolved
 * tool check during its preflight; this check catches contradictory Forge-owned
 * definitions before they can be registered or materialized.
 */
export function validateForgeAgentCapabilityProfile(
  profile: ForgeAgentCapabilityProfile,
): void {
  if (!profile.name.trim()) throw new TypeError("Agent name is required.");
  const tools = new Set(profile.tools ?? []);
  if (profile.allowNestedSubagents === true) {
    if (!tools.has("subagent")) {
      throw new Error(
        `Agent '${profile.name}' allows nested subagents but does not resolve the native subagent tool.`,
      );
    }
    if (
      profile.maxSubagentDepth === undefined ||
      !Number.isSafeInteger(profile.maxSubagentDepth) ||
      profile.maxSubagentDepth < 2
    ) {
      throw new Error(
        `Agent '${profile.name}' allows nested subagents but has no depth ceiling of at least 2.`,
      );
    }
  }
  if (profile.mandatoryNestedReview && profile.allowNestedSubagents !== true) {
    throw new Error(
      `Agent '${profile.name}' owns mandatory nested review but does not allow nested subagents.`,
    );
  }
}

export const FORGE_COORDINATOR_CAPABILITY_PROFILE = Object.freeze({
  name: "forgedock-work-on-coordinator",
  tools: ["subagent"],
  allowNestedSubagents: true,
  maxSubagentDepth: 2,
  mandatoryNestedReview: true,
} satisfies ForgeAgentCapabilityProfile);

export function forgeCapabilityDiagnostics(
  availableTools: readonly string[],
): readonly string[] {
  const resolved = [...new Set(availableTools)].sort();
  return [
    `nested reviewer: ${resolved.includes("subagent") ? "available" : "unavailable"}`,
    `nested depth ceiling: ${FORGE_COORDINATOR_CAPABILITY_PROFILE.maxSubagentDepth}`,
    `coordinator resolved tools: ${resolved.join(", ") || "none"}`,
  ];
}
