import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

export function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const value = (input as Record<string, unknown>).path;
  return typeof value === "string" && value.trim() ? value : undefined;
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

export function assertPathWithin(
  root: string,
  target: string,
  label = "Path",
): void {
  if (!isPathWithin(root, target))
    throw new Error(`${label} is outside the assigned Forge worktree.`);
}
