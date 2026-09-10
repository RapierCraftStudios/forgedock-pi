import type { VerificationResult } from "../core/review.ts";

export type TestGateVerdict = "BLOCK" | "PASS" | "SKIP";
export type VerificationCapabilityState =
  | "PASS"
  | "MISSING"
  | "SKIPPED"
  | "UNKNOWN"
  | "CONTRADICTED";

export interface VerificationCapability {
  v: 1;
  capability: string;
  criterion: string;
  criterionTextHash: `sha256:${string}`;
  sourceHead: string;
  contractDigest: `sha256:${string}`;
  proofType: string;
  boundary: string;
  state: VerificationCapabilityState;
  evidence: string;
  wakeCondition: string;
}

export interface VerificationBlocked {
  capability: string;
  criterion: string;
  criterionTextHash: `sha256:${string}`;
  sourceHead: string;
  contractDigest: `sha256:${string}`;
  state: Exclude<VerificationCapabilityState, "PASS">;
  wakeCondition: string;
}

export interface VerificationCapabilityRequirement {
  capability: string;
  criterion: string;
  criterionTextHash: `sha256:${string}`;
  contractDigest: `sha256:${string}`;
  proofType: string;
  boundary: string;
}

export interface TestGateResult {
  verdict: TestGateVerdict;
  reason?: string;
  capabilities: readonly VerificationCapability[];
  blockedCapabilities: readonly VerificationBlocked[];
  malformedCapabilities: boolean;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const HEAD = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const STATES = new Set<VerificationCapabilityState>([
  "PASS",
  "MISSING",
  "SKIPPED",
  "UNKNOWN",
  "CONTRADICTED",
]);
const RUNTIME_TYPES = new Set([
  "runtime",
  "integration",
  "e2e",
  "queue",
  "database",
  "browser",
  "credential",
]);
const KNOWN_PROOF_TYPES = new Set([
  "runtime",
  "unit",
  "api",
  "integration",
  "e2e",
  "queue",
  "database",
  "browser",
  "credential",
  "structural",
]);
const CAPABILITY_MARKER =
  /<!--\s*FORGE:VERIFICATION_CAPABILITY\s+(\{[^\n]*\})\s*-->/g;
const BLOCKED_MARKER =
  /<!--\s*FORGE:VERIFICATION_BLOCKED\s+(\{[^\n]*\})\s*-->/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCapability(value: unknown): VerificationCapability | undefined {
  if (!isRecord(value)) return undefined;
  const fields = [
    "capability",
    "criterion",
    "criterionTextHash",
    "sourceHead",
    "contractDigest",
    "proofType",
    "boundary",
    "state",
    "evidence",
    "wakeCondition",
  ] as const;
  if (value.v !== 1 || fields.some((field) => typeof value[field] !== "string"))
    return undefined;
  const capability = value.capability as string;
  const criterion = value.criterion as string;
  const criterionTextHash = value.criterionTextHash as `sha256:${string}`;
  const sourceHead = value.sourceHead as string;
  const contractDigest = value.contractDigest as `sha256:${string}`;
  const proofType = value.proofType as string;
  const boundary = value.boundary as string;
  const state = value.state as VerificationCapabilityState;
  const evidence = value.evidence as string;
  const wakeCondition = value.wakeCondition as string;
  if (
    !capability ||
    !criterion ||
    /^criterion-\d+$/.test(criterion) ||
    !HASH.test(criterionTextHash) ||
    !HEAD.test(sourceHead) ||
    !HASH.test(contractDigest) ||
    !boundary ||
    !STATES.has(state)
  )
    return undefined;
  if (state === "PASS" && (!evidence || wakeCondition)) return undefined;
  if (state !== "PASS" && !wakeCondition) return undefined;
  if (!KNOWN_PROOF_TYPES.has(proofType)) return undefined;
  const capabilityType = capability.split(":", 1)[0] ?? "";
  const runtime =
    RUNTIME_TYPES.has(proofType) ||
    RUNTIME_TYPES.has(capabilityType) ||
    /^(?:runtime|integration|e2e|queue|database|browser|credential):/.test(capability);
  if (runtime && !RUNTIME_TYPES.has(proofType)) return undefined;
  if (!runtime && proofType === "structural" && capabilityType !== "structural")
    return undefined;
  return {
    v: 1,
    capability,
    criterion,
    criterionTextHash,
    sourceHead,
    contractDigest,
    proofType,
    boundary,
    state,
    evidence,
    wakeCondition,
  };
}

function parseCapabilityMarkers(value: string): {
  records: VerificationCapability[];
  malformed: boolean;
} {
  const records: VerificationCapability[] = [];
  let malformed = false;
  const markerCount = (value.match(/FORGE:VERIFICATION_CAPABILITY/g) ?? []).length;
  if (markerCount !== [...value.matchAll(CAPABILITY_MARKER)].length) malformed = true;
  for (const match of value.matchAll(CAPABILITY_MARKER)) {
    try {
      const parsed = parseCapability(JSON.parse(match[1]!));
      if (parsed) records.push(parsed);
      else malformed = true;
    } catch {
      malformed = true;
    }
  }
  return { records, malformed };
}

function parseBlockedMarkers(value: string): {
  records: VerificationBlocked[];
  malformed: boolean;
} {
  const records: VerificationBlocked[] = [];
  let malformed = false;
  const markerCount = (value.match(/FORGE:VERIFICATION_BLOCKED/g) ?? []).length;
  if (markerCount !== [...value.matchAll(BLOCKED_MARKER)].length) malformed = true;
  for (const match of value.matchAll(BLOCKED_MARKER)) {
    try {
      const candidate = JSON.parse(match[1]!) as Record<string, unknown>;
      const state = candidate.state as Exclude<VerificationCapabilityState, "PASS">;
      if (
        typeof candidate.capability === "string" &&
        typeof candidate.criterion === "string" &&
        !/^criterion-\d+$/.test(candidate.criterion) &&
        typeof candidate.criterionTextHash === "string" &&
        HASH.test(candidate.criterionTextHash) &&
        typeof candidate.sourceHead === "string" &&
        HEAD.test(candidate.sourceHead) &&
        typeof candidate.contractDigest === "string" &&
        HASH.test(candidate.contractDigest) &&
        STATES.has(state) &&
        candidate.state !== "PASS" &&
        typeof candidate.wakeCondition === "string" &&
        candidate.wakeCondition.length > 0
      ) {
        records.push({
          capability: candidate.capability,
          criterion: candidate.criterion,
          criterionTextHash: candidate.criterionTextHash as `sha256:${string}`,
          sourceHead: candidate.sourceHead,
          contractDigest: candidate.contractDigest as `sha256:${string}`,
          state,
          wakeCondition: candidate.wakeCondition,
        });
      } else malformed = true;
    } catch {
      malformed = true;
    }
  }
  return { records, malformed };
}

/** Parse the authoritative result and its identity-bound capability records. */
export function parseTestGateResult(value: unknown): TestGateResult | undefined {
  if (typeof value !== "string") return undefined;
  const matches = [...value.matchAll(/FORGE:TEST_GATE:RESULT=(BLOCK|PASS|SKIP)/g)];
  const verdict = matches.at(-1)?.[1] as TestGateVerdict | undefined;
  if (!verdict) return undefined;
  const reason = value.match(
    /FORGE:TEST_GATE:(?:BLOCK|PASS|SKIP)\|reason=([^\s\n]+)/,
  )?.[1];
  const capabilities = parseCapabilityMarkers(value);
  const blocked = parseBlockedMarkers(value);
  return {
    verdict,
    ...(reason ? { reason } : {}),
    capabilities: capabilities.records,
    blockedCapabilities: blocked.records,
    malformedCapabilities: capabilities.malformed || blocked.malformed,
  };
}

function blockedMarker(
  capability: VerificationBlocked | VerificationCapabilityRequirement | undefined,
  expectedSourceHead?: string,
): string {
  const sourceHead =
    capability && "sourceHead" in capability
      ? capability.sourceHead
      : expectedSourceHead && HEAD.test(expectedSourceHead)
        ? expectedSourceHead
        : "0".repeat(40);
  const record =
    capability && "state" in capability
      ? capability
      : {
          capability: capability?.capability ?? "unbound-required-capability",
          criterion: capability?.criterion ?? "unbound-required-capability",
          criterionTextHash:
            capability?.criterionTextHash ?? `sha256:${"0".repeat(64)}`,
          sourceHead,
          contractDigest:
            capability?.contractDigest ?? `sha256:${"0".repeat(64)}`,
          state: "UNKNOWN" as const,
          wakeCondition: "restore the bound verification capability",
        };
  return `<!-- FORGE:VERIFICATION_BLOCKED ${JSON.stringify(record)} -->`;
}

/**
 * Convert a test-gate result into a required review check. Bare PASS/SKIP markers,
 * malformed or unresolved capabilities, and runtime claims with structural proof all
 * remain failed required checks.
 */
export function testGateVerification(
  value: unknown,
  expectedSourceHead?: string,
  expectedCapabilities?: readonly VerificationCapabilityRequirement[],
): VerificationResult {
  const result = parseTestGateResult(value);
  if (!result) {
    return {
      name: "test-gate",
      required: true,
      status: "failed",
      exitCode: 1,
      verificationBlocked: blockedMarker(undefined, expectedSourceHead),
    };
  }
  const validPass =
    result.verdict === "PASS" &&
    result.capabilities.length > 0 &&
    !result.malformedCapabilities &&
    result.blockedCapabilities.length === 0 &&
    result.capabilities.every((capability) => capability.state === "PASS") &&
    new Set(result.capabilities.map((capability) => capability.sourceHead)).size === 1 &&
    new Set(result.capabilities.map((capability) => capability.contractDigest)).size === 1 &&
    Boolean(expectedCapabilities?.length) &&
    result.capabilities.length === expectedCapabilities!.length &&
    expectedCapabilities!.every((required) =>
      result.capabilities.some(
        (capability) =>
          capability.capability === required.capability &&
          capability.criterion === required.criterion &&
          capability.criterionTextHash === required.criterionTextHash &&
          capability.contractDigest === required.contractDigest &&
          capability.proofType === required.proofType &&
          capability.boundary === required.boundary,
      ),
    ) &&
    (!expectedSourceHead ||
      !HEAD.test(expectedSourceHead) ||
      result.capabilities.every(
        (capability) => capability.sourceHead === expectedSourceHead,
      ));
  if (!validPass) {
    return {
      name: "test-gate",
      required: true,
      status: "failed",
      exitCode: 1,
      verificationBlocked: blockedMarker(
        result.blockedCapabilities[0] ??
          result.capabilities[0] ??
          expectedCapabilities?.[0],
        expectedSourceHead,
      ),
    };
  }
  return {
    name: "test-gate",
    required: true,
    status: "passed",
  };
}
