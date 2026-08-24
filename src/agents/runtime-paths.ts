export const FORGE_RUNTIME_PATHS = [
  ".pi/agents",
  ".pi/forge",
  ".pi/forge.local.json",
] as const;

export const FORGE_RUNTIME_IGNORE_ENTRIES = [
  "/.pi/agents/",
  "/.pi/forge/",
  "/.pi/forge.local.json",
] as const;

export const FORGE_RUNTIME_GIT_PATHSPECS = [
  ":(exclude).pi/agents",
  ":(exclude).pi/forge",
  ":(exclude).pi/forge.local.json",
] as const;

export function isForgeRuntimePath(path: string): boolean {
  const normalized = normalizeGitPath(path);
  return FORGE_RUNTIME_PATHS.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

export function normalizeGitPath(path: string): string {
  let normalized = path.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

export function parseNullDelimitedGitPaths(output: string): string[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map(normalizeGitPath);
}
