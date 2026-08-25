import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORGE_REVIEW_CORRECTNESS_AGENT,
  FORGE_REVIEW_CORRECTNESS_PROMPT,
  FORGE_REVIEW_SECURITY_AGENT,
  FORGE_REVIEW_SECURITY_PROMPT,
  FORGE_REVIEW_TIMEOUT_MS,
  FORGE_REVIEW_TOOLS,
  FORGE_REFRESH_REVIEW_AGENT,
  FORGE_REFRESH_REVIEW_PROMPT,
  FORGE_REFRESH_REVIEW_TOOLS,
  FORGE_WORK_ON_AGENT,
  FORGE_WORK_ON_MAX_DEPTH,
  FORGE_WORK_ON_PROMPT,
  FORGE_WORK_ON_TIMEOUT_MS,
  FORGE_WORK_ON_TOOLS,
} from "./register.ts";

export async function materializeForgeAgents(
  worktreeRoot: string,
): Promise<string[]> {
  const rootDir = await openAnchoredDirectory(worktreeRoot);
  try {
    const piDir = await ensureDirectory(rootDir, ".pi");
    try {
      const agentsDir = await ensureDirectory(piDir, "agents");
      try {
        await materializeRetrySettings(piDir);
        const childRuntimePath = fileURLToPath(
          new URL("./child-runtime.ts", import.meta.url),
        );
        const subagentsExtensionPath = fileURLToPath(
          import.meta.resolve("pi-subagents"),
        );
        const files = [
          {
            name: FORGE_WORK_ON_AGENT,
            content: agentFile({
              name: FORGE_WORK_ON_AGENT,
              description:
                "Own one ForgeDock issue through implementation and nested fresh review",
              tools: FORGE_WORK_ON_TOOLS,
              prompt: FORGE_WORK_ON_PROMPT,
              maxDepth: FORGE_WORK_ON_MAX_DEPTH,
              acceptanceRole: "writer",
              async: true,
              extensions: [subagentsExtensionPath, childRuntimePath],
              timeoutMs: FORGE_WORK_ON_TIMEOUT_MS,
            }),
          },
          {
            name: FORGE_REFRESH_REVIEW_AGENT,
            content: agentFile({
              name: FORGE_REFRESH_REVIEW_AGENT,
              description:
                "Rebase a completed ForgeDock lane and run fresh verification/review",
              tools: FORGE_REFRESH_REVIEW_TOOLS,
              prompt: FORGE_REFRESH_REVIEW_PROMPT,
              maxDepth: FORGE_WORK_ON_MAX_DEPTH,
              acceptanceRole: "writer",
              async: true,
              extensions: [subagentsExtensionPath, childRuntimePath],
              timeoutMs: FORGE_WORK_ON_TIMEOUT_MS,
            }),
          },
          {
            name: FORGE_REVIEW_CORRECTNESS_AGENT,
            content: agentFile({
              name: FORGE_REVIEW_CORRECTNESS_AGENT,
              description:
                "Fresh correctness and regression reviewer for ForgeDock",
              tools: FORGE_REVIEW_TOOLS,
              prompt: FORGE_REVIEW_CORRECTNESS_PROMPT,
              maxDepth: 1,
              acceptanceRole: "read-only",
              async: false,
              extensions: [childRuntimePath],
              timeoutMs: FORGE_REVIEW_TIMEOUT_MS,
            }),
          },
          {
            name: FORGE_REVIEW_SECURITY_AGENT,
            content: agentFile({
              name: FORGE_REVIEW_SECURITY_AGENT,
              description:
                "Fresh security and production-safety reviewer for ForgeDock",
              tools: FORGE_REVIEW_TOOLS,
              prompt: FORGE_REVIEW_SECURITY_PROMPT,
              maxDepth: 1,
              acceptanceRole: "read-only",
              async: false,
              extensions: [childRuntimePath],
              timeoutMs: FORGE_REVIEW_TIMEOUT_MS,
            }),
          },
        ];

        const paths: string[] = [];
        for (const file of files) {
          const name = `${file.name}.md`;
          await writeTextFile(agentsDir, name, file.content, 0o600);
          paths.push(join(worktreeRoot, ".pi", "agents", name));
        }
        return paths;
      } finally {
        await agentsDir.close();
      }
    } finally {
      await piDir.close();
    }
  } finally {
    await rootDir.close();
  }
}

async function materializeRetrySettings(piDir: FileHandle): Promise<void> {
  let existingText: string | undefined;
  try {
    existingText = await readTextFile(piDir, "settings.json");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (existingText !== undefined) {
    const existing = JSON.parse(existingText) as {
      retry?: { enabled?: unknown; maxRetries?: unknown };
    };
    if (existing.retry?.enabled === false)
      throw new Error(
        "ForgeDock requires Pi native retry for transient provider failures, but project .pi/settings.json disables it.",
      );
    if (
      existing.retry?.maxRetries !== undefined &&
      (!Number.isSafeInteger(existing.retry.maxRetries) ||
        (existing.retry.maxRetries as number) < 3)
    )
      throw new Error(
        "ForgeDock requires retry.maxRetries to be at least 3 for transient provider recovery.",
      );
    return;
  }
  await writeTextFile(
    piDir,
    "settings.json",
    `${JSON.stringify(
      {
        retry: {
          enabled: true,
          maxRetries: 5,
          baseDelayMs: 2_000,
          provider: { maxRetries: 0, maxRetryDelayMs: 60_000 },
        },
        transport: "auto",
      },
      null,
      2,
    )}\n`,
    0o600,
  );
  const markerDir = await ensureDirectory(piDir, "forge");
  try {
    await writeTextFile(markerDir, "generated-settings", "settings.json\n", 0o600);
  } finally {
    await markerDir.close();
  }
}

async function openAnchoredDirectory(path: string): Promise<FileHandle> {
  const flags = directoryFlags();
  const absolute = resolve(path);
  const segments = absolute.split(sep).filter(Boolean);
  let current = await open(sep, flags);
  for (const segment of segments) {
    const childPath = descriptorPath(current, segment);
    let next: FileHandle;
    try {
      next = await open(childPath, flags);
    } catch (error) {
      await current.close().catch(() => undefined);
      throw error;
    }
    await current.close();
    current = next;
  }
  return current;
}

async function ensureDirectory(
  parent: FileHandle,
  name: string,
): Promise<FileHandle> {
  const path = descriptorPath(parent, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  return open(path, directoryFlags());
}

async function readTextFile(parent: FileHandle, name: string): Promise<string> {
  const handle = await openFinalFile(parent, name, constants.O_RDONLY);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writeTextFile(
  parent: FileHandle,
  name: string,
  content: string,
  mode: number,
): Promise<void> {
  const handle = await openFinalFile(
    parent,
    name,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    mode,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function openFinalFile(
  parent: FileHandle,
  name: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  requireSecureFilesystem();
  return open(
    descriptorPath(parent, name),
    flags | constants.O_NOFOLLOW,
    mode,
  );
}

function directoryFlags(): number {
  requireSecureFilesystem();
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

function descriptorPath(parent: FileHandle, name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  )
    throw new TypeError("Secure Forge paths require a single file name.");
  return join(descriptorRoot(), String(parent.fd), name);
}

function descriptorRoot(): string {
  if (process.platform === "linux" || process.platform === "android")
    return "/proc/self/fd";
  if (
    process.platform === "darwin" ||
    process.platform === "freebsd" ||
    process.platform === "openbsd" ||
    process.platform === "netbsd"
  )
    return "/dev/fd";
  throw new Error(
    "ForgeDock cannot safely materialize runtime files on this platform: directory-handle no-follow support is unavailable.",
  );
}

function requireSecureFilesystem(): void {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  )
    throw new Error(
      "ForgeDock cannot safely materialize runtime files: no-follow directory opens are unavailable.",
    );
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === code,
  );
}

function isMissingFile(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

function agentFile(input: {
  name: string;
  description: string;
  tools: readonly string[];
  prompt: string;
  maxDepth: number;
  acceptanceRole: "read-only" | "writer";
  async: boolean;
  extensions?: readonly string[];
  timeoutMs?: number;
}): string {
  const extensionBlock = input.extensions?.length
    ? `extensions:\n${input.extensions.map((path) => `  - ${path}`).join("\n")}\n`
    : "";
  return `---
name: ${input.name}
description: ${JSON.stringify(input.description)}
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
async: ${input.async}
tools: ${input.tools.join(", ")}
acceptanceRole: ${input.acceptanceRole}
maxSubagentDepth: ${input.maxDepth}
completionGuard: true
${input.timeoutMs ? `timeoutMs: ${input.timeoutMs}\n` : ""}${extensionBlock}---

${input.prompt}
`;
}
