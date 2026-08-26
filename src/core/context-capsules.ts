import { createHash } from "node:crypto";

import { canonicalJson } from "./events.ts";

export const CAPSULE_SCHEMAS = {
  intent: "forgedock.intent-capsule/v1",
  investigation: "forgedock.investigation-capsule/v1",
  contract: "forgedock.contract-capsule/v1",
  review: "forgedock.review-capsule/v1",
  remediation: "forgedock.remediation-capsule/v1",
} as const;

export interface CapsuleProvenance {
  producerRole: string;
  runId: string;
  sourceHash: string;
  createdAt: string;
}

export interface ContextReference {
  path: string;
  revision: string;
  sha256: string;
  bytes: number;
  reason: string;
  scope: string;
}

interface CapsuleEnvelope {
  schema: (typeof CAPSULE_SCHEMAS)[keyof typeof CAPSULE_SCHEMAS];
  runId: string;
  issueNumber: number;
  repository: string;
  baseBranch: string;
  baseSha: string;
  provenance: CapsuleProvenance;
  digest: string;
}

export interface IntentResolutionCapsule extends CapsuleEnvelope {
  schema: typeof CAPSULE_SCHEMAS.intent;
  sourceExpressionHash: string;
  mode: "work-on" | "orchestrate";
  candidateIssueNumbers: readonly number[];
  excluded: readonly { issueNumber: number; reason: string }[];
  orderingReason: string;
  confidence: "high" | "medium" | "low";
  ambiguity?: string;
}

export interface InvestigationCapsule extends CapsuleEnvelope {
  schema: typeof CAPSULE_SCHEMAS.investigation;
  issueSnapshotHash: string;
  taskType: "bug" | "feature" | "maintenance" | "security" | "unknown";
  facts: readonly { statement: string; evidence: readonly string[] }[];
  acceptanceCriteria: readonly string[];
  decomposition: readonly string[];
  hazards: readonly string[];
  unresolvedAmbiguities: readonly string[];
  context: readonly ContextReference[];
}

export interface ContractCapsule extends CapsuleEnvelope {
  schema: typeof CAPSULE_SCHEMAS.contract;
  investigationDigest: string;
  allowedPaths: readonly string[];
  forbiddenChanges: readonly string[];
  invariants: readonly string[];
  acceptanceCriteria: readonly string[];
  criterionMapping: readonly {
    criterion: string;
    evidenceRequired: string;
  }[];
  verificationRequirements: readonly string[];
  remediationBoundaries: readonly string[];
  authorityHazards: readonly string[];
}

export interface ReviewCapsule extends CapsuleEnvelope {
  schema: typeof CAPSULE_SCHEMAS.review;
  pullNumber: number;
  round: number;
  headSha: string;
  changedFiles: readonly string[];
  changedLineRanges: readonly string[];
  diffSha256: string;
  contractDigest: string;
  acceptanceCriteria: readonly string[];
  reviewScope: string;
}

export interface RemediationCapsule extends CapsuleEnvelope {
  schema: typeof CAPSULE_SCHEMAS.remediation;
  pullNumber: number;
  round: number;
  headSha: string;
  contractDigest: string;
  selectedFindings: readonly {
    id: string;
    file: string;
    line: number;
    summary: string;
    evidence: readonly string[];
  }[];
  requiredChecks: readonly string[];
}

export type ForgeCapsule =
  | IntentResolutionCapsule
  | InvestigationCapsule
  | ContractCapsule
  | ReviewCapsule
  | RemediationCapsule;

export function capsuleDigest(
  value: Omit<ForgeCapsule, "digest"> | Record<string, unknown>,
): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function sealCapsule<T extends Omit<ForgeCapsule, "digest">>(
  value: T,
): T & { digest: string } {
  return { ...value, digest: capsuleDigest(value as Record<string, unknown>) };
}

export function validateCapsule(
  value: unknown,
  options: { maxBytes?: number } = {},
): asserts value is ForgeCapsule {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Forge capsule must be an object.");
  const capsule = value as Record<string, unknown>;
  if (!Object.values(CAPSULE_SCHEMAS).includes(capsule.schema as never))
    throw new TypeError("Forge capsule schema is unsupported.");
  for (const field of ["runId", "repository", "baseBranch", "baseSha", "digest"])
    if (typeof capsule[field] !== "string" || !(capsule[field] as string).trim())
      throw new TypeError(`Forge capsule ${field} is required.`);
  if (!Number.isSafeInteger(capsule.issueNumber) || (capsule.issueNumber as number) < 1)
    throw new TypeError("Forge capsule issueNumber must be positive.");
  const bytes = Buffer.byteLength(canonicalJson(value));
  if (bytes > (options.maxBytes ?? 256 * 1024))
    throw new TypeError("Forge capsule exceeds the configured size limit.");
  const { digest, ...content } = capsule;
  if (digest !== capsuleDigest(content))
    throw new TypeError("Forge capsule digest does not match its content.");
}
