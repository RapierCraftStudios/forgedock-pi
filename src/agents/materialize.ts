import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  const piDir = join(worktreeRoot, ".pi");
  const agentsDir = join(piDir, "agents");
  await mkdir(agentsDir, { recursive: true, mode: 0o700 });
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
        description: "Fresh correctness and regression reviewer for ForgeDock",
        tools: FORGE_REVIEW_TOOLS,
        prompt: FORGE_REVIEW_CORRECTNESS_PROMPT,
        maxDepth: 1,
        acceptanceRole: "read-only",
        async: false,
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
        timeoutMs: FORGE_REVIEW_TIMEOUT_MS,
      }),
    },
  ];

  const paths: string[] = [];
  for (const file of files) {
    const path = join(agentsDir, `${file.name}.md`);
    await writeFile(path, file.content, { encoding: "utf8", mode: 0o600 });
    paths.push(path);
  }
  return paths;
}

async function materializeRetrySettings(piDir: string): Promise<void> {
  const settingsPath = join(piDir, "settings.json");
  try {
    await access(settingsPath);
    const existing = JSON.parse(await readFile(settingsPath, "utf8")) as {
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
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await writeFile(
    settingsPath,
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
    { encoding: "utf8", mode: 0o600 },
  );
  const markerDir = join(piDir, "forge");
  await mkdir(markerDir, { recursive: true, mode: 0o700 });
  await writeFile(join(markerDir, "generated-settings"), "settings.json\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
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
