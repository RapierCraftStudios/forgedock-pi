import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/**
 * Resolves the bound worktree and rejects a child session whose cwd escaped it.
 * The returned root is canonical so later path checks cannot be redirected by
 * a symlink at the worktree boundary.
 */
export async function resolveBoundWorktreeRoot(
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
 * Returns the deterministic denial reason for a model file tool, or undefined
 * when the tool has no path input or the path is allowed.
 */
export async function checkToolPath(
  root: string,
  cwd: string,
  input: unknown,
  toolName: string,
): Promise<string | undefined> {
  const pathValue = toolPath(input);
  if (!pathValue) return undefined;
  const target = await canonicalizePotentialPath(cwd, pathValue);
  if (!isPathWithin(root, target)) {
    return `${toolName} path is outside the assigned Forge worktree.`;
  }
  if (
    isPathWithin(join(root, ".pi"), target) ||
    isPathWithin(join(root, ".git"), target)
  ) {
    return `${toolName} cannot access Forge runtime or Git control files.`;
  }
  return undefined;
}

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

/**
 * Writes the child result without following a runtime-directory or result-file
 * symlink. The result is deliberately confined to the generated `.pi/forge`
 * directory, which is not part of the model's editable surface.
 */
export async function writeBoundResult(
  worktreeRoot: string,
  resultPath: string,
  content: string,
): Promise<void> {
  const protectedRoot = resolve(worktreeRoot, ".pi", "forge");
  const target = resolve(resultPath);
  if (!isPathWithin(protectedRoot, target))
    throw new Error("Bound result path is outside the protected Forge result directory.");

  await mkdir(protectedRoot, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(protectedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory())
    throw new Error("Forge result directory must be a real directory.");
  if ((await realpath(protectedRoot)) !== protectedRoot)
    throw new Error("Forge result directory must not resolve through a symlink.");

  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent || !isPathWithin(protectedRoot, parent))
    throw new Error("Forge result parent must remain inside the protected directory.");
  const metadata = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  });
  if (metadata?.isSymbolicLink())
    throw new Error("Forge result path must not be a symbolic link.");

  const noFollow = constants.O_NOFOLLOW ?? 0;
  if (!noFollow) {
    await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    return;
  }
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}
