import { createHash } from "node:crypto";

export const BUILDER_CONTRACT_SCHEMA = "forgedock.builder-contract/v1" as const;
export const BUILDER_CONTRACT_REVISION_SCHEMA =
  "forgedock.builder-contract-revision/v1" as const;

export type BuilderPathRuleKind = "exact" | "directory";

export interface BuilderPathRule {
  kind: BuilderPathRuleKind;
  path: string;
}

export interface BuilderContract {
  schema: typeof BUILDER_CONTRACT_SCHEMA;
  revision: number;
  allowedPaths: readonly BuilderPathRule[];
}

export interface BuilderContractRevision {
  schema: typeof BUILDER_CONTRACT_REVISION_SCHEMA;
  revision: number;
  previousContractHash: string;
  contractHash: string;
  contract: BuilderContract;
  reason: string;
  actor: string;
}

export interface BuilderContractPathCheck {
  valid: boolean;
  paths: readonly string[];
  violations: readonly string[];
}

export class BuilderContractValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BuilderContractValidationError";
    this.code = code;
  }
}

export class BuilderContractScopeError extends Error {
  readonly code = "out-of-contract-path" as const;
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(
      `Builder contract rejected changed paths: ${violations.join(", ")}.`,
    );
    this.name = "BuilderContractScopeError";
    this.violations = violations;
  }
}

/**
 * Normalize a repository-relative Git path. Contract paths are deliberately
 * stricter than ordinary filesystem paths: absolute paths, traversal, and
 * empty segments are rejected instead of being interpreted.
 */
export function normalizeBuilderPath(value: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new BuilderContractValidationError(
      "invalid-path",
      "Builder contract paths must be non-empty strings.",
    );
  if (value !== value.trim())
    throw new BuilderContractValidationError(
      "invalid-path",
      `Builder contract path must be trimmed: ${JSON.stringify(value)}.`,
    );
  if (value.includes("\0") || value.includes("\\"))
    throw new BuilderContractValidationError(
      "invalid-path",
      `Builder contract path must use normalized POSIX separators: ${value}.`,
    );
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value))
    throw new BuilderContractValidationError(
      "invalid-path",
      `Builder contract path must be repository-relative: ${value}.`,
    );
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  )
    throw new BuilderContractValidationError(
      "invalid-path",
      `Builder contract path contains an unsafe segment: ${value}.`,
    );
  return value;
}

function normalizeRule(value: unknown, index: number): BuilderPathRule {
  let kind: unknown;
  let path: unknown;
  if (typeof value === "string") {
    if (value.endsWith("/**")) {
      kind = "directory";
      path = value.slice(0, -3);
    } else if (value.endsWith("/")) {
      kind = "directory";
      path = value.slice(0, -1);
    } else {
      kind = "exact";
      path = value;
    }
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    kind = record.kind;
    path = record.path;
    if (
      kind === undefined &&
      typeof path === "string" &&
      (path.endsWith("/**") || path.endsWith("/"))
    ) {
      kind = "directory";
      path = path.endsWith("/**") ? path.slice(0, -3) : path.slice(0, -1);
    }
  }
  if (kind !== "exact" && kind !== "directory")
    throw new BuilderContractValidationError(
      "invalid-rule",
      `allowedPaths[${index}].kind must be exact or directory.`,
    );
  if (typeof path !== "string")
    throw new BuilderContractValidationError(
      "invalid-rule",
      `allowedPaths[${index}].path must be a string.`,
    );
  if (kind === "directory" && path.endsWith("/**")) path = path.slice(0, -3);
  if (kind === "directory" && path.endsWith("/")) path = path.slice(0, -1);
  if (kind === "exact" && path.endsWith("/**"))
    throw new BuilderContractValidationError(
      "invalid-rule",
      `allowedPaths[${index}] exact paths cannot contain a directory glob.`,
    );
  const normalizedPath = normalizeBuilderPath(path);
  return { kind, path: normalizedPath };
}

function compareRules(left: BuilderPathRule, right: BuilderPathRule): number {
  return (
    left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)
  );
}

/** Validate and canonicalize a typed builder contract. */
export function normalizeBuilderContract(value: unknown): BuilderContract {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BuilderContractValidationError(
      "invalid-contract",
      "Builder contract must be an object.",
    );
  const record = value as Record<string, unknown>;
  if (record.schema !== BUILDER_CONTRACT_SCHEMA)
    throw new BuilderContractValidationError(
      "unsupported-schema",
      `Builder contract schema must equal ${BUILDER_CONTRACT_SCHEMA}.`,
    );
  if (
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1
  )
    throw new BuilderContractValidationError(
      "invalid-revision",
      "Builder contract revision must be a positive safe integer.",
    );
  if (!Array.isArray(record.allowedPaths) || record.allowedPaths.length === 0)
    throw new BuilderContractValidationError(
      "invalid-paths",
      "Builder contract allowedPaths must be a non-empty array.",
    );
  const rules = record.allowedPaths.map(normalizeRule);
  const unique = new Map<string, BuilderPathRule>();
  for (const rule of rules) unique.set(`${rule.kind}\0${rule.path}`, rule);
  return {
    schema: BUILDER_CONTRACT_SCHEMA,
    revision: record.revision as number,
    allowedPaths: [...unique.values()].sort(compareRules),
  };
}

export function validateBuilderContract(value: unknown): asserts value is BuilderContract {
  normalizeBuilderContract(value);
}

/** Stable JSON representation used for contract identity and journal binding. */
export function canonicalBuilderContract(value: unknown): string {
  const contract = normalizeBuilderContract(value);
  return JSON.stringify(contract);
}

export function hashBuilderContract(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalBuilderContract(value))
    .digest("hex")}`;
}

export function isBuilderContract(value: unknown): value is BuilderContract {
  try {
    normalizeBuilderContract(value);
    return true;
  } catch {
    return false;
  }
}

function ruleMatchesPath(rule: BuilderPathRule, path: string): boolean {
  if (rule.kind === "exact") return path === rule.path;
  return path === rule.path || path.startsWith(`${rule.path}/`);
}

export function builderPathMatches(
  contract: BuilderContract,
  path: string,
): boolean {
  const normalizedPath = normalizeBuilderPath(path);
  return contract.allowedPaths.some((rule) =>
    ruleMatchesPath(rule, normalizedPath),
  );
}

export function validateBuilderContractPaths(
  contractValue: BuilderContract,
  paths: readonly string[],
): BuilderContractPathCheck {
  const contract = normalizeBuilderContract(contractValue);
  const normalized = [
    ...new Set(paths.map((path) => normalizeBuilderPath(path))),
  ].sort((left, right) => left.localeCompare(right));
  const violations = normalized.filter(
    (path) => !contract.allowedPaths.some((rule) => ruleMatchesPath(rule, path)),
  );
  return { valid: violations.length === 0, paths: normalized, violations };
}

export function assertBuilderContractPaths(
  contract: BuilderContract,
  paths: readonly string[],
): void {
  const check = validateBuilderContractPaths(contract, paths);
  if (!check.valid) throw new BuilderContractScopeError(check.violations);
}

// Descriptive aliases keep adapter call sites readable and provide one stable
// API for callers that refer to the artifact as a file contract.
export const validatePathsAgainstBuilderContract = validateBuilderContractPaths;
export const assertPathsWithinBuilderContract = assertBuilderContractPaths;
export const matchesBuilderContractPath = builderPathMatches;

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

/**
 * Extract the canonical contract JSON embedded in a Forge plan artifact. The
 * explicit marker avoids accidentally accepting issue prose containing JSON.
 */
export function parseBuilderContractReport(report: string): BuilderContract {
  const marker = "<!-- FORGE:CONTRACT:JSON -->";
  const start = report.indexOf(marker);
  if (start < 0)
    throw new BuilderContractValidationError(
      "missing-contract",
      `Plan report is missing ${marker}.`,
    );
  const endMarker = "<!-- FORGE:CONTRACT:JSON:END -->";
  const end = report.indexOf(endMarker, start + marker.length);
  const body = report.slice(
    start + marker.length,
    end < 0 ? undefined : end,
  );
  const candidate = extractJsonObject(body.replaceAll("```json", "").replaceAll("```", ""));
  if (!candidate)
    throw new BuilderContractValidationError(
      "invalid-contract-json",
      "Plan report does not contain a builder contract JSON object.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new BuilderContractValidationError(
      "invalid-contract-json",
      `Builder contract JSON is invalid: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
  return normalizeBuilderContract(parsed);
}

/** Find the latest accepted contract in projected issue artifacts. */
export function findLatestBuilderContractArtifact(
  comments: readonly string[],
): BuilderContract | undefined {
  let latest: BuilderContract | undefined;
  for (const comment of comments) {
    const planMarker = "<!-- FORGE:CONTRACT:JSON -->";
    if (comment.includes(planMarker)) {
      try {
        latest = parseBuilderContractReport(comment);
      } catch {
        // An invalid artifact is handled by the caller as a missing contract;
        // never silently use a partial or unparseable path list.
        latest = undefined;
      }
    }
    const revisionMarker = "<!-- FORGE:CONTRACT_REVISION:JSON -->";
    const revisionStart = comment.indexOf(revisionMarker);
    if (revisionStart >= 0) {
      const candidate = extractJsonObject(
        comment.slice(revisionStart + revisionMarker.length),
      );
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        if (parsed.schema === BUILDER_CONTRACT_REVISION_SCHEMA)
          latest = normalizeBuilderContract(parsed.contract);
      } catch {
        latest = undefined;
      }
    }
  }
  return latest;
}

export function makeBuilderContractRevision(input: {
  previous: BuilderContract;
  previousContractHash?: string;
  addedPaths: readonly (BuilderPathRule | string)[];
  reason: string;
  actor: string;
}): BuilderContractRevision {
  if (!input.reason.trim() || input.reason !== input.reason.trim())
    throw new BuilderContractValidationError(
      "invalid-revision-reason",
      "Contract revision reason must be non-empty and trimmed.",
    );
  if (!input.actor.trim() || input.actor !== input.actor.trim())
    throw new BuilderContractValidationError(
      "invalid-revision-actor",
      "Contract revision actor must be non-empty and trimmed.",
    );
  const previous = normalizeBuilderContract(input.previous);
  const previousHash = input.previousContractHash ?? hashBuilderContract(previous);
  if (previousHash !== hashBuilderContract(previous))
    throw new BuilderContractValidationError(
      "contract-hash-mismatch",
      "Previous contract hash does not match the supplied contract.",
    );
  const additions = input.addedPaths.map((rule, index) => normalizeRule(rule, index));
  const contract = normalizeBuilderContract({
    schema: BUILDER_CONTRACT_SCHEMA,
    revision: previous.revision + 1,
    allowedPaths: [...previous.allowedPaths, ...additions],
  });
  return {
    schema: BUILDER_CONTRACT_REVISION_SCHEMA,
    revision: contract.revision,
    previousContractHash: previousHash,
    contractHash: hashBuilderContract(contract),
    contract,
    reason: input.reason,
    actor: input.actor,
  };
}

export function validateBuilderContractRevision(
  value: unknown,
  previous?: BuilderContract,
): asserts value is BuilderContractRevision {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BuilderContractValidationError(
      "invalid-revision",
      "Builder contract revision must be an object.",
    );
  const record = value as Record<string, unknown>;
  if (record.schema !== BUILDER_CONTRACT_REVISION_SCHEMA)
    throw new BuilderContractValidationError(
      "unsupported-revision-schema",
      `Revision schema must equal ${BUILDER_CONTRACT_REVISION_SCHEMA}.`,
    );
  if (typeof record.previousContractHash !== "string")
    throw new BuilderContractValidationError(
      "invalid-revision",
      "Revision previousContractHash must be a string.",
    );
  if (typeof record.contractHash !== "string")
    throw new BuilderContractValidationError(
      "invalid-revision",
      "Revision contractHash must be a string.",
    );
  if (typeof record.reason !== "string" || !record.reason.trim())
    throw new BuilderContractValidationError(
      "invalid-revision",
      "Revision reason must be non-empty.",
    );
  if (typeof record.actor !== "string" || !record.actor.trim())
    throw new BuilderContractValidationError(
      "invalid-revision",
      "Revision actor must be non-empty.",
    );
  const contract = normalizeBuilderContract(record.contract);
  if (record.revision !== contract.revision)
    throw new BuilderContractValidationError(
      "invalid-revision",
      "Revision number must equal the nested contract revision.",
    );
  if (record.contractHash !== hashBuilderContract(contract))
    throw new BuilderContractValidationError(
      "contract-hash-mismatch",
      "Revision contractHash does not match the nested contract.",
    );
  if (previous) {
    const previousContract = normalizeBuilderContract(previous);
    if (record.previousContractHash !== hashBuilderContract(previousContract))
      throw new BuilderContractValidationError(
        "contract-hash-mismatch",
        "Revision does not link to the current contract hash.",
      );
    if ((record.revision as number) !== previousContract.revision + 1)
      throw new BuilderContractValidationError(
        "invalid-revision",
        "Contract revisions must increment by exactly one.",
      );
  }
}
