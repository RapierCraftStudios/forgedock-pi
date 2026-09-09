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

const CAPABILITY_TYPES = new Set([
  "unit",
  "api",
  "runtime",
  "integration",
  "e2e",
  "queue",
  "database",
  "browser",
  "credential",
  "manual",
]);
const CAPABILITY_TYPES_REQUIRING_BOUNDARY = new Set([
  "unit",
  "api",
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
  const matches = [...value.matchAll(/^<!-- FORGE:TEST_GATE:RESULT=(BLOCK|PASS|SKIP) -->$/gm)];
  if (matches.length !== 1) return undefined;
  const verdict = matches[0]?.[1] as TestGateVerdict | undefined;
  if (!verdict) return undefined;

  const capabilities: VerificationCapability[] = [];
  const capabilityLines = value
    .split("\n")
    .filter((line) => /FORGE:TEST_GATE:CAPABILITY(?:=|$)/.test(line));
  for (const match of value.matchAll(/^FORGE:TEST_GATE:CAPABILITY=(\{.*\})$/gm)) {
    let parsed: unknown;
    try {
      if (hasDuplicateJsonKeys(match[1]!)) return undefined;
      parsed = JSON.parse(match[1]!);
    } catch {
      return undefined;
    }
    const capability = parseCapability(parsed);
    if (!capability || capabilities.some((row) => row.id === capability.id))
      return undefined;
    capabilities.push(capability);
  }
  if (capabilityLines.length !== capabilities.length) return undefined;
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
  sourceTree: string;
}

export interface ExpectedCapability {
  id: string;
  criterionId: string;
  criterionTextHash: string;
  required: boolean;
}

export function testGateVerification(
  value: unknown,
  requireCapabilityReport = false,
  expectedIdentity?: TestGateIdentity,
  expectedCapabilities?: readonly ExpectedCapability[],
): VerificationResult {
  const result = parseTestGateResult(value);
  if (!result) return failedGate("Malformed or missing test-gate result.");
  if (requireCapabilityReport &&
    (!result.capabilitiesComplete || expectedCapabilities === undefined || !expectedIdentity?.sourceTree))
    return failedGate(
      "Required capability report is missing, malformed, incomplete, or unbound; rerun the bound gate.",
      result.capabilities,
    );
  if (expectedCapabilities) {
    if (new Set(expectedCapabilities.map((capability) => capability.id)).size !== expectedCapabilities.length)
      return failedGate("Bound capability contract contains duplicate IDs.");
    const expected = new Map(expectedCapabilities.map((capability) => [capability.id, capability]));
    const actual = new Map(result.capabilities.map((capability) => [capability.id, capability]));
    const missing = [...expected].filter(([id, capability]) => {
      const row = actual.get(id);
      return !row || row.criterionId !== capability.criterionId ||
        row.criterionTextHash !== capability.criterionTextHash || row.required !== capability.required;
    });
    if (actual.size !== expected.size || missing.length > 0) {
      const details = missing.map(([id, capability]) =>
        `capability=${id} criterion=${capability.criterionId} textHash=${capability.criterionTextHash} source=${expectedIdentity?.repository ?? "bound-repository"}@${expectedIdentity?.sourceHead ?? "bound-head"} target=${expectedIdentity?.target ?? "bound-target"} tree=${expectedIdentity?.sourceTree ?? "bound-tree"} boundary=unbound command=unbound state=MISSING wake=emit the bound capability row`,
      );
      return failedGate("Capability report does not match the bound criterion contract.", result.capabilities, details);
    }
  }
  const identityMismatch = expectedIdentity
    ? result.capabilities.filter(
        (capability) =>
          capability.repository !== expectedIdentity.repository ||
          capability.target !== expectedIdentity.target ||
          capability.sourceHead !== expectedIdentity.sourceHead ||
          capability.sourceTree !== expectedIdentity.sourceTree,
      )
    : [];
  if (identityMismatch.length > 0)
    return failedGate("Capability source identity does not match the reviewed route.", identityMismatch);
  if (
    result.verdict === "SKIP" &&
    result.capabilities.some((capability) => capability.required)
  )
    return failedGate(
      "Required capability rows cannot be reported as SKIP.",
      result.capabilities.filter((capability) => capability.required),
    );
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
      ...(result.capabilities[0] ? { capability: result.capabilities[0], capabilities: result.capabilities } : {}),
      ...(result.capabilities.length ? { evidence: capabilityEvidence(result.capabilities) } : {}),
    };
  if (result.verdict === "SKIP") {
    const optional = result.capabilities.filter((capability) => !capability.required);
    return {
      name: "test-gate",
      required: false,
      status: "skipped",
      ...(optional[0] ? { capability: optional[0], capabilities: result.capabilities } : {}),
      ...(result.capabilities.length ? { evidence: capabilityEvidence(result.capabilities) } : {}),
    };
  }
  return failedGate(result.reason ?? "Test-gate returned BLOCK.", result.capabilities);
}

function failedGate(
  reason: string,
  capabilities: readonly VerificationCapability[] = [],
  extraEvidence: readonly string[] = [],
): VerificationResult {
  return {
    name: "test-gate",
    required: true,
    status: "failed",
    exitCode: 1,
    ...(capabilities[0] ? { capability: capabilities[0], capabilities } : {}),
    evidence: [
      reason,
      ...extraEvidence,
      ...capabilities.map(
        (capability) =>
          `capability=${capability.id} criterion=${capability.criterionId} textHash=${capability.criterionTextHash} source=${capability.repository}@${capability.sourceHead} target=${capability.target} tree=${capability.sourceTree} boundary=${capability.boundary} command=${capability.command} state=${capability.state} wake=${capability.wake}`,
      ),
    ],
  };
}

function hasDuplicateJsonKeys(value: string): boolean {
  const keys = [...value.matchAll(/"([^"\\]+)"\s*:/g)].map((match) => match[1]);
  return new Set(keys).size !== keys.length;
}

function capabilityEvidence(capabilities: readonly VerificationCapability[]): string[] {
  return capabilities.map(
    (capability) =>
      `capability=${capability.id} criterion=${capability.criterionId} textHash=${capability.criterionTextHash} source=${capability.repository}@${capability.sourceHead} target=${capability.target} tree=${capability.sourceTree} boundary=${capability.boundary} command=${capability.command} state=${capability.state} proofKind=${capability.proofKind} wake=${capability.wake}`,
  );
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
    "proofKind",
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
  if (!CAPABILITY_TYPES.has(row.type as string)) return undefined;
  if (row.proofKind !== "behavioral" && row.proofKind !== "structural") return undefined;
  if (
    CAPABILITY_TYPES_REQUIRING_BOUNDARY.has(row.type as string) &&
    row.proofKind !== "behavioral"
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
    proofKind: row.proofKind as "behavioral" | "structural",
    proof: row.proof as string,
    wake: row.wake as string,
  };
}
