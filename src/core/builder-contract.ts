import { createHash } from "node:crypto";

export type ProofClosureState =
  | "PASS"
  | "FAIL"
  | "MISSING"
  | "SKIPPED"
  | "CONTRADICTED"
  | "UNKNOWN";

export interface ProofObligation {
  criterion: string;
  invariant: string;
  counterexample: string;
  boundaryConsumers: string;
  testCommand: string;
  failingBefore: string;
  passingAfter: string;
  state: ProofClosureState;
  required: boolean;
}

export interface ProofClosureContract {
  schema: "forgedock.proof-closure/v1";
  repository: string;
  issueNumber: number;
  target: string;
  baseSha: string;
  risk: "low" | "high";
  riskSignals: readonly string[];
  obligations: readonly ProofObligation[];
}

export interface BuilderPathContract {
  schema: "forgedock.builder-path-contract/v1";
  revision: number;
  allowedPaths: readonly string[];
  contractHash: string;
  proofClosure?: ProofClosureContract;
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
export function createProofClosureContract(
  input: Omit<ProofClosureContract, "schema">,
): ProofClosureContract {
  const contract: ProofClosureContract = {
    schema: "forgedock.proof-closure/v1",
    ...input,
  };
  validateProofClosureContract(contract);
  return contract;
}

export function createBuilderPathContract(
  allowedPaths: readonly string[],
  revision = 1,
  proofClosure?: ProofClosureContract,
): BuilderPathContract {
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new TypeError("Builder contract revision must be positive.");
  const normalized = [...new Set(allowedPaths.map(normalizeRule))].sort();
  if (normalized.length === 0)
    throw new TypeError("Builder contract requires at least one allowed path.");
  if (proofClosure !== undefined) validateProofClosureContract(proofClosure);
  const payload = {
    schema: "forgedock.builder-path-contract/v1" as const,
    revision,
    allowedPaths: normalized,
    ...(proofClosure === undefined ? {} : { proofClosure }),
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
  if (contract.proofClosure !== undefined)
    validateProofClosureContract(contract.proofClosure);
  const expected = createBuilderPathContract(
    contract.allowedPaths as readonly string[],
    contract.revision as number,
    contract.proofClosure,
  );
  if (expected.contractHash !== contract.contractHash)
    throw new TypeError("Builder contract hash does not match its contents.");
}

export function validateProofClosureContract(
  value: unknown,
): asserts value is ProofClosureContract {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Proof closure contract must be an object.");
  const contract = value as Partial<ProofClosureContract>;
  if (
    contract.schema !== "forgedock.proof-closure/v1" ||
    typeof contract.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(contract.repository) ||
    typeof contract.issueNumber !== "number" ||
    !Number.isSafeInteger(contract.issueNumber) ||
    contract.issueNumber < 1 ||
    typeof contract.target !== "string" ||
    !contract.target ||
    typeof contract.baseSha !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(contract.baseSha) ||
    (contract.risk !== "low" && contract.risk !== "high") ||
    !Array.isArray(contract.riskSignals) ||
    contract.riskSignals.some((entry) => typeof entry !== "string" || !entry) ||
    !Array.isArray(contract.obligations)
  )
    throw new TypeError("Proof closure contract shape is invalid.");
  for (const row of contract.obligations) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.criterion !== "string" ||
      !row.criterion ||
      typeof row.invariant !== "string" ||
      !row.invariant ||
      typeof row.counterexample !== "string" ||
      !row.counterexample ||
      typeof row.boundaryConsumers !== "string" ||
      !row.boundaryConsumers ||
      typeof row.testCommand !== "string" ||
      !row.testCommand ||
      typeof row.failingBefore !== "string" ||
      !row.failingBefore ||
      typeof row.passingAfter !== "string" ||
      !row.passingAfter ||
      typeof row.required !== "boolean" ||
      !["PASS", "FAIL", "MISSING", "SKIPPED", "CONTRADICTED", "UNKNOWN"].includes(row.state)
    )
      throw new TypeError("Proof obligation shape is invalid.");
  }
  if (contract.risk === "high" &&
      (contract.riskSignals.length === 0 ||
       !contract.obligations.some((row) => row.required)))
    throw new TypeError("High-risk proof closure needs signals and required obligations.");
}

export function assertProofClosure(
  contract: ProofClosureContract,
  identity: Pick<ProofClosureContract, "repository" | "issueNumber" | "target" | "baseSha">,
): void {
  validateProofClosureContract(contract);
  if (
    contract.repository !== identity.repository ||
    contract.issueNumber !== identity.issueNumber ||
    contract.target !== identity.target ||
    contract.baseSha !== identity.baseSha
  )
    throw new Error("Proof closure identity does not match its bound run.");
  const blockers = contract.obligations.filter(
    (row) => row.required && row.state !== "PASS",
  );
  if (blockers.length > 0)
    throw new Error(
      `Required proof obligations are not closed: ${blockers.map((row) => `${row.criterion}=${row.state}`).join(", ")}.`,
    );
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
