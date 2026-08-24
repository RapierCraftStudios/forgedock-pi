import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export interface ChildToolBlock {
  block: true;
  reason: string;
}

/**
 * Resolve and validate the child session root once before tools are exposed.
 * The caller owns the resulting canonical root for the lifetime of the run.
 */
export async function resolveChildRoot(
  worktreeRoot: string,
  cwd: string,
): Promise<string> {
  const canonicalRoot = await realpath(worktreeRoot);
  if (!isPathWithin(canonicalRoot, await realpath(cwd))) {
    throw new Error(
      `Forge child cwd ${cwd} is outside bound worktree ${canonicalRoot}.`,
    );
  }
  return canonicalRoot;
}

/**
 * Return a tool-level decision for path-bearing tools. Missing path segments
 * are resolved lexically after the nearest existing ancestor is canonicalized
 * so symlink escapes cannot bypass the worktree boundary.
 */
export async function guardChildToolPath(
  root: string,
  cwd: string,
  toolName: string,
  input: unknown,
): Promise<ChildToolBlock | undefined> {
  const pathValue = toolPath(input);
  if (!pathValue) return undefined;
  const target = await canonicalizePotentialPath(cwd, pathValue);
  if (!isPathWithin(root, target)) {
    return {
      block: true,
      reason: `${toolName} path is outside the assigned Forge worktree.`,
    };
  }
  if (
    isPathWithin(join(root, ".pi"), target) ||
    isPathWithin(join(root, ".git"), target)
  ) {
    return {
      block: true,
      reason: `${toolName} cannot access Forge runtime or Git control files.`,
    };
  }
  return undefined;
}

export async function canonicalizePotentialPath(
  cwd: string,
  inputPath: string,
): Promise<string> {
  const absolute = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(cwd, inputPath);
  const missingSegments: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missingSegments);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export function isPathWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const value = (input as Record<string, unknown>).path;
  return typeof value === "string" && value.trim() ? value : undefined;
}
