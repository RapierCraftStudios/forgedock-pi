export const FORGE_RUNTIME_PATHS = [
  ".pi/agents",
  ".pi/forge",
  ".pi/forge.local.json",
  ".pi/settings.json",
] as const;

/**
 * Stage changes to paths that are already tracked by the current commit.
 *
 * This is intentionally separate from the all-path staging command: tracked
 * changes under a protected path may be intentional issue work, while new
 * Forge runtime files must never be inferred to be product changes.
 */
export function forgeTrackedStagingArgs(): readonly string[] {
  return ["add", "--update", "--", "."];
}

/**
 * Stage product paths while excluding files created by the Forge runtime.
 * Git pathspecs are used instead of shell globs so filenames are not parsed
 * by a shell and the exclusion applies recursively.
 */
export function forgeProductStagingArgs(): readonly string[] {
  return [
    "add",
    "--all",
    "--",
    ".",
    ...FORGE_RUNTIME_PATHS.flatMap((path) =>
      path.endsWith(".json")
        ? [`:(exclude)${path}`]
        : [`:(exclude)${path}`, `:(exclude)${path}/**`],
    ),
  ];
}

export function parseGitPathList(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

export function isTruncatedGitOutput(output: string): boolean {
  return output.startsWith("[output truncated to last ");
}

/**
 * Remove untracked Forge runtime entries from porcelain status output. Forge
 * owns these files for the duration of a run, but they are not product
 * changes and must not make review preparation or parent cleanup fail.
 */
export function filterForgeRuntimeStatus(output: string): string {
  return output
    .split("\n")
    .filter((line) => {
      if (!line.startsWith("?? ")) return true;
      const path = line.slice(3).trim();
      return !isForgeRuntimePath(path.endsWith("/") ? path.slice(0, -1) : path);
    })
    .join("\n");
}

export function isForgeRuntimePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return FORGE_RUNTIME_PATHS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}

/**
 * Find staged Forge runtime paths that were not present in HEAD. Comparing
 * against HEAD rather than the mutable index prevents an already staged new
 * runtime file from being mistaken for an intentionally tracked file.
 */
export function findUnexpectedForgeRuntimePaths(
  stagedPaths: readonly string[],
  headPaths: readonly string[],
): string[] {
  const committedRuntimePaths = new Set(
    headPaths.filter((path) => isForgeRuntimePath(path)),
  );
  return [
    ...new Set(
      stagedPaths.filter(
        (path) =>
          isForgeRuntimePath(path) && !committedRuntimePaths.has(path),
      ),
    ),
  ];
}
