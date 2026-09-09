import type {
  VerificationCapability,
  VerificationCapabilityState,
  VerificationResult,
} from "../core/review.ts";

export type TestGateVerdict = "BLOCK" | "PASS" | "SKIP";

export interface TestGateResult {
  verdict: TestGateVerdict;
  reason?: string;
  capabilities: readonly VerificationCapability[];
  capabilitiesComplete: boolean;
}

const CAPABILITY_TYPES_REQUIRING_BOUNDARY = new Set([
  "runtime",
  "integration",
  "e2e",
  "queue",
  "database",
  "browser",
  "credential",
]);
const CAPABILITY_STATES = new Set<VerificationCapabilityState>([
  "PASS",
  "FAIL",
  "MISSING",
  "SKIPPED",
  "UNKNOWN",
  "CONTRADICTED",
]);

/** Parse the authoritative result and its structured capability rows. */
export function parseTestGateResult(value: unknown): TestGateResult | undefined {
  if (typeof value !== "string") return undefined;
  const matches = [...value.matchAll(/FORGE:TEST_GATE:RESULT=(BLOCK|PASS|SKIP)/g)];
  const verdict = matches.at(-1)?.[1] as TestGateVerdict | undefined;
  if (!verdict) return undefined;

  const capabilities: VerificationCapability[] = [];
  for (const match of value.matchAll(/^FORGE:TEST_GATE:CAPABILITY=(\{.*\})$/gm)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]!);
    } catch {
      return undefined;
    }
    const capability = parseCapability(parsed);
    if (!capability || capabilities.some((row) => row.id === capability.id))
      return undefined;
    capabilities.push(capability);
  }
  const completeMatch = value.match(/FORGE:TEST_GATE:CAPABILITIES_COMPLETE count=(\d+)/);
  const capabilitiesComplete =
    completeMatch !== null && Number(completeMatch[1]) === capabilities.length;
  const reason = value.match(
    /FORGE:TEST_GATE:(?:BLOCK|PASS|SKIP)\|reason=([^\s\n]+)/,
  )?.[1];
  return {
    verdict,
    ...(reason ? { reason } : {}),
    capabilities,
    capabilitiesComplete,
  };
}

/**
 * Convert a nested test-gate result into a review check. Strict staging review
 * requires the complete capability report; required non-PASS rows stay required
 * failures and carry the exact diagnostic evidence for the review gate.
 */
export interface TestGateIdentity {
  repository: string;
  target: string;
  sourceHead: string;
}

export function testGateVerification(
  value: unknown,
  requireCapabilityReport = false,
  expectedIdentity?: TestGateIdentity,
): VerificationResult {
  const result = parseTestGateResult(value);
  if (!result) return failedGate("Malformed or missing test-gate result.");
  if (requireCapabilityReport && !result.capabilitiesComplete)
    return failedGate(
      "Required capability report is missing, malformed, or incomplete; rerun the bound gate.",
      result.capabilities,
    );

  const identityMismatch = expectedIdentity
    ? result.capabilities.filter(
        (capability) =>
          capability.repository !== expectedIdentity.repository ||
          capability.target !== expectedIdentity.target ||
          capability.sourceHead !== expectedIdentity.sourceHead,
      )
    : [];
  if (identityMismatch.length > 0)
    return failedGate("Capability source identity does not match the reviewed route.", identityMismatch);
  const unresolved = result.capabilities.filter(
    (capability) => capability.required && capability.state !== "PASS",
  );
  if (unresolved.length > 0)
    return failedGate(
      unresolved
        .map(
          (capability) =>
            `Required capability ${capability.id} for ${capability.criterionId} is ${capability.state}; wake: ${capability.wake}`,
        )
        .join("; "),
      unresolved,
    );
  if (result.verdict === "PASS")
    return {
      name: "test-gate",
      required: true,
      status: "passed",
      ...(result.capabilities[0] ? { capability: result.capabilities[0] } : {}),
    };
  if (result.verdict === "SKIP") {
    const optional = result.capabilities.filter((capability) => !capability.required);
    return {
      name: "test-gate",
      required: false,
      status: "skipped",
      ...(optional[0] ? { capability: optional[0] } : {}),
    };
  }
  return failedGate(result.reason ?? "Test-gate returned BLOCK.", result.capabilities);
}

function failedGate(
  reason: string,
  capabilities: readonly VerificationCapability[] = [],
): VerificationResult {
  return {
    name: "test-gate",
    required: true,
    status: "failed",
    exitCode: 1,
    ...(capabilities[0] ? { capability: capabilities[0] } : {}),
    evidence: [
      reason,
      ...capabilities.map(
        (capability) =>
          `capability=${capability.id} criterion=${capability.criterionId} source=${capability.repository}@${capability.sourceHead} tree=${capability.sourceTree} boundary=${capability.boundary} state=${capability.state} wake=${capability.wake}`,
      ),
    ],
  };
}

function parseCapability(value: unknown): VerificationCapability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const strings = [
    "id",
    "criterionId",
    "criterionTextHash",
    "type",
    "boundary",
    "command",
    "repository",
    "target",
    "sourceHead",
    "sourceTree",
    "proof",
    "wake",
  ];
  const expectedKeys = new Set([...strings, "required", "state"]);
  if (Object.keys(row).some((key) => !expectedKeys.has(key))) return undefined;
  if (strings.some((key) => typeof row[key] !== "string" || !(row[key] as string).trim()))
    return undefined;
  if (!/^sha256:[a-f0-9]{64}$/.test(row.criterionTextHash as string)) return undefined;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row.sourceHead as string)) return undefined;
  if (typeof row.required !== "boolean" || typeof row.state !== "string") return undefined;
  const state = row.state as VerificationCapabilityState;
  if (!CAPABILITY_STATES.has(state)) return undefined;
  if (
    CAPABILITY_TYPES_REQUIRING_BOUNDARY.has(row.type as string) &&
    !/^behavioral(?: boundary)? evidence/i.test(row.proof as string)
  )
    return undefined;
  return {
    id: row.id as string,
    criterionId: row.criterionId as string,
    criterionTextHash: row.criterionTextHash as string,
    type: row.type as string,
    boundary: row.boundary as string,
    command: row.command as string,
    repository: row.repository as string,
    target: row.target as string,
    sourceHead: row.sourceHead as string,
    sourceTree: row.sourceTree as string,
    required: row.required as boolean,
    state,
    proof: row.proof as string,
    wake: row.wake as string,
  };
}
