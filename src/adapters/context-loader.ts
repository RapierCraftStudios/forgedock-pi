import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

import type { ContextReference } from "../core/context-capsules.ts";

const ROOT_CONTEXT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "package.json",
] as const;
const PATH_CONTEXT_FILES = ["AGENTS.md", "README.md", "package.json"] as const;

export interface LoadedContextReference extends ContextReference {
  content: string;
}

export async function loadRepositoryContext(input: {
  repositoryRoot: string;
  revision: string;
  affectedPaths?: readonly string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}): Promise<LoadedContextReference[]> {
  const root = await realpath(input.repositoryRoot);
  const candidates = new Map<string, { reason: string; scope: string }>();
  for (const name of ROOT_CONTEXT_FILES)
    candidates.set(join(root, name), {
      reason: "root repository guidance",
      scope: ".",
    });

  for (const affected of input.affectedPaths ?? []) {
    if (!affected.trim() || isAbsolute(affected) || affected.split(/[\\/]/).includes(".."))
      throw new TypeError(`Affected context path is unsafe: ${affected}.`);
    let cursor = dirname(resolve(root, affected));
    while (pathWithin(root, cursor)) {
      const scope = relative(root, cursor) || ".";
      for (const name of PATH_CONTEXT_FILES)
        candidates.set(join(cursor, name), {
          reason: `nearest guidance for ${affected}`,
          scope,
        });
      if (cursor === root) break;
      cursor = dirname(cursor);
    }
  }

  const output: LoadedContextReference[] = [];
  let totalBytes = 0;
  for (const [candidate, metadata] of candidates) {
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      continue;
    }
    if (!pathWithin(root, canonical) || !(await stat(canonical)).isFile()) continue;
    const content = await readFile(canonical, "utf8");
    const bytes = Buffer.byteLength(content);
    if (bytes > (input.maxFileBytes ?? 64 * 1024)) continue;
    if (totalBytes + bytes > (input.maxTotalBytes ?? 256 * 1024)) break;
    totalBytes += bytes;
    output.push({
      path: relative(root, canonical) || ".",
      revision: input.revision,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes,
      reason: metadata.reason,
      scope: metadata.scope,
      content,
    });
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function pathWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
