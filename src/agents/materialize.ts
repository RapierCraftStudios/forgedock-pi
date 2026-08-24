import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export async function materializeForgeAgents(
  worktreeRoot: string,
): Promise<string[]> {
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
