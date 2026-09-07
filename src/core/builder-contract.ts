import { createHash } from "node:crypto";

export interface BuilderPathContract {
  schema: "forgedock.builder-path-contract/v1";
  revision: number;
  allowedPaths: readonly string[];
  contractHash: string;
}

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
): BuilderPathContract {
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new TypeError("Builder contract revision must be positive.");
  const normalized = [...new Set(allowedPaths.map(normalizeRule))].sort();
  if (normalized.length === 0)
    throw new TypeError("Builder contract requires at least one allowed path.");
  const payload = {
    schema: "forgedock.builder-path-contract/v1" as const,
    revision,
    allowedPaths: normalized,
  };
  return {
    ...payload,
    contractHash: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
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
  );
  if (expected.contractHash !== contract.contractHash)
    throw new TypeError("Builder contract hash does not match its contents.");
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
