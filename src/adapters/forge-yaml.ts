import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";

/** The small, prompt-facing portion of forge.yaml shared by every coordinator. */
export type ForgeYamlValue =
  | null
  | boolean
  | number
  | string
  | ForgeYamlValue[]
  | { [key: string]: ForgeYamlValue };

export interface ForgeYamlConfig {
  readonly project: { readonly name: string; readonly owner: string; readonly repo: string };
  readonly repository: string;
  readonly paths: { readonly root: string; readonly worktreeBase: string };
  readonly branches: { readonly staging: string; readonly default: string };
  readonly agents: { readonly defaultModel: string; readonly subagentModel: string };
  readonly sourcePath: string;
}

export class ForgeYamlError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`forge.yaml ${path}: ${message}`);
    this.name = "ForgeYamlError";
    this.path = path;
  }
}

/** Read and validate forge.yaml without yq, Python, or a runtime dependency. */
export async function loadForgeYaml(repositoryRoot: string): Promise<ForgeYamlConfig> {
  const sourcePath = join(repositoryRoot, "forge.yaml");
  let text: string;
  try {
    text = await readFile(sourcePath, "utf8");
  } catch (error) {
    throw new ForgeYamlError(sourcePath, `cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let value: unknown;
  try {
    value = parseForgeYaml(text);
  } catch (error) {
    if (error instanceof ForgeYamlError) throw error;
    throw new ForgeYamlError(sourcePath, error instanceof Error ? error.message : String(error));
  }
  return validateForgeYaml(value, sourcePath);
}

/** Synchronous parser is exported for prompt and test adapters that already have text. */
export function parseForgeYaml(text: string): ForgeYamlValue {
  if (typeof text !== "string" || !text.trim()) throw new ForgeYamlError("document", "must not be empty");
  try {
    const parsed: unknown = YAML.parse(text, { strict: true, uniqueKeys: true });
    if (!isForgeYamlValue(parsed)) throw new ForgeYamlError("document", "must contain only YAML scalar, sequence, and mapping values");
    return parsed;
  } catch (error) {
    if (error instanceof ForgeYamlError) throw error;
    throw new ForgeYamlError("document", error instanceof Error ? error.message : String(error));
  }
}

function isForgeYamlValue(value: unknown): value is ForgeYamlValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isForgeYamlValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isForgeYamlValue);
}

function validateForgeYaml(value: unknown, sourcePath: string): ForgeYamlConfig {
  const root = object(value, "document");
  const project = object(root.project, "project");
  const paths = object(root.paths, "paths");
  const branches = object(root.branches, "branches");
  const agents = object(root.agents, "agents");
  const name = requiredString(project.name, "project.name");
  const owner = requiredString(project.owner, "project.owner");
  const repo = requiredString(project.repo, "project.repo");
  const repository = `${owner}/${repo}`;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new ForgeYamlError("project", "owner and repo must form owner/repository");
  const rootPath = requiredPath(paths.root, "paths.root");
  const worktreeBase = requiredPath(paths.worktree_base, "paths.worktree_base");
  return Object.freeze({
    project: Object.freeze({ name, owner, repo }),
    repository,
    paths: Object.freeze({ root: rootPath, worktreeBase }),
    branches: Object.freeze({ staging: requiredBranch(branches.staging, "branches.staging"), default: requiredBranch(branches.default, "branches.default") }),
    agents: Object.freeze({ defaultModel: requiredString(agents.default_model, "agents.default_model"), subagentModel: requiredString(agents.subagent_model, "agents.subagent_model") }),
    sourcePath,
  });
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ForgeYamlError(path, "is required and must be a mapping");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new ForgeYamlError(path, "is required and must be a non-empty trimmed string");
  return value;
}
function requiredPath(value: unknown, path: string): string {
  const result = requiredString(value, path);
  if (result.includes("\0") || result.split(/[\\/]/).includes("..")) throw new ForgeYamlError(path, "must be a normalized path without traversal");
  return result.replaceAll("\\", "/");
}
function requiredBranch(value: unknown, path: string): string {
  const result = requiredString(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result) || result.includes("..") || result.includes("//") || result.endsWith("/") || result.endsWith(".")) throw new ForgeYamlError(path, "must be a safe branch name");
  return result;
}
