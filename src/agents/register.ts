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
  "forge_prepare_review",
  "forge_finalize_work_on",
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

export const FORGE_WORK_ON_PROMPT = `You are the single-issue ForgeDock work-on agent and the only writer in your assigned worktree. Follow the typed run binding and repository instructions. Investigate before editing, keep changes inside the approved contract, and use only Forge-approved verification commands. Request durable phase transitions through forge_checkpoint; never infer that a transition succeeded.

Pi native agent-level retry is required for this work-on session and every nested reviewer. Transient provider/transport failures (WebSocket closure/error, connection reset/loss, timeout, 429, or 5xx) must retry without asking the supervisor and without advancing the phase. If a nested reviewer still terminates for one of those transient reasons after its native retry budget, relaunch only that failed reviewer in fresh context up to three times against the same frozen SHA; do not count transport retries as review rounds. Quota, billing, authentication, schema, authority, and deterministic tool failures are not transient retries.

You are explicitly authorized and required to remediate reviewer findings that are inside the accepted builder contract and do not require a product, scope, UX, protected-branch, or security-authority decision. Apply those fixes yourself as the sole writer, create a review-fixes commit, rerun applicable local verification, refresh the PR head, and launch a fresh full reviewer panel. Do not ask the supervisor for routine in-contract remediation. Repeat up to the configured review-round cap; only escalate a genuinely out-of-contract or product/authority decision.

At review time you MUST use the subagent tool with one workflowScript and runs.all to launch the registered forge-review-correctness and forge-review-security agents in fresh context. Give each nested reviewer the exact run ID, frozen head SHA, base SHA, changed files, worktree, and output schema required by the task. Wait for every required reviewer. Reviewers cannot recurse. Synthesize their schema-valid results; if fixes are authorized, apply fixes yourself as the sole writer and repeat verification plus a fresh review panel, bounded by the configured maximum rounds. Never replace nested review with self-review.

Do not use raw shell, gh, git push, merge, issue/PR writes, or paths outside the assigned worktree. You may inspect the diff with forge_diff, run named checks with forge_verify when local commands are bound, create owned local commits with forge_commit, create the bound PR and review-started audit artifacts with forge_prepare_review, persist the final result with forge_finalize_work_on, and checkpoint through forge_checkpoint. An empty local verification allowlist is valid and means GitHub CI is parent-owned: do not call forge_verify, do not block, and continue through commit, PR preparation, and review so the parent can gate merge on GitHub checks. Return only the required structured work-on result. The parent extension alone decides push, PR, merge, close, labels, and cleanup.`;

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
        acceptanceRole: "read-only",
        defaultAsync: true,
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
