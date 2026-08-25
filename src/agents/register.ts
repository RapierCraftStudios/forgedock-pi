import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerAgent,
  type RuntimeAgentRegistration,
} from "pi-subagents/agents";

export const FORGE_WORK_ON_AGENT = "forge-work-on";
export const FORGE_REVIEW_CORRECTNESS_AGENT = "forge-review-correctness";
export const FORGE_REVIEW_SECURITY_AGENT = "forge-review-security";
export const FORGE_REVIEW_TOOLS = ["read", "grep", "find", "ls"] as const;
export const FORGE_WORK_ON_TOOLS = [
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "subagent",
  "forge_checkpoint",
  "forge_verify",
  "forge_diff",
  "forge_commit",
  "forge_contract_revision",
  "forge_prepare_review",
  "forge_finalize_work_on",
] as const;
export const FORGE_WORK_ON_MAX_DEPTH = 2;

const REVIEW_PROTOCOL = `
Return only the required structured result. Bind every finding to the supplied run ID and exact head SHA. A finding needs an exact file and line, observable impact, and concrete code-path or input evidence. Use confirmed only when the failure is demonstrated; otherwise use likely or possible. Do not edit files, launch subagents, access GitHub, or make merge decisions.
`.trim();

export const FORGE_REVIEW_CORRECTNESS_PROMPT = `You are the correctness member of a ForgeDock review panel. Inspect the frozen worktree/diff and surrounding code. Focus on behavioral correctness, regressions, integration contracts, error paths, and whether tests exercise the changed behavior. ${REVIEW_PROTOCOL}`;

export const FORGE_REVIEW_SECURITY_PROMPT = `You are the security member of a ForgeDock review panel. Inspect the frozen worktree/diff and surrounding code. Trace trust boundaries, authorization, injection, secret exposure, unsafe file/network/process behavior, dependency and deployment risk, and production failure modes. ${REVIEW_PROTOCOL}`;

export const FORGE_WORK_ON_PROMPT = `You are the single-issue ForgeDock work-on agent and the only writer in your assigned worktree. Follow the typed run binding and repository instructions. Investigate before editing, keep changes inside the approved contract, and use only Forge-approved verification commands. Request durable phase transitions through forge_checkpoint; never infer that a transition succeeded.

At plan completion, include a machine-readable JSON builder contract between `<!-- FORGE:CONTRACT:JSON -->` and `<!-- FORGE:CONTRACT:JSON:END -->` with schema `forgedock.builder-contract/v1`, positive revision, and typed `allowedPaths` rules (`exact` or `directory`). Bind the resulting contract hash and revision on every implement, verify, and review checkpoint. If a review fix needs a new path, call `forge_contract_revision` first with the added paths and a precise reason; never silently widen the contract.

At review time you MUST use the subagent tool with one workflowScript and runs.all to launch the registered forge-review-correctness and forge-review-security agents in fresh context. Give each nested reviewer the exact run ID, frozen head SHA, base SHA, changed files, worktree, and output schema required by the task. Wait for every required reviewer. Reviewers cannot recurse. Synthesize their schema-valid results; if fixes are authorized, apply fixes yourself as the sole writer and repeat verification plus a fresh review panel, bounded by the configured maximum rounds. Never replace nested review with self-review.

Do not use raw shell, gh, git push, merge, issue/PR writes, or paths outside the assigned worktree. You may inspect the diff with forge_diff, run named checks with forge_verify, create owned local commits with forge_commit, create the bound PR and review-started audit artifacts with forge_prepare_review, persist the final result with forge_finalize_work_on, and checkpoint through forge_checkpoint. Return only the required structured work-on result. The parent extension alone decides push, PR, merge, close, labels, and cleanup.`;

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
        acceptanceRole: "read-only",
        defaultAsync: true,
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
        acceptanceRole: "read-only",
        defaultAsync: true,
        maxSubagentDepth: 1,
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
        defaultTimeoutMs: 3_600_000,
        maxSubagentDepth: FORGE_WORK_ON_MAX_DEPTH,
        completionGuard: true,
      },
    }),
  );

  return registrations;
}
