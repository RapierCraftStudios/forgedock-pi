import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerAgent,
  type RuntimeAgentRegistration,
} from "pi-subagents/agents";

export const FORGE_WORK_ON_AGENT = "forge-work-on";
export const FORGE_READ_ONLY_NODE_AGENT = "forge-read-only-node";
export const FORGE_REVIEW_CORRECTNESS_AGENT = "forge-review-correctness";
export const FORGE_REVIEW_SECURITY_AGENT = "forge-review-security";
export const FORGE_REVIEW_DOMAIN_AGENT = "forge-review-domain";
export const FORGE_REFRESH_REVIEW_AGENT = "forge-refresh-review";
export const FORGE_REVIEW_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "forge_diff",
  "forge_finalize_reviewer",
] as const;
export const FORGE_READ_ONLY_NODE_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "forge_verify",
  "forge_diff",
  "forge_prepare_review",
  "forge_finalize_node",
] as const;
export const FORGE_WORK_ON_TOOLS = [
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "subagent",
  "forge_run_review_panel",
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
export const FORGE_REVIEW_TIMEOUT_MS = 900_000;

const REVIEW_PROTOCOL = `
Return only the required structured result. Call forge_diff first and review only behavior introduced or changed by that frozen patch. If forge_diff returns a nextCursor, call forge_diff again in patch mode with that exact cursor and repeat until coverage.complete is true; finalization is forbidden before every chunk is read. Surrounding code may be read for context, but pre-existing defects outside the patch are out of scope and must not become findings. Bind every finding to the supplied run ID and exact head SHA. A finding needs an exact changed file and line, observable impact, and concrete code-path or input evidence. Use confirmed only when the failure is demonstrated; otherwise use likely or possible. Do not edit files, launch subagents, access GitHub, or make merge decisions.
`.trim();

export const FORGE_REVIEW_CORRECTNESS_PROMPT = `You are the correctness member of a ForgeDock review panel. Inspect the frozen worktree/diff and surrounding code. Focus on behavioral correctness, regressions, integration contracts, error paths, and whether tests exercise the changed behavior. ${REVIEW_PROTOCOL}`;

export const FORGE_REVIEW_SECURITY_PROMPT = `You are the security member of a ForgeDock review panel. Inspect the frozen worktree/diff and surrounding code. Trace trust boundaries, authorization, injection, secret exposure, unsafe file/network/process behavior, dependency and deployment risk, and production failure modes. ${REVIEW_PROTOCOL}`;

export const FORGE_REVIEW_DOMAIN_PROMPT = `You are a domain-specialist member of a ForgeDock review panel. The task names your assigned domain. Inspect the frozen worktree/diff and surrounding code only through that domain: architecture/integration, API compatibility, data/migrations, performance/concurrency, frontend/accessibility, infrastructure/reliability, or test quality. Do not duplicate generic correctness/security findings unless the domain-specific impact is distinct. ${REVIEW_PROTOCOL}`;

export const FORGE_REFRESH_REVIEW_PROMPT = `You are the sole writer for a ForgeDock integration refresh. The implementation already completed and received a fresh review, but the configured integration base moved before serialized merge. First call forge_refresh_base. If the controlled rebase succeeds, run every required verification command through forge_verify, inspect the rebased patch through forge_diff, and launch the registered forge-review-correctness and forge-review-security agents together in one fresh-context runs.all workflow. Never reuse earlier findings as the new verdict. Do not call forge_checkpoint and do not repeat investigation, planning, or implementation. If rebase conflicts or verification/review cannot complete, return a schema-valid blocked or needs-human work-on result. Otherwise call forge_prepare_review to update the existing bound PR and freeze its new head, then call forge_finalize_work_on and structured_output with the identical complete ready-for-merge result. The final result must use the bound run ID, issue number, and new base SHA, and increment review.rounds from the previous result. Do not use raw shell, gh, direct push, merge, close, or paths outside the assigned worktree.`;

export const FORGE_WORK_ON_PROMPT = `You are the single-issue ForgeDock work-on agent and the only writer in your assigned worktree. Follow the typed run binding and repository instructions. Investigate before editing, keep changes inside the approved contract, and use only Forge-approved verification commands. Request durable phase transitions through forge_checkpoint; never infer that a transition succeeded.

Pi native agent-level retry is required for this work-on session and every nested reviewer. Transient provider/transport failures must retry without advancing the phase. Quota, billing, authentication, schema, authority, and deterministic tool failures are not transient retries.

You are authorized and required to remediate reviewer findings that stay inside the accepted builder contract and do not require a product, scope, UX, protected-branch, or security-authority decision. Apply those fixes as the sole writer, create a review-fixes commit, rerun applicable verification, refresh the PR head, and launch a fresh full reviewer panel up to the configured round cap.

At review, derive a per-PR reviewer roster from repository guidance, the contract, changed files/ranges, languages/frameworks, and data/auth/API/performance/deployment risk surfaces. Call forge_run_review_panel exactly once with the frozen head SHA, review round, and those specialist profiles. The trusted tool always includes required policy baseline reviewers, launches every selected profile in a fresh context, joins all results, validates their bindings, and returns the typed panel. Reviewers cannot recurse. Never launch reviewers manually or replace nested review with self-review.

Do not use raw shell, gh, git push, merge, issue/PR writes, or paths outside the assigned worktree. Use forge_diff, named forge_verify checks, forge_commit, forge_prepare_review, forge_checkpoint, and forge_finalize_work_on. An empty local verification allowlist is valid and means GitHub CI is parent-owned. Return only the required structured work-on result. The parent extension alone decides merge, close, labels, and cleanup.`;

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
      name: FORGE_REVIEW_DOMAIN_AGENT,
      definition: {
        description:
          "Fresh-context ForgeDock reviewer for a dynamically selected specialist domain",
        systemPrompt: FORGE_REVIEW_DOMAIN_PROMPT,
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
      name: FORGE_READ_ONLY_NODE_AGENT,
      definition: {
        description:
          "Execute a bounded ForgeDock node without requiring or permitting source edits",
        systemPrompt: FORGE_WORK_ON_PROMPT,
        systemPromptMode: "replace",
        inheritProjectContext: true,
        inheritSkills: false,
        defaultContext: "fresh",
        tools: [...FORGE_READ_ONLY_NODE_TOOLS],
        extensions: [childRuntimePath],
        acceptanceRole: "read-only",
        defaultAsync: true,
        defaultTimeoutMs: FORGE_WORK_ON_TIMEOUT_MS,
        maxSubagentDepth: 1,
        completionGuard: false,
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
