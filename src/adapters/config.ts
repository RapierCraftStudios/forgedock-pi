import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  applyLocalOverrides,
  parseForgePolicy,
  type ForgePolicy,
  type LocalForgeOverrides,
} from "../core/policy.ts";

export interface LoadedForgePolicy {
  policy: ForgePolicy;
  trackedPath: string;
  localPath: string;
  localOverridesApplied: boolean;
}

export async function loadForgePolicy(
  repositoryRoot: string,
): Promise<LoadedForgePolicy> {
  const trackedPath = join(repositoryRoot, ".forge", "config.json");
  const localPath = join(repositoryRoot, ".pi", "forge.local.json");
  const tracked = parseForgePolicy(await readJsonFile(trackedPath, true));
  const localValue = await readJsonFile(localPath, false);
  const local =
    localValue === undefined ? undefined : parseLocalOverrides(localValue);
  return {
    policy: local ? applyLocalOverrides(tracked, local) : tracked,
    trackedPath,
    localPath,
    localOverridesApplied: local !== undefined,
  };
}

async function readJsonFile(path: string, required: boolean): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!required && isMissingFile(error)) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load Forge policy ${path}: ${message}`);
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

function parseLocalOverrides(value: unknown): LocalForgeOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Local Forge overrides must be an object.");
  }
  const root = value as Record<string, unknown>;
  const overrides: LocalForgeOverrides = {};
  if (root.branches !== undefined) {
    if (
      !root.branches ||
      typeof root.branches !== "object" ||
      Array.isArray(root.branches)
    )
      throw new TypeError("local branches must be an object");
    const autoMerge = (root.branches as Record<string, unknown>)
      .autoMergeIntegration;
    if (autoMerge !== undefined && autoMerge !== false)
      throw new TypeError("local autoMergeIntegration can only be false");
    overrides.branches =
      autoMerge === false ? { autoMergeIntegration: false } : {};
  }
  if (root.subagents !== undefined) {
    if (
      !root.subagents ||
      typeof root.subagents !== "object" ||
      Array.isArray(root.subagents)
    )
      throw new TypeError("local subagents must be an object");
    const maxConcurrent = (root.subagents as Record<string, unknown>)
      .maxConcurrent;
    if (
      maxConcurrent !== undefined &&
      (!Number.isSafeInteger(maxConcurrent) || (maxConcurrent as number) < 1)
    ) {
      throw new TypeError(
        "local maxConcurrent must be a positive safe integer",
      );
    }
    overrides.subagents =
      maxConcurrent === undefined
        ? {}
        : { maxConcurrent: maxConcurrent as number };
  }
  if (root.verification !== undefined) {
    if (
      !root.verification ||
      typeof root.verification !== "object" ||
      Array.isArray(root.verification)
    )
      throw new TypeError("local verification must be an object");
    const commandsValue = (root.verification as Record<string, unknown>)
      .commands;
    if (
      commandsValue !== undefined &&
      (!commandsValue ||
        typeof commandsValue !== "object" ||
        Array.isArray(commandsValue))
    ) {
      throw new TypeError("local verification.commands must be an object");
    }
    const commands: Record<string, { timeoutMs?: number }> = {};
    for (const [name, commandValue] of Object.entries(
      (commandsValue ?? {}) as Record<string, unknown>,
    )) {
      if (
        !commandValue ||
        typeof commandValue !== "object" ||
        Array.isArray(commandValue)
      )
        throw new TypeError(
          `local verification command ${name} must be an object`,
        );
      const timeoutMs = (commandValue as Record<string, unknown>).timeoutMs;
      if (
        timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1_000)
      ) {
        throw new TypeError(
          `local verification command ${name} timeoutMs must be at least 1000`,
        );
      }
      commands[name] =
        timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number };
    }
    overrides.verification = { commands };
  }
  return overrides;
}
