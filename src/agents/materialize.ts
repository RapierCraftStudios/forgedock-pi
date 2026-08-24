import {
  appendFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORGE_REVIEW_CORRECTNESS_AGENT,
  FORGE_REVIEW_CORRECTNESS_PROMPT,
  FORGE_REVIEW_SECURITY_AGENT,
  FORGE_REVIEW_SECURITY_PROMPT,
  FORGE_REVIEW_TOOLS,
  FORGE_WORK_ON_AGENT,
  FORGE_WORK_ON_MAX_DEPTH,
  FORGE_WORK_ON_PROMPT,
  FORGE_WORK_ON_TOOLS,
} from "./register.ts";
import { FORGE_RUNTIME_IGNORE_ENTRIES } from "./runtime-paths.ts";

const FORGE_RUNTIME_IGNORE_MARKER = "# ForgeDock generated runtime paths";

export async function materializeForgeAgents(
  worktreeRoot: string,
): Promise<string[]> {
  await ensureForgeRuntimeIgnored(worktreeRoot);
  const agentsDir = join(worktreeRoot, ".pi", "agents");
  await mkdir(agentsDir, { recursive: true, mode: 0o700 });
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
        extensions: [subagentsExtensionPath, childRuntimePath],
        timeoutMs: 3_600_000,
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

async function ensureForgeRuntimeIgnored(worktreeRoot: string): Promise<void> {
  const gitDirectory = await resolveGitDirectory(worktreeRoot);
  if (!gitDirectory) return;

  const excludePath = join(gitDirectory, "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  const existing = await readFile(excludePath, "utf8").catch(() => "");
  const lines = new Set(existing.split(/\r?\n/));
  const missingEntries = FORGE_RUNTIME_IGNORE_ENTRIES.filter(
    (entry) => !lines.has(entry),
  );
  if (missingEntries.length === 0) return;

  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(
    excludePath,
    `${separator}${FORGE_RUNTIME_IGNORE_MARKER}\n${missingEntries.join("\n")}\n`,
    "utf8",
  );
}

async function resolveGitDirectory(
  worktreeRoot: string,
): Promise<string | undefined> {
  const gitPath = join(worktreeRoot, ".git");
  let gitStats;
  try {
    gitStats = await stat(gitPath);
  } catch {
    return undefined;
  }
  if (gitStats.isDirectory()) return gitPath;

  const gitFile = await readFile(gitPath, "utf8").catch(() => "");
  const match = /^gitdir:\s*(.+)\s*$/im.exec(gitFile);
  if (!match?.[1]) return undefined;
  const worktreeGitDirectory = resolve(worktreeRoot, match[1]);
  const commonDirectory = await readFile(
    join(worktreeGitDirectory, "commondir"),
    "utf8",
  ).catch(() => "");
  return commonDirectory.trim()
    ? resolve(worktreeGitDirectory, commonDirectory.trim())
    : worktreeGitDirectory;
}

function agentFile(input: {
  name: string;
  description: string;
  tools: readonly string[];
  prompt: string;
  maxDepth: number;
  acceptanceRole: "read-only" | "writer";
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
async: true
tools: ${input.tools.join(", ")}
acceptanceRole: ${input.acceptanceRole}
maxSubagentDepth: ${input.maxDepth}
completionGuard: true
${input.timeoutMs ? `timeoutMs: ${input.timeoutMs}\n` : ""}${extensionBlock}---

${input.prompt}
`;
}
