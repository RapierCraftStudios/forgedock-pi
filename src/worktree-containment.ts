import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  canonicalizePotentialPath,
  isPathWithin,
  toolPath,
} from "./agents/child-containment.ts";

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const REPOSITORY_ROOT_TOOLS = new Set([
  "forgedock_preflight",
  "forgedock_github",
]);

interface WorktreeContainment {
  readonly worktreeRoot: string;
  readonly anchorRoot: string;
}

/**
 * Keep Pi sessions launched in a linked Git worktree away from the anchor
 * checkout. This guard does not depend on optional Forge child bindings, so it
 * also protects prompt-routed work-on coordinators.
 */
export function registerForgeWorktreeContainment(pi: ExtensionAPI): void {
  let containment: WorktreeContainment | undefined;

  pi.on("session_start", async (_event, ctx) => {
    containment = await discoverWorktreeContainment(pi, ctx.cwd);
  });

  pi.on("tool_call", async (event, ctx) => {
    const active = containment;
    if (!active) return;

    if (FILE_TOOLS.has(event.toolName)) {
      const pathValue = toolPath(event.input);
      if (!pathValue) return;
      const target = await canonicalizePotentialPath(ctx.cwd, pathValue);
      if (
        isPathWithin(active.anchorRoot, target) &&
        !isPathWithin(active.worktreeRoot, target)
      )
        return containmentDenial(event.toolName);
      return;
    }

    if (event.toolName === "bash") {
      const command = inputString(event.input, "command");
      if (command && command.includes(active.anchorRoot))
        return containmentDenial(event.toolName);
      return;
    }

    if (REPOSITORY_ROOT_TOOLS.has(event.toolName)) {
      const repositoryRoot = inputString(event.input, "repositoryRoot");
      if (!repositoryRoot) return;
      const target = await canonicalizePotentialPath(ctx.cwd, repositoryRoot);
      if (
        isPathWithin(active.anchorRoot, target) &&
        !isPathWithin(active.worktreeRoot, target)
      )
        return containmentDenial(event.toolName);
    }
  });
}

async function discoverWorktreeContainment(
  pi: ExtensionAPI,
  cwd: string,
): Promise<WorktreeContainment | undefined> {
  const [rootResult, commonResult] = await Promise.all([
    pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 30_000,
    }),
    pi.exec("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
      cwd,
      timeout: 30_000,
    }),
  ]);
  if (rootResult.code !== 0 || commonResult.code !== 0) return undefined;

  const rootValue = rootResult.stdout.trim();
  const commonValue = commonResult.stdout.trim();
  if (!rootValue || !commonValue) return undefined;

  const worktreeRoot = await realpath(resolve(cwd, rootValue));
  const commonDirectory = await realpath(resolve(cwd, commonValue));
  const anchorRoot = dirname(commonDirectory);
  if (anchorRoot === worktreeRoot) return undefined;
  return Object.freeze({ worktreeRoot, anchorRoot });
}

function inputString(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function containmentDenial(toolName: string): {
  readonly block: true;
  readonly reason: string;
} {
  return {
    block: true,
    reason: `${toolName} cannot access the anchor checkout from an isolated Forge worktree. Use the assigned worktree cwd as the repository root.`,
  };
}
