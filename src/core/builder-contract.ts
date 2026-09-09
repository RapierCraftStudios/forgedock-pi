import { createHash } from "node:crypto";

import type { AcceptanceMapping, PlanArtifact } from "./comment-contract.ts";

export interface BuilderContractBrief {
  objective: string;
  allowedPaths: readonly string[];
  forbiddenChanges: readonly string[];
  invariants: readonly string[];
  deliverables: readonly string[];
  acceptanceMapping: readonly AcceptanceMapping[];
  outOfScope: readonly string[];
}

export interface BuilderPathContract {
  schema: "forgedock.builder-path-contract/v1";
  revision: number;
  allowedPaths: readonly string[];
  contractHash: string;
  brief?: BuilderContractBrief;
}

export type BuilderContract = BuilderPathContract & {
  brief: BuilderContractBrief;
};

export class BuilderContractViolationError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`Paths outside the accepted builder contract: ${violations.join(", ")}`);
    this.name = "BuilderContractViolationError";
    this.violations = [...violations];
  }
}

/** Freeze the plan's path authority into a stable, hash-addressed contract. */
export function createBuilderPathContract(
  allowedPaths: readonly string[],
  revision = 1,
  brief?: BuilderContractBrief,
): BuilderPathContract {
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new TypeError("Builder contract revision must be positive.");
  const normalized = [...new Set(allowedPaths.map(normalizeRule))].sort();
  if (normalized.length === 0)
    throw new TypeError("Builder contract requires at least one allowed path.");
  const canonicalBrief = brief
    ? normalizeBrief(brief, normalized)
    : undefined;
  const payload = {
    schema: "forgedock.builder-path-contract/v1" as const,
    revision,
    allowedPaths: normalized,
    ...(canonicalBrief ? { brief: canonicalBrief } : {}),
  };
  return {
    ...payload,
    contractHash: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
}

export function createBuilderContract(
  artifact: PlanArtifact,
  revision = 1,
): BuilderContract {
  return createBuilderPathContract(artifact.allowedPaths, revision, {
    objective: artifact.objective,
    allowedPaths: artifact.allowedPaths,
    forbiddenChanges: artifact.forbiddenChanges,
    invariants: artifact.invariants,
    deliverables: artifact.deliverables,
    acceptanceMapping: artifact.acceptanceMapping,
    outOfScope: artifact.outOfScope,
  }) as BuilderContract;
}

export function validateBuilderPathContract(
  value: unknown,
): asserts value is BuilderPathContract {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Builder contract must be an object.");
  const contract = value as Partial<BuilderPathContract>;
  if (
    contract.schema !== "forgedock.builder-path-contract/v1" ||
    !Number.isSafeInteger(contract.revision) ||
    !Array.isArray(contract.allowedPaths) ||
    contract.allowedPaths.some((path) => typeof path !== "string") ||
    typeof contract.contractHash !== "string"
  )
    throw new TypeError("Builder contract shape is invalid.");
  const expected = createBuilderPathContract(
    contract.allowedPaths as readonly string[],
    contract.revision as number,
    contract.brief,
  );
  if (JSON.stringify(contract.allowedPaths) !== JSON.stringify(expected.allowedPaths))
    throw new TypeError("Builder contract paths are not canonical.");
  if (contract.brief !== undefined && JSON.stringify(contract.brief) !== JSON.stringify(expected.brief))
    throw new TypeError("Builder contract brief is not canonical.");
  if (expected.contractHash !== contract.contractHash)
    throw new TypeError("Builder contract hash does not match its contents.");
}

export function validateBuilderContract(
  value: unknown,
): asserts value is BuilderContract {
  validateBuilderPathContract(value);
  if (!(value as BuilderPathContract).brief)
    throw new TypeError("Builder contract is missing its immutable brief.");
}

export function assertBuilderContractPaths(
  contract: BuilderPathContract,
  changedPaths: readonly string[],
): void {
  validateBuilderPathContract(contract);
  const violations = [...new Set(changedPaths.map(normalizeChangedPath))].filter(
    (path) => !builderPathAllowed(contract, path),
  );
  if (violations.length > 0) throw new BuilderContractViolationError(violations);
}

export function builderPathAllowed(
  contract: BuilderPathContract,
  path: string,
): boolean {
  validateBuilderPathContract(contract);
  const normalized = normalizeChangedPath(path);
  return contract.allowedPaths.some((rule) => matchesRule(rule, normalized));
}

function normalizeBrief(
  value: BuilderContractBrief,
  allowedPaths: readonly string[],
): BuilderContractBrief {
  if (!value || typeof value !== "object")
    throw new TypeError("Builder contract brief must be an object.");
  const text = (entry: unknown, label: string): string => {
    if (typeof entry !== "string" || !entry.trim())
      throw new TypeError(`Builder contract brief ${label} must be non-empty.`);
    return entry.trim();
  };
  const texts = (entry: readonly string[], label: string): string[] => {
    if (!Array.isArray(entry) || entry.length === 0)
      throw new TypeError(`Builder contract brief ${label} must be non-empty.`);
    return entry.map((item) => text(item, label));
  };
  if (!Array.isArray(value.acceptanceMapping) || value.acceptanceMapping.length === 0)
    throw new TypeError("Builder contract brief acceptance mapping must be non-empty.");
  if (value.acceptanceMapping.some((entry) => !["behavioral", "inspection"].includes(entry.implementation.proofKind)))
    throw new TypeError("Builder contract brief proof kind is invalid.");
  if (!Array.isArray(value.outOfScope))
    throw new TypeError("Builder contract brief out-of-scope values must be an array.");
  return {
    objective: text(value.objective, "objective"),
    allowedPaths: [...allowedPaths],
    forbiddenChanges: texts(value.forbiddenChanges, "non-goals"),
    invariants: texts(value.invariants, "invariants"),
    deliverables: texts(value.deliverables, "deliverables"),
    acceptanceMapping: value.acceptanceMapping.map((entry) => ({
      checkId: text(entry.checkId, "criterion"),
      implementation: {
        proofKind: entry.implementation.proofKind,
        mechanism: text(entry.implementation.mechanism, "mechanism"),
        boundary: text(entry.implementation.boundary, "boundary"),
        test: text(entry.implementation.test, "test"),
        trigger: text(entry.implementation.trigger, "trigger"),
        assertion: text(entry.implementation.assertion, "assertion"),
        baseline: text(entry.implementation.baseline, "baseline"),
        passAfter: text(entry.implementation.passAfter, "pass-after"),
        prerequisite: text(entry.implementation.prerequisite, "prerequisite"),
        residualRisk: text(entry.implementation.residualRisk, "residual risk"),
      },
    })),
    outOfScope: value.outOfScope.map((item) => text(item, "out-of-scope")),
  };
}

function matchesRule(rule: string, path: string): boolean {
  if (!rule.includes("*"))
    return path === rule || (rule.endsWith("/") && path.startsWith(rule));
  const pattern = rule
    .split("**")
    .map((part) => part.split("*").map(escapeRegex).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(path);
}

function normalizeRule(value: string): string {
  const normalized = normalize(value, true);
  if (normalized === "." || normalized === "**") return "**";
  return normalized;
}

function normalizeChangedPath(value: string): string {
  return normalize(value, false);
}

function normalize(value: string, allowPattern: boolean): string {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.split("/").includes("..") ||
    (!allowPattern && path.includes("*"))
  )
    throw new TypeError(`Invalid repository path contract entry: ${value}`);
  return path.replace(/\/{2,}/g, "/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
