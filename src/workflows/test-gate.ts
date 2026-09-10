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
  const runtime = RUNTIME_TYPES.has(proofType) || /^(?:runtime|integration|e2e|queue|database|browser|credential):/.test(capability);
  if (runtime && proofType === "structural") return undefined;
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

/**
 * Convert a test-gate result into a required review check. Bare PASS/SKIP markers,
 * malformed or unresolved capabilities, and runtime claims with structural proof all
 * remain failed required checks.
 */
export function testGateVerification(
  value: unknown,
  expectedSourceHead?: string,
): VerificationResult {
  const result = parseTestGateResult(value);
  if (!result) {
    return {
      name: "test-gate",
      required: true,
      status: "failed",
      exitCode: 1,
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
    };
  }
  return {
    name: "test-gate",
    required: true,
    status: "passed",
  };
}
