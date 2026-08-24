import { createHash } from "node:crypto";

import { canonicalJson } from "./events.ts";

export const BUILDER_CONTRACT_SCHEMA = "forgedock.builder-contract/v1" as const;

export type BuilderPathKind = "exact" | "directory";

export interface BuilderContractPath {
  kind: BuilderPathKind;
  path: string;
}

export type BuilderContractPathInput = BuilderContractPath | string;

export interface BuilderContractInput {
  revision?: number;
  allowedPaths: readonly BuilderContractPathInput[];
  supersedes?: string;
  reason?: string;
}

export interface BuilderContract {
  schema: typeof BUILDER_CONTRACT_SCHEMA;
  revision: number;
  allowedPaths: readonly BuilderContractPath[];
  supersedes?: string;
  reason?: string;
}

export interface BuilderContractArtifact extends BuilderContract {
  contractHash: string;
}

export interface BuilderDiffEntry {
  status: string;
  paths: readonly string[];
}

export class BuilderContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BuilderContractError";
    this.code = code;
  }
}

export function createBuilderContract(input: BuilderContractInput): BuilderContract {
  const revision = input.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new BuilderContractError(
      "invalid-revision",
      "Builder contract revision must be a positive safe integer.",
    );
  }
  if (input.allowedPaths.length === 0) {
    throw new BuilderContractError(
      "empty-allowed-paths",
      "Builder contract must allow at least one path.",
    );
  }
  const allowedPaths = input.allowedPaths.map(normalizeContractPath);
  const keys = new Set<string>();
  for (const entry of allowedPaths) {
    const key = `${entry.kind}:${entry.path}`;
    if (keys.has(key)) {
      throw new BuilderContractError(
        "duplicate-allowed-path",
        `Builder contract repeats ${entry.kind} path ${entry.path}.`,
      );
    }
    keys.add(key);
  }
  const sorted = [...allowedPaths].sort(compareContractPaths);
  const contract: BuilderContract = {
    schema: BUILDER_CONTRACT_SCHEMA,
    revision,
    allowedPaths: sorted,
    ...(input.supersedes === undefined
      ? {}
      : { supersedes: requireHash(input.supersedes, "supersedes") }),
    ...(input.reason === undefined
      ? {}
      : { reason: requireReason(input.reason) }),
  };
  return contract;
}

export function normalizeBuilderContract(value: unknown): BuilderContract {
  if (!isRecord(value))
    throw new BuilderContractError(
      "invalid-contract",
      "Builder contract must be an object.",
    );
  const allowedPaths = value.allowedPaths;
  if (!Array.isArray(allowedPaths))
    throw new BuilderContractError(
      "invalid-allowed-paths",
      "Builder contract allowedPaths must be an array.",
    );
  return createBuilderContract({
    revision: value.revision as number | undefined,
    allowedPaths: allowedPaths as BuilderContractPathInput[],
    ...(value.supersedes === undefined
      ? {}
      : { supersedes: value.supersedes as string }),
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
  });
}

export function builderContractHash(contract: BuilderContract): string {
  const normalized = createBuilderContract(contract);
  return `sha256:${createHash("sha256")
    .update(canonicalJson(normalized))
    .digest("hex")}`;
}

export function createBuilderContractArtifact(
  contract: BuilderContractInput,
): BuilderContractArtifact {
  const normalized = createBuilderContract(contract);
  return { ...normalized, contractHash: builderContractHash(normalized) };
}

export function normalizeBuilderContractArtifact(
  value: unknown,
): BuilderContractArtifact {
  if (!isRecord(value))
    throw new BuilderContractError(
      "invalid-artifact",
      "Builder contract artifact must be an object.",
    );
  const contract = normalizeBuilderContract(value);
  const contractHash = value.contractHash;
  if (typeof contractHash !== "string" || !contractHash.trim()) {
    throw new BuilderContractError(
      "missing-contract-hash",
      "Builder contract artifact must include contractHash.",
    );
  }
  const expected = builderContractHash(contract);
  if (contractHash !== expected) {
    throw new BuilderContractError(
      "contract-hash-mismatch",
      `Builder contract hash ${contractHash} does not match ${expected}.`,
    );
  }
  return { ...contract, contractHash };
}

export function isBuilderContractArtifact(
  value: unknown,
): value is BuilderContractArtifact {
  try {
    normalizeBuilderContractArtifact(value);
    return true;
  } catch {
    return false;
  }
}

export function parseBuilderContractReport(
  report: string,
): BuilderContractArtifact {
  if (typeof report !== "string" || !report.trim()) {
    throw new BuilderContractError(
      "missing-contract-report",
      "Plan report must include a Builder Contract artifact.",
    );
  }
  const marker = report.includes("<!-- FORGE:CONTRACT-EXTENSION -->")
    ? "<!-- FORGE:CONTRACT-EXTENSION -->"
    : "<!-- FORGE:CONTRACT -->";
  const markerIndex = report.indexOf(marker);
  if (markerIndex < 0) {
    throw new BuilderContractError(
      "missing-contract-marker",
      `Contract report is missing ${marker}.`,
    );
  }
  const section = report.slice(markerIndex);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(section);
  const candidates = fenced
    ? [fenced[1] ?? ""]
    : [findJsonObject(section) ?? ""];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed) && parsed.schema === BUILDER_CONTRACT_SCHEMA) {
        if (parsed.contractHash === undefined) {
          return createBuilderContractArtifact(normalizeBuilderContract(parsed));
        }
        return normalizeBuilderContractArtifact(parsed);
      }
    } catch {
      // Continue scanning so prose or unrelated JSON cannot shadow the artifact.
    }
  }
  throw new BuilderContractError(
    "invalid-contract-report",
    "Contract report does not contain a valid forgedock.builder-contract/v1 JSON artifact.",
  );
}

export function extendBuilderContract(
  current: BuilderContractArtifact,
  input: {
    allowedPaths: readonly BuilderContractPath[];
    reason: string;
  },
): BuilderContractArtifact {
  const reason = requireReason(input.reason);
  const existing = new Map(
    current.allowedPaths.map((entry) => [`${entry.kind}:${entry.path}`, entry]),
  );
  const combined = [...current.allowedPaths, ...input.allowedPaths];
  const next = createBuilderContract({
    revision: current.revision + 1,
    allowedPaths: combined,
    supersedes: current.contractHash,
    reason,
  });
  if (next.allowedPaths.length === current.allowedPaths.length) {
    throw new BuilderContractError(
      "empty-extension",
      "A contract extension must add at least one new allowed path.",
    );
  }
  for (const entry of next.allowedPaths) {
    existing.delete(`${entry.kind}:${entry.path}`);
  }
  return createBuilderContractArtifact(next);
}

export function isBuilderPathAllowed(
  contract: BuilderContract,
  path: string,
): boolean {
  const normalizedContract = createBuilderContract(contract);
  const normalized = normalizeDiffPath(path);
  return normalizedContract.allowedPaths.some((entry) => {
    if (entry.kind === "exact") return entry.path === normalized;
    return (
      normalized === entry.path || normalized.startsWith(`${entry.path}/`)
    );
  });
}

export function findBuilderContractViolations(
  contract: BuilderContract,
  paths: readonly string[],
): string[] {
  const violations = new Set<string>();
  for (const path of paths) {
    let normalized: string;
    try {
      normalized = normalizeDiffPath(path);
    } catch {
      normalized = path;
    }
    try {
      if (!isBuilderPathAllowed(contract, path)) violations.add(normalized);
    } catch {
      violations.add(normalized);
    }
  }
  return [...violations].sort((left, right) => left.localeCompare(right));
}

export function assertBuilderContractPaths(
  contract: BuilderContract,
  paths: readonly string[],
): void {
  const violations = findBuilderContractViolations(contract, paths);
  if (violations.length > 0) {
    throw new BuilderContractError(
      "out-of-contract-path",
      `Changed paths are outside the accepted builder contract: ${violations.join(", ")}.`,
    );
  }
}

export function parseGitNameStatusOutput(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    const names = /^[RC]\d+$/i.test(status)
      ? fields.slice(1)
      : fields.slice(1, 2);
    for (const name of names) if (name) paths.push(name);
  }
  return [...new Set(paths)];
}

export function parsePorcelainStatusPaths(output: string): string[] {
  const tokens = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 3) continue;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (path) paths.push(path);
    if (/[RC]/i.test(status) && index + 1 < tokens.length) {
      const destination = tokens[index + 1];
      if (destination) paths.push(destination);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

export function findBuilderContractInEvents(
  events: readonly { type: string; payload: unknown }[],
): BuilderContractArtifact | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "phase.completed") continue;
    if (!isRecord(event.payload)) continue;
    const payload = event.payload;
    if (isBuilderContractArtifact(payload.builderContract)) {
      return payload.builderContract;
    }
    if (payload.phase === "plan" && typeof payload.report === "string") {
      return parseBuilderContractReport(payload.report);
    }
  }
  return undefined;
}

function normalizeContractPath(
  value: BuilderContractPathInput,
): BuilderContractPath {
  if (typeof value === "string") {
    const kind: BuilderPathKind = value.trim().endsWith("/**")
      ? "directory"
      : "exact";
    return {
      kind,
      path: normalizeContractPathValue(value, kind),
    };
  }
  if (!isRecord(value)) {
    throw new BuilderContractError(
      "invalid-path-rule",
      "Each allowed path must be an object.",
    );
  }
  if (value.kind !== "exact" && value.kind !== "directory") {
    throw new BuilderContractError(
      "invalid-path-kind",
      `Unsupported builder path kind ${String(value.kind)}.`,
    );
  }
  const path = normalizeContractPathValue(value.path as string, value.kind);
  return { kind: value.kind, path };
}

function normalizeContractPathValue(
  value: string,
  kind: BuilderPathKind,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BuilderContractError(
      "invalid-path",
      "Builder contract paths must be non-empty strings.",
    );
  }
  let path = value.trim();
  if (path.startsWith("./")) path = path.slice(2);
  if (kind === "directory" && path.endsWith("/**")) path = path.slice(0, -3);
  path = path.replace(/\/$/, "");
  if (
    !path ||
    path === "." ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === ".." || segment === ".") ||
    path.includes("*") ||
    path.includes("?") ||
    path.includes("[") ||
    path.includes("]")
  ) {
    throw new BuilderContractError(
      "invalid-path",
      `Unsafe or non-canonical ${kind} builder path: ${value}.`,
    );
  }
  return path;
}

function normalizeDiffPath(value: string): string {
  if (typeof value !== "string" || !value || !value.trim()) {
    throw new BuilderContractError(
      "invalid-diff-path",
      "Git diff paths must be non-empty strings.",
    );
  }
  const path = value;
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new BuilderContractError(
      "invalid-diff-path",
      `Unsafe Git diff path: ${value}.`,
    );
  }
  return path;
}

function compareContractPaths(
  left: BuilderContractPath,
  right: BuilderContractPath,
): number {
  return `${left.path}\0${left.kind}`.localeCompare(
    `${right.path}\0${right.kind}`,
  );
}

function requireHash(value: string, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new BuilderContractError(
      "invalid-hash",
      `${field} must be a sha256 hash.`,
    );
  }
  return value;
}

function requireReason(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BuilderContractError(
      "invalid-extension-reason",
      "A contract extension requires a non-empty reason.",
    );
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function findJsonObject(section: string): string | undefined {
  const start = section.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < section.length; index += 1) {
    const character = section[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return section.slice(start, index + 1);
    }
  }
  return undefined;
}
