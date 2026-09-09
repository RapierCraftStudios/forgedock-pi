import type { VerificationResult } from "../core/review.ts";

export type TestGateVerdict = "BLOCK" | "PASS" | "SKIP";

export type VerificationCapabilityState =
  | "PASS"
  | "MISSING"
  | "SKIPPED"
  | "UNKNOWN"
  | "CONTRADICTED";

export interface VerificationCapabilityRecord {
  v: 1;
  capability: string;
  criterion: string;
  criterionTextHash: string;
  sourceHead: string;
  contractDigest: string;
  proofType: string;
  boundary: string;
  state: VerificationCapabilityState;
  evidence: string;
  wakeCondition: string;
}

export interface TestGateRequirement {
  capability: string;
  criterion: string;
  criterionTextHash: string;
  contractDigest: string;
  proofType: string;
  boundary: string;
}

export interface TestGateResult {
  verdict: TestGateVerdict;
  reason?: string;
  capabilities?: readonly VerificationCapabilityRecord[];
}

const capabilityStates = new Set<VerificationCapabilityState>([
  "PASS",
  "MISSING",
  "SKIPPED",
  "UNKNOWN",
  "CONTRADICTED",
]);
const requiredProofTypes = new Set([
  "runtime",
  "integration",
  "e2e",
  "queue",
  "database",
  "browser",
  "credential",
]);
const knownProofTypes = new Set([...requiredProofTypes, "structural", "manual"]);
const hash = /^sha256:[a-f0-9]{64}$/;
const sourceHead = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function isCapabilityRecord(value: unknown): value is VerificationCapabilityRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<VerificationCapabilityRecord>;
  return record.v === 1 &&
    typeof record.capability === "string" && record.capability.length > 0 &&
    typeof record.criterion === "string" && record.criterion.length > 0 &&
    typeof record.criterionTextHash === "string" && hash.test(record.criterionTextHash) &&
    typeof record.sourceHead === "string" && sourceHead.test(record.sourceHead) &&
    typeof record.contractDigest === "string" && hash.test(record.contractDigest) &&
    typeof record.proofType === "string" && record.proofType.length > 0 &&
    typeof record.boundary === "string" && record.boundary.length > 0 &&
    typeof record.state === "string" && capabilityStates.has(record.state as VerificationCapabilityState) &&
    typeof record.evidence === "string" &&
    typeof record.wakeCondition === "string";
}

export function parseVerificationCapabilities(value: string): readonly VerificationCapabilityRecord[] | undefined {
  const markers = [...value.matchAll(/FORGE:VERIFICATION_CAPABILITY (\{[^\n]+\})/g)];
  if (!markers.length) return undefined;
  const records: VerificationCapabilityRecord[] = [];
  for (const marker of markers) {
    try {
      const parsed: unknown = JSON.parse(marker[1]!);
      if (!isCapabilityRecord(parsed)) return undefined;
      records.push(parsed);
    } catch {
      return undefined;
    }
  }
  return records;
}

function capabilityTypeMatches(capability: VerificationCapabilityRecord): boolean {
  if (!knownProofTypes.has(capability.proofType)) return false;
  if (capability.proofType === "structural" || capability.proofType === "manual")
    return capability.capability.startsWith(`${capability.proofType}:`);
  return capability.capability.startsWith(`${capability.proofType}:`) &&
    !/(?:source[- ]string|structural)/i.test(`${capability.boundary} ${capability.evidence}`);
}

function blockedEvidenceMatches(value: string, capability: VerificationCapabilityRecord): boolean {
  const markers = [...value.matchAll(/FORGE:VERIFICATION_BLOCKED (\{[^\n]+\})/g)];
  return markers.some((marker) => {
    try {
      const parsed = JSON.parse(marker[1]!) as Partial<VerificationCapabilityRecord>;
      return parsed.capability === capability.capability &&
        parsed.criterion === capability.criterion &&
        parsed.criterionTextHash === capability.criterionTextHash &&
        parsed.sourceHead === capability.sourceHead &&
        parsed.contractDigest === capability.contractDigest &&
        parsed.state === capability.state &&
        parsed.wakeCondition === capability.wakeCondition;
    } catch {
      return false;
    }
  });
}

function capabilityFailure(value: string, capabilities: readonly VerificationCapabilityRecord[] | undefined): string | undefined {
  if (value.includes("FORGE:VERIFICATION_CAPABILITY") && !capabilities)
    return "malformed verification capability record";
  for (const capability of capabilities ?? []) {
    if (!capabilityTypeMatches(capability))
      return `capability ${capability.capability} has an invalid proof type or boundary`;
    const required = requiredProofTypes.has(capability.proofType);
    if (required && capability.state !== "PASS") {
      return blockedEvidenceMatches(value, capability)
        ? `required capability ${capability.capability} is ${capability.state}`
        : `required capability ${capability.capability} is ${capability.state} without blocked evidence`;
    }
    if (required && capability.state === "PASS" && !capability.evidence.trim())
      return `required capability ${capability.capability} has no evidence`;
  }
  return undefined;
}

/** Parse the authoritative test-gate and capability markers emitted by the packaged skill. */
export function parseTestGateResult(
  value: unknown,
  expected?: { sourceHead?: string; requirements?: readonly TestGateRequirement[] },
): TestGateResult | undefined {
  if (typeof value !== "string") return undefined;
  const matches = [...value.matchAll(/FORGE:TEST_GATE:RESULT=(BLOCK|PASS|SKIP)/g)];
  const verdict = matches.at(-1)?.[1] as TestGateVerdict | undefined;
  if (!verdict) return undefined;
  const capabilities = parseVerificationCapabilities(value);
  const identityFailure = expected?.sourceHead && capabilities?.some((capability) => capability.sourceHead !== expected.sourceHead)
    ? `capability source head does not match reviewed head ${expected.sourceHead}`
    : expected?.requirements && capabilities &&
        (capabilities.length !== expected.requirements.length || expected.requirements.some((requirement) => {
          const capability = capabilities.find((candidate) => candidate.criterion === requirement.criterion);
          return !capability || capability.capability !== requirement.capability ||
            capability.criterionTextHash !== requirement.criterionTextHash ||
            capability.contractDigest !== requirement.contractDigest ||
            capability.proofType !== requirement.proofType || capability.boundary !== requirement.boundary;
        }))
      ? "capability record does not match the bound contract requirements"
      : expected?.requirements?.length && !capabilities
        ? "bound required capabilities are missing"
        : undefined;
  const failure = identityFailure ?? capabilityFailure(value, capabilities);
  const explicitlyNoRequiredCapabilities = /^<!-- FORGE:VERIFICATION_NO_REQUIRED_CAPABILITIES -->$/m.test(value);
  const reason = value.match(
    /FORGE:TEST_GATE:(?:BLOCK|PASS|SKIP)\|reason=([^\s\n]+)/,
  )?.[1];
  if (failure) return { verdict: "BLOCK", reason: failure, capabilities };
  if ((verdict === "PASS" || verdict === "SKIP") && !capabilities && !explicitlyNoRequiredCapabilities)
    return { verdict: "BLOCK", reason: `${verdict} lacks required-capability preflight evidence` };
  return { verdict, ...(reason ? { reason } : {}), ...(capabilities ? { capabilities } : {}) };
}

/**
 * Convert a nested test-gate result into a review check. An absent marker is a
 * failed required check, while an explicit SKIP remains visible and non-blocking
 * exactly as the original staging specification defines it.
 */
export function testGateVerification(
  value: unknown,
  expected?: { sourceHead?: string; requirements?: readonly TestGateRequirement[] },
): VerificationResult {
  const result = parseTestGateResult(value, expected);
  if (!result) {
    return {
      name: "test-gate",
      required: true,
      status: "failed",
      exitCode: 1,
    };
  }
  if (result.verdict === "PASS") {
    return { name: "test-gate", required: true, status: "passed" };
  }
  if (result.verdict === "SKIP") {
    return { name: "test-gate", required: false, status: "skipped" };
  }
  return { name: "test-gate", required: true, status: "failed", exitCode: 1 };
}
