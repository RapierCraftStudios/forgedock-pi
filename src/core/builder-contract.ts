import { createHash } from "node:crypto";

export const BUILDER_CONTRACT_SCHEMA = "forgedock.builder-contract/v1" as const;
export const BUILDER_CONTRACT_EXTENSION_SCHEMA =
  "forgedock.builder-contract-extension/v1" as const;

export type BuilderContractPath = string;

export interface BuilderContract {
  schema: typeof BUILDER_CONTRACT_SCHEMA;
  revision: number;
  baseSha: string;
  allowedPaths: readonly BuilderContractPath[];
}

export interface BuilderContractExtension {
  schema: typeof BUILDER_CONTRACT_EXTENSION_SCHEMA;
  baseContractHash: string;
  revision: number;
  addedPaths: readonly BuilderContractPath[];
  reason: string;
  findingIds: readonly string[];
}

export type ChangedPathStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type-changed"
  | "unmerged"
  | "unknown";

export interface ChangedPath {
  status: ChangedPathStatus;
  path: string;
  previousPath?: string;
}

export class BuilderContractError extends Error {
  readonly code:
    | "invalid-contract"
    | "invalid-extension"
    | "invalid-path"
    | "invalid-git-status"
    | "contract-hash-mismatch"
    | "contract-revision-mismatch"
    | "path-outside-contract";

  constructor(
    code: BuilderContractError["code"],
    message: string,
  ) {
    super(message);
    this.name = "BuilderContractError";
    this.code = code;
  }
}

export const BUILDER_CONTRACT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "revision", "baseSha", "allowedPaths"],
  properties: {
    schema: { type: "string", const: BUILDER_CONTRACT_SCHEMA },
    revision: { type: "integer", minimum: 1 },
    baseSha: { type: "string", minLength: 7 },
    allowedPaths: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

export const BUILDER_CONTRACT_EXTENSION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "baseContractHash",
    "revision",
    "addedPaths",
    "reason",
    "findingIds",
  ],
  properties: {
    schema: {
      type: "string",
      const: BUILDER_CONTRACT_EXTENSION_SCHEMA,
    },
    baseContractHash: { type: "string", minLength: 7 },
    revision: { type: "integer", minimum: 1 },
    addedPaths: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    reason: { type: "string", minLength: 1 },
    findingIds: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

export function normalizeBuilderContract(value: unknown): BuilderContract {
  if (!isRecord(value)) invalidContract("must be an object");
  if (value.schema !== BUILDER_CONTRACT_SCHEMA)
    invalidContract(`schema must equal ${BUILDER_CONTRACT_SCHEMA}`);
  const revision = positiveInteger(value.revision, "revision", "contract");
  const baseSha = nonEmptyString(value.baseSha, "baseSha", "contract");
  if (baseSha.length < 7)
    invalidContract("baseSha must contain at least 7 characters");
  if (!Array.isArray(value.allowedPaths) || value.allowedPaths.length === 0)
    invalidContract("allowedPaths must be a non-empty array");
  const allowedPaths = uniqueSorted(
    value.allowedPaths.map((path, index) =>
      normalizePathPattern(path, `allowedPaths[${index}]`),
    ),
  );
  return { schema: BUILDER_CONTRACT_SCHEMA, revision, baseSha, allowedPaths };
}

export function normalizeBuilderContractExtension(
  value: unknown,
): BuilderContractExtension {
  if (!isRecord(value)) invalidExtension("must be an object");
  if (value.schema !== BUILDER_CONTRACT_EXTENSION_SCHEMA)
    invalidExtension(
      `schema must equal ${BUILDER_CONTRACT_EXTENSION_SCHEMA}`,
    );
  const baseContractHash = nonEmptyString(
    value.baseContractHash,
    "baseContractHash",
    "extension",
  );
  const revision = positiveInteger(value.revision, "revision", "extension");
  if (!Array.isArray(value.addedPaths) || value.addedPaths.length === 0)
    invalidExtension("addedPaths must be a non-empty array");
  const addedPaths = uniqueSorted(
    value.addedPaths.map((path, index) =>
      normalizePathPattern(path, `addedPaths[${index}]`),
    ),
  );
  const reason = nonEmptyString(value.reason, "reason", "extension");
  if (!Array.isArray(value.findingIds) || value.findingIds.length === 0)
    invalidExtension("findingIds must be a non-empty array");
  const findingIds = uniqueSorted(
    value.findingIds.map((id, index) =>
      nonEmptyString(id, `findingIds[${index}]`, "extension"),
    ),
  );
  return {
    schema: BUILDER_CONTRACT_EXTENSION_SCHEMA,
    baseContractHash,
    revision,
    addedPaths,
    reason,
    findingIds,
  };
}

export function hashBuilderContract(value: BuilderContract): string {
  const contract = normalizeBuilderContract(value);
  return `sha256:${createHash("sha256").update(canonicalJson(contract)).digest("hex")}`;
}

export function extendBuilderContract(
  baseValue: BuilderContract,
  extensionValue: BuilderContractExtension,
): BuilderContract {
  const base = normalizeBuilderContract(baseValue);
  const extension = normalizeBuilderContractExtension(extensionValue);
  const actualHash = hashBuilderContract(base);
  if (extension.baseContractHash !== actualHash)
    throw new BuilderContractError(
      "contract-hash-mismatch",
      `Contract extension references ${extension.baseContractHash}, expected ${actualHash}.`,
    );
  if (extension.revision !== base.revision + 1)
    throw new BuilderContractError(
      "contract-revision-mismatch",
      `Contract extension revision ${extension.revision} must follow ${base.revision}.`,
    );
  const added = extension.addedPaths.filter(
    (path) => !base.allowedPaths.includes(path),
  );
  if (added.length === 0)
    throw new BuilderContractError(
      "invalid-extension",
      "Contract extension must add at least one new path rule.",
    );
  return normalizeBuilderContract({
    schema: BUILDER_CONTRACT_SCHEMA,
    revision: extension.revision,
    baseSha: base.baseSha,
    allowedPaths: [...base.allowedPaths, ...extension.addedPaths],
  });
}

export function matchesBuilderContractPath(
  contractValue: BuilderContract,
  path: string,
): boolean {
  const contract = normalizeBuilderContract(contractValue);
  const normalizedPath = normalizeChangedPath(path, "path");
  return contract.allowedPaths.some((pattern) =>
    matchesPattern(pattern, normalizedPath),
  );
}

export function findBuilderContractViolations(
  contractValue: BuilderContract,
  paths: readonly ChangedPath[],
): string[] {
  const contract = normalizeBuilderContract(contractValue);
  const violations: string[] = [];
  for (const [index, changed] of paths.entries()) {
    const currentPath = normalizeChangedPath(changed.path, `paths[${index}].path`);
    if (!matchesPatternList(contract.allowedPaths, currentPath))
      violations.push(`${changed.status} path ${currentPath}`);
    if (changed.previousPath !== undefined) {
      const previousPath = normalizeChangedPath(
        changed.previousPath,
        `paths[${index}].previousPath`,
      );
      if (!matchesPatternList(contract.allowedPaths, previousPath))
        violations.push(`${changed.status} source path ${previousPath}`);
    }
  }
  return uniqueSorted(violations);
}

export function assertChangedPathsAllowed(
  contractValue: BuilderContract,
  paths: readonly ChangedPath[],
): void {
  const violations = findBuilderContractViolations(contractValue, paths);
  if (violations.length > 0)
    throw new BuilderContractError(
      "path-outside-contract",
      `Changed paths are outside the accepted builder contract: ${violations.join(", ")}.`,
    );
}

export function parseGitNameStatus(output: string): ChangedPath[] {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const paths: ChangedPath[] = [];
  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index++];
    if (!statusToken || statusToken.length === 0)
      throw new BuilderContractError(
        "invalid-git-status",
        "Git name-status output contained an empty status token.",
      );
    const statusCode = statusToken[0];
    const status = statusFromCode(statusCode);
    if (status === "renamed" || status === "copied") {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (!previousPath || !path)
        throw new BuilderContractError(
          "invalid-git-status",
          `Git ${statusCode} status must contain source and destination paths.`,
        );
      paths.push({ status, previousPath, path });
    } else {
      const path = tokens[index++];
      if (!path)
        throw new BuilderContractError(
          "invalid-git-status",
          `Git ${statusCode} status must contain a path.`,
        );
      paths.push({ status, path });
    }
  }
  return paths;
}

export function parseBuilderContractReport(report: string): BuilderContract {
  if (typeof report !== "string" || !report.includes("<!-- FORGE:CONTRACT -->"))
    throw new BuilderContractError(
      "invalid-contract",
      "Plan report is missing the FORGE:CONTRACT artifact.",
    );
  const start = report.indexOf("<!-- FORGE:CONTRACT -->");
  const endMarker = "<!-- FORGE:CONTRACT:COMPLETE -->";
  const end = report.indexOf(endMarker, start);
  const block = report.slice(start, end >= 0 ? end : report.length);
  const jsonBlock = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(block)?.[1];
  if (!jsonBlock)
    throw new BuilderContractError(
      "invalid-contract",
      "Builder contract artifact must contain a JSON code block.",
    );
  let value: unknown;
  try {
    value = JSON.parse(jsonBlock);
  } catch (error) {
    throw new BuilderContractError(
      "invalid-contract",
      `Builder contract JSON is invalid: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return normalizeBuilderContract(value);
}

function matchesPatternList(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, path));
}

function matchesPattern(pattern: string, path: string): boolean {
  if (!pattern.endsWith("/**")) return pattern === path;
  const directory = pattern.slice(0, -3);
  return path.startsWith(`${directory}/`);
}

function normalizePathPattern(value: unknown, field: string): string {
  const raw = nonEmptyString(value, field, "contract");
  if (raw.endsWith("/") && !raw.endsWith("/**"))
    return normalizePathPattern(`${raw}**`, field);
  const directory = raw.endsWith("/**");
  const path = directory ? raw.slice(0, -3) : raw;
  validateRepositoryPath(path, field);
  if (/[?*[\]{}]/.test(path))
    throw new BuilderContractError(
      "invalid-path",
      `${field} may contain only an exact path or a path ending in /**.`,
    );
  return directory ? `${path}/**` : path;
}

function normalizeChangedPath(value: unknown, field: string): string {
  const path = nonEmptyString(value, field, "path");
  validateRepositoryPath(path, field);
  return path;
}

function validateRepositoryPath(path: string, field: string): void {
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^[A-Za-z]:/.test(path)
  )
    throw new BuilderContractError(
      "invalid-path",
      `${field} must be a repository-relative POSIX path.`,
    );
  const parts = path.split("/");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  )
    throw new BuilderContractError(
      "invalid-path",
      `${field} contains an empty, dot, or parent path segment.`,
    );
  if (parts[0] === ".git" || parts[0] === ".pi")
    throw new BuilderContractError(
      "invalid-path",
      `${field} cannot target .git or .pi runtime/control paths.`,
    );
}

function statusFromCode(code: string | undefined): ChangedPathStatus {
  switch (code) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new BuilderContractError(
    "invalid-contract",
    `Cannot hash non-JSON value ${typeof value}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown, field: string, kind: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    const code: BuilderContractError["code"] =
      kind === "extension" ? "invalid-extension" : "invalid-contract";
    throw new BuilderContractError(
      code,
      `${field} must be a non-empty trimmed string.`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, field: string, kind: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    const code: BuilderContractError["code"] =
      kind === "extension" ? "invalid-extension" : "invalid-contract";
    throw new BuilderContractError(
      code,
      `${field} must be a positive safe integer.`,
    );
  }
  return value as number;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function invalidContract(message: string): never {
  throw new BuilderContractError("invalid-contract", message);
}

function invalidExtension(message: string): never {
  throw new BuilderContractError("invalid-extension", message);
}
