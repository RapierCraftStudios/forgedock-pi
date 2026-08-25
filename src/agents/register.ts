import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerAgent,
  type RuntimeAgentRegistration,
} from "pi-subagents/agents";

export const FORGE_WORK_ON_AGENT = "forge-work-on";
export const FORGE_REVIEW_CORRECTNESS_AGENT = "forge-review-correctness";
export const FORGE_REVIEW_SECURITY_AGENT = "forge-review-security";
export const FORGE_REFRESH_REVIEW_AGENT = "forge-refresh-review";
export const FORGE_REVIEW_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "forge_finalize_reviewer",
] as const;
export const FORGE_WORK_ON_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "forge_verify",
  "forge_diff",
  "forge_commit",
  "forge_prepare_review",
  "forge_finalize_node",
] as const;
export const FORGE_REFRESH_REVIEW_TOOLS = [
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "subagent",
  "forge_refresh_base",
  "forge_verify",
  "forge_diff",
  "forge_commit",
  "forge_prepare_review",
  "forge_finalize_work_on",
] as const;
export const FORGE_WORK_ON_MAX_DEPTH = 2;
export const FORGE_WORK_ON_TIMEOUT_MS = 14_400_000;
export const FORGE_REVIEW_TIMEOUT_MS = 3_600_000;

const REVIEW_PROTOCOL = `
Return only the required structured result. Bind every finding to the supplied run ID and exact head SHA. A finding needs an exact file and line, observable impact, and concrete code-path or input evidence. Use confirmed only when the failure is demonstrated; otherwise use likely or possible. Do not edit files, launch subagents, access GitHub, or make merge decisions.
`.trim();

export const FORGE_REVIEW_CORRECTNESS_PROMPT = `You are the correctness member of a ForgeDock review panel. Inspect the frozen worktree/diff and surrounding code. Focus on behavioral correctness, regressions, integration contracts, error paths, and whether tests exercise the changed behavior. ${REVIEW_PROTOCOL}`;

export const FORGE_REVIEW_SECURITY_PROMPT = `You are the security member of a ForgeDock review panel. Inspect the frozen worktree/diff and surrounding code. Trace trust boundaries, authorization, injection, secret exposure, unsafe file/network/process behavior, dependency and deployment risk, and production failure modes. ${REVIEW_PROTOCOL}`;

export const FORGE_REFRESH_REVIEW_PROMPT = `You are the sole writer for a ForgeDock integration refresh. The implementation already completed and received a fresh review, but the configured integration base moved before serialized merge. First call forge_refresh_base. If the controlled rebase succeeds, run every required verification command through forge_verify, inspect the rebased patch through forge_diff, and launch the registered forge-review-correctness and forge-review-security agents together in one fresh-context runs.all workflow. Never reuse earlier findings as the new verdict. Do not call forge_checkpoint and do not repeat investigation, planning, or implementation. If rebase conflicts or verification/review cannot complete, return a schema-valid blocked or needs-human work-on result. Otherwise call forge_prepare_review to update the existing bound PR and freeze its new head, then call forge_finalize_work_on and structured_output with the identical complete ready-for-merge result. The final result must use the bound run ID, issue number, and new base SHA, and increment review.rounds from the previous result. Do not use raw shell, gh, direct push, merge, close, or paths outside the assigned worktree.`;

export const FORGE_WORK_ON_PROMPT = `You are a bounded ForgeDock workflow-node worker and the only writer in your assigned worktree. The parent controller selects exactly one immutable node attempt and owns all durable transitions. Execute only the node named in the task, use the bound tools and contract, and return one schema-valid forgedock.node-result/v1 value. Never process a phase list, infer or write checkpoints, launch nested agents, merge, close, or clean up. Investigation must explicitly classify confirmed, invalid, or decomposed. Review workers inspect only the frozen SHA and return evidence bound to that SHA. Fail closed on malformed input, stale identity, authority errors, or missing required artifacts.`;

export function registerForgeAgents(
  pi: ExtensionAPI,
): RuntimeAgentRegistration[] {
  const childRuntimePath = fileURLToPath(
    new URL("./child-runtime.ts", import.meta.url),
  );
  const subagentsExtensionPath = fileURLToPath(
    import.meta.resolve("pi-subagents"),
  );
  const registrations: RuntimeAgentRegistration[] = [];

  registrations.push(
    registerAgent({
      pi,
      name: FORGE_REVIEW_CORRECTNESS_AGENT,
      definition: {
        description:
          "Fresh-context ForgeDock reviewer for correctness, regressions, contracts, and tests",
        systemPrompt: FORGE_REVIEW_CORRECTNESS_PROMPT,
        systemPromptMode: "replace",
        inheritProjectContext: true,
        inheritSkills: false,
        defaultContext: "fresh",
        tools: [...FORGE_REVIEW_TOOLS],
        extensions: [childRuntimePath],
        acceptanceRole: "read-only",
        defaultAsync: false,
        defaultTimeoutMs: FORGE_REVIEW_TIMEOUT_MS,
        maxSubagentDepth: 1,
        completionGuard: true,
      },
    }),
  );

  registrations.push(
    registerAgent({
      pi,
      name: FORGE_REVIEW_SECURITY_AGENT,
      definition: {
        description:
          "Fresh-context ForgeDock reviewer for security, trust boundaries, secrets, and production safety",
        systemPrompt: FORGE_REVIEW_SECURITY_PROMPT,
        systemPromptMode: "replace",
        inheritProjectContext: true,
        inheritSkills: false,
        defaultContext: "fresh",
        tools: [...FORGE_REVIEW_TOOLS],
        extensions: [childRuntimePath],
        acceptanceRole: "read-only",
        defaultAsync: false,
        defaultTimeoutMs: FORGE_REVIEW_TIMEOUT_MS,
        maxSubagentDepth: 1,
        completionGuard: true,
      },
    }),
  );

  registrations.push(
    registerAgent({
      pi,
      name: FORGE_REFRESH_REVIEW_AGENT,
      definition: {
        description:
          "Rebase one completed ForgeDock lane onto the latest integration base and run fresh verification/review",
        systemPrompt: FORGE_REFRESH_REVIEW_PROMPT,
        systemPromptMode: "replace",
        inheritProjectContext: true,
        inheritSkills: false,
        defaultContext: "fresh",
        tools: [...FORGE_REFRESH_REVIEW_TOOLS],
        extensions: [subagentsExtensionPath, childRuntimePath],
        acceptanceRole: "writer",
        defaultAcceptance: {
          level: "checked",
          evidence: [
            "changed-files",
            "commands-run",
            "validation-output",
            "residual-risks",
          ],
        },
        defaultAsync: true,
        defaultTimeoutMs: FORGE_WORK_ON_TIMEOUT_MS,
        maxSubagentDepth: FORGE_WORK_ON_MAX_DEPTH,
        completionGuard: true,
      },
    }),
  );

  registrations.push(
    registerAgent({
      pi,
      name: FORGE_WORK_ON_AGENT,
      definition: {
        description:
          "Own one ForgeDock issue through investigation, implementation, verification, and nested fresh review",
        systemPrompt: FORGE_WORK_ON_PROMPT,
        systemPromptMode: "replace",
        inheritProjectContext: true,
        inheritSkills: false,
        defaultContext: "fresh",
        tools: [...FORGE_WORK_ON_TOOLS],
        extensions: [subagentsExtensionPath, childRuntimePath],
        acceptanceRole: "writer",
        defaultAcceptance: {
          level: "checked",
          evidence: [
            "changed-files",
            "tests-added",
            "commands-run",
            "validation-output",
            "residual-risks",
          ],
        },
        defaultAsync: true,
        defaultTimeoutMs: FORGE_WORK_ON_TIMEOUT_MS,
        maxSubagentDepth: FORGE_WORK_ON_MAX_DEPTH,
        completionGuard: true,
      },
    }),
  );

  return registrations;
}
