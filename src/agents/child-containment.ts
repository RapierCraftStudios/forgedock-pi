import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const value = (input as Record<string, unknown>).path;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Canonicalize the existing prefix while preserving not-yet-created segments. */
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

export function isPathWithin(
  root: string,
  target: string,
  caseInsensitive = false,
): boolean {
  const comparableRoot = caseInsensitive
    ? resolve(root).toLocaleLowerCase("en-US")
    : resolve(root);
  const comparableTarget = caseInsensitive
    ? resolve(target).toLocaleLowerCase("en-US")
    : resolve(target);
  const child = relative(comparableRoot, comparableTarget);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
