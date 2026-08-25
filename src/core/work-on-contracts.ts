export type ForgeFindingCategory =
  | "security"
  | "data-loss"
  | "auth"
  | "billing"
  | "production-safety"
  | "correctness"
  | "performance"
  | "maintainability";

export interface ForgeReviewFindingResult {
  id: string;
  reviewer: string;
  runId: string;
  headSha: string;
  confidence: "confirmed" | "likely" | "possible";
  severity: "critical" | "high" | "medium" | "low";
  category: ForgeFindingCategory;
  file: string;
  line: number;
  summary: string;
  evidence: readonly string[];
}

export interface ForgeReviewerResult {
  schema: "forgedock.reviewer-result/v1";
  runId: string;
  reviewer: string;
  headSha: string;
  verdict: "pass" | "findings" | "blocked";
  findings: readonly ForgeReviewFindingResult[];
  filesReviewed: readonly string[];
  limitations: readonly string[];
}

export interface ForgeWorkOnResult {
  schema: "forgedock.work-on-result/v1";
  runId: string;
  issueNumber: number;
  status: "ready-for-merge" | "blocked" | "needs-human";
  branch: string;
  baseSha: string;
  headSha: string;
  changedFiles: readonly string[];
  verification: readonly {
    name: string;
    status: "passed" | "failed" | "skipped" | "unknown";
    exitCode?: number;
  }[];
  review: {
    headSha: string;
    rounds: number;
    completedReviewers: readonly string[];
    reviewerResults: readonly ForgeReviewerResult[];
    findings: readonly ForgeReviewFindingResult[];
  };
  residualRisks: readonly string[];
  blocker?: string;
}

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "reviewer",
    "runId",
    "headSha",
    "confidence",
    "severity",
    "category",
    "file",
    "line",
    "summary",
    "evidence",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    reviewer: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
    headSha: { type: "string", minLength: 7 },
    confidence: { type: "string", enum: ["confirmed", "likely", "possible"] },
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    category: {
      type: "string",
      enum: [
        "security",
        "data-loss",
        "auth",
        "billing",
        "production-safety",
        "correctness",
        "performance",
        "maintainability",
      ],
    },
    file: { type: "string", minLength: 1 },
    line: { type: "integer", minimum: 1 },
    summary: { type: "string", minLength: 1 },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export const FORGE_REVIEWER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "runId",
    "reviewer",
    "headSha",
    "verdict",
    "findings",
    "filesReviewed",
    "limitations",
  ],
  properties: {
    schema: { type: "string", const: "forgedock.reviewer-result/v1" },
    runId: { type: "string", minLength: 1 },
    reviewer: { type: "string", minLength: 1 },
    headSha: { type: "string", minLength: 7 },
    verdict: { type: "string", enum: ["pass", "findings", "blocked"] },
    findings: { type: "array", items: findingSchema },
    filesReviewed: { type: "array", items: { type: "string", minLength: 1 } },
    limitations: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export const FORGE_WORK_ON_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "runId",
    "issueNumber",
    "status",
    "branch",
    "baseSha",
    "headSha",
    "changedFiles",
    "verification",
    "review",
    "residualRisks",
  ],
  properties: {
    schema: { type: "string", const: "forgedock.work-on-result/v1" },
    runId: { type: "string", minLength: 1 },
    issueNumber: { type: "integer", minimum: 1 },
    status: {
      type: "string",
      enum: ["ready-for-merge", "blocked", "needs-human"],
    },
    branch: { type: "string", minLength: 1 },
    baseSha: { type: "string", minLength: 7 },
    headSha: { type: "string", minLength: 7 },
    changedFiles: { type: "array", items: { type: "string", minLength: 1 } },
    verification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string", minLength: 1 },
          status: {
            type: "string",
            enum: ["passed", "failed", "skipped", "unknown"],
          },
          exitCode: { type: "integer" },
        },
      },
    },
    review: {
      type: "object",
      additionalProperties: false,
      required: [
        "headSha",
        "rounds",
        "completedReviewers",
        "reviewerResults",
        "findings",
      ],
      properties: {
        headSha: { type: "string", minLength: 7 },
        rounds: { type: "integer", minimum: 1, maximum: 5 },
        completedReviewers: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        reviewerResults: { type: "array", items: FORGE_REVIEWER_OUTPUT_SCHEMA },
        findings: { type: "array", items: findingSchema },
      },
    },
    residualRisks: { type: "array", items: { type: "string", minLength: 1 } },
    blocker: { type: "string", minLength: 1 },
  },
} as const;

export function findForgeWorkOnResult(
  value: unknown,
): ForgeWorkOnResult | undefined {
  if (isForgeWorkOnResult(value)) return value;
  if (
    typeof value === "string" &&
    value.length <= 1024 * 1024 &&
    value.trimStart().startsWith("{")
  ) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== value) return findForgeWorkOnResult(parsed);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForgeWorkOnResult(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findForgeWorkOnResult(entry);
    if (found) return found;
  }
  return undefined;
}

export function isForgeWorkOnResult(
  value: unknown,
): value is ForgeWorkOnResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<ForgeWorkOnResult>;
  if (result.schema !== "forgedock.work-on-result/v1") return false;
  if (
    typeof result.runId !== "string" ||
    !Number.isSafeInteger(result.issueNumber)
  )
    return false;
  if (
    result.status !== "ready-for-merge" &&
    result.status !== "blocked" &&
    result.status !== "needs-human"
  )
    return false;
  if (
    typeof result.branch !== "string" ||
    typeof result.baseSha !== "string" ||
    typeof result.headSha !== "string"
  )
    return false;
  if (
    !isStringArray(result.changedFiles) ||
    !isStringArray(result.residualRisks)
  )
    return false;
  if (
    !Array.isArray(result.verification) ||
    !result.verification.every(isVerificationResult)
  )
    return false;
  if (!result.review || typeof result.review !== "object") return false;
  if (
    typeof result.review.headSha !== "string" ||
    !Number.isSafeInteger(result.review.rounds)
  )
    return false;
  if (
    !isStringArray(result.review.completedReviewers) ||
    !Array.isArray(result.review.reviewerResults) ||
    !Array.isArray(result.review.findings)
  )
    return false;
  return (
    result.review.reviewerResults.every(isReviewerResult) &&
    result.review.findings.every(isFindingResult)
  );
}

function isReviewerResult(value: unknown): value is ForgeReviewerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<ForgeReviewerResult>;
  return (
    result.schema === "forgedock.reviewer-result/v1" &&
    typeof result.runId === "string" &&
    typeof result.reviewer === "string" &&
    typeof result.headSha === "string" &&
    (result.verdict === "pass" ||
      result.verdict === "findings" ||
      result.verdict === "blocked") &&
    Array.isArray(result.findings) &&
    result.findings.every(isFindingResult) &&
    isStringArray(result.filesReviewed) &&
    isStringArray(result.limitations)
  );
}

function isVerificationResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as {
    name?: unknown;
    status?: unknown;
    exitCode?: unknown;
  };
  return (
    typeof result.name === "string" &&
    ["passed", "failed", "skipped", "unknown"].includes(
      String(result.status),
    ) &&
    (result.exitCode === undefined || Number.isInteger(result.exitCode))
  );
}

function isFindingResult(value: unknown): value is ForgeReviewFindingResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finding = value as Partial<ForgeReviewFindingResult>;
  return (
    typeof finding.id === "string" &&
    typeof finding.reviewer === "string" &&
    typeof finding.runId === "string" &&
    typeof finding.headSha === "string" &&
    ["confirmed", "likely", "possible"].includes(String(finding.confidence)) &&
    ["critical", "high", "medium", "low"].includes(String(finding.severity)) &&
    [
      "security",
      "data-loss",
      "auth",
      "billing",
      "production-safety",
      "correctness",
      "performance",
      "maintainability",
    ].includes(String(finding.category)) &&
    typeof finding.file === "string" &&
    Number.isSafeInteger(finding.line) &&
    typeof finding.summary === "string" &&
    isStringArray(finding.evidence)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}
