import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { FetchGitHubTransport } from "../adapters/github-api.ts";
import { loadForgePolicy } from "../adapters/config.ts";
import { GitWorktreeManager, type PreparedWorktree } from "../adapters/git.ts";
import { GitHubIssueProjector } from "../adapters/github-projection.ts";
import { GitHubStateBranchStore } from "../adapters/github-state.ts";
import { GitHubWorkflowAdapter } from "../adapters/github-workflow.ts";
import { SubagentsRpcClient } from "../adapters/subagents.ts";
import {
  findForgeWorkOnResult,
  type ForgeWorkOnResult,
} from "../core/work-on-contracts.ts";
import { isProtectedBranch, type ForgePolicy } from "../core/policy.ts";
import { materializeForgeAgents } from "../agents/materialize.ts";
import { RunJournal } from "./journal.ts";
import { ForgeWorkOnFinalizer } from "./finalization.ts";

const RUN_LINK_ENTRY = "forgedock-run-link/v1";

export interface ActiveRunLink {
  forgeRunId: string;
  subagentRunId: string;
  issueNumber: number;
  repository: string;
  stateBranch: string;
  resultPath: string;
  prepared: PreparedWorktree;
  status: "running" | "completed" | "failed";
}

export interface StartIssueResult {
  runId: string;
  subagentRunId: string;
  issueNumber: number;
  worktreePath: string;
  branch: string;
}

export class ForgeWorkOnController {
  readonly #pi: ExtensionAPI;
  readonly #rpc: SubagentsRpcClient;
  readonly #git: GitWorktreeManager;
  readonly #links = new Map<string, ActiveRunLink>();
  #completionUnsubscribe: (() => void) | undefined;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
    this.#rpc = new SubagentsRpcClient(pi);
    this.#git = new GitWorktreeManager({
      exec: (command, args, options) => pi.exec(command, [...args], options),
    });
  }

  async attach(ctx: ExtensionContext): Promise<void> {
    this.#restoreLinks(ctx);
    await this.#rpc.ping();
    this.#completionUnsubscribe?.();
    this.#completionUnsubscribe = this.#rpc.onAsyncComplete((payload) => {
      const link = [...this.#links.values()].find((candidate) =>
        containsString(payload, candidate.subagentRunId),
      );
      if (!link || link.status !== "running") return;
      void this.#finalize(link, ctx).catch((error) => {
        link.status = "failed";
        this.#persistLink(link);
        ctx.ui.notify(
          `ForgeDock run ${link.forgeRunId} finalization failed: ${errorMessage(error)}`,
          "error",
        );
      });
    });
  }

  dispose(): void {
    this.#completionUnsubscribe?.();
    this.#completionUnsubscribe = undefined;
  }

  async startIssue(
    issueNumber: number,
    ctx: ExtensionCommandContext,
  ): Promise<StartIssueResult> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
      throw new TypeError("Issue number must be positive.");
    const repositoryRoot = await this.#git.resolveRepositoryRoot(
      ctx.cwd,
      ctx.signal,
    );
    const { policy } = await loadForgePolicy(repositoryRoot);
    const integrationBranch = chooseIntegrationBranch(policy);
    if (isProtectedBranch(policy, integrationBranch))
      throw new Error(`Integration branch ${integrationBranch} is protected.`);
    const token = await resolveGitHubToken(
      this.#pi,
      repositoryRoot,
      ctx.signal,
    );
    const transport = new FetchGitHubTransport({ token });
    const github = new GitHubWorkflowAdapter(transport, policy.repository.name);
    const issue = await github.getIssue(issueNumber, ctx.signal);
    if (issue.state !== "open")
      throw new Error(`Issue #${issueNumber} is not open.`);

    const runId = randomUUID();
    const store = new GitHubStateBranchStore(
      transport,
      policy.repository.name,
      policy.state.branch,
    );
    await store.ensureBranch(new Date(), ctx.signal);
    const preflight = await store.readRun(runId, ctx.signal);
    if (preflight.lease) {
      throw new Error(
        `Repository is already leased by run ${preflight.lease.ownerRunId}; takeover must be explicit.`,
      );
    }

    const prepared = await this.#git.prepare(repositoryRoot, {
      runId,
      issueNumber,
      baseBranch: integrationBranch,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    try {
      await materializeForgeAgents(prepared.worktreePath);
      const journal = new RunJournal(store);
      const initialized = await journal.initialize({
        runId,
        repository: policy.repository.name,
        issueNumber,
        integrationBranch,
        protectedBranch: policy.branches.protected[0] ?? "main",
        sessionId: ctx.sessionManager.getSessionId(),
        leaseSeconds: policy.state.leaseSeconds,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const projector = new GitHubIssueProjector(
        transport,
        policy.repository.name,
      );
      const createdEvent = initialized.events[0];
      if (!createdEvent)
        throw new Error("Run initialization did not produce a genesis event.");
      await projector.projectEvent({
        issueNumber,
        event: createdEvent,
        markdown: `## ForgeDock Pi run started\n\nRun: \`${runId}\`\nIntegration base: \`${integrationBranch}\`\nWork is isolated and review will run through nested Pi subagents.`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      await projector.setWorkflowLabel(
        issueNumber,
        "workflow:investigating",
        ctx.signal,
      );

      const receipt = await this.#rpc.spawnWorkOn({
        runId,
        issueNumber,
        repository: policy.repository.name,
        worktreeRoot: prepared.worktreePath,
        branch: prepared.branch,
        baseBranch: prepared.baseBranch,
        baseSha: prepared.baseSha,
        leaseEpoch: initialized.lease?.epoch ?? 1,
        policy,
        issueContext: JSON.stringify(
          { title: issue.title, body: issue.body, labels: issue.labels },
          null,
          2,
        ),
      });
      const link: ActiveRunLink = {
        forgeRunId: runId,
        subagentRunId: receipt.runId,
        issueNumber,
        repository: policy.repository.name,
        stateBranch: policy.state.branch,
        resultPath: receipt.resultPath,
        prepared,
        status: "running",
      };
      this.#links.set(receipt.runId, link);
      this.#persistLink(link);
      ctx.ui.setStatus("forgedock", `issue #${issueNumber} · work-on running`);
      return {
        runId,
        subagentRunId: receipt.runId,
        issueNumber,
        worktreePath: prepared.worktreePath,
        branch: prepared.branch,
      };
    } catch (error) {
      await this.#git.cleanup(prepared, ctx.signal).catch(() => undefined);
      throw error;
    }
  }

  listRuns(): ActiveRunLink[] {
    return [...this.#links.values()].map((link) => ({
      ...link,
      prepared: { ...link.prepared },
    }));
  }

  async #finalize(link: ActiveRunLink, ctx: ExtensionContext): Promise<void> {
    const statusPayload = await this.#rpc.status(link.subagentRunId);
    let result = findForgeWorkOnResult(statusPayload);
    if (!result) {
      const resultText = await readFile(link.resultPath, "utf8").catch(
        () => "",
      );
      result =
        findForgeWorkOnResult(resultText) ??
        findForgeWorkOnResult(extractJsonObject(resultText));
    }
    if (!result)
      throw new Error(
        "Completed work-on subagent did not return a schema-valid Forge result artifact.",
      );
    assertResultIdentity(result, link);
    if (result.status !== "ready-for-merge") {
      link.status = "failed";
      this.#persistLink(link);
      ctx.ui.notify(
        `ForgeDock issue #${link.issueNumber} stopped: ${result.blocker ?? result.status}`,
        "warning",
      );
      return;
    }

    const { policy } = await loadForgePolicy(link.prepared.repositoryRoot);
    const token = await resolveGitHubToken(
      this.#pi,
      link.prepared.repositoryRoot,
      ctx.signal,
    );
    const outcome = await new ForgeWorkOnFinalizer(this.#git).run({
      link,
      result,
      policy,
      token,
      sessionId: ctx.sessionManager.getSessionId(),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (outcome.status === "blocked") {
      link.status = "failed";
      this.#persistLink(link);
      ctx.ui.notify(
        `ForgeDock PR #${outcome.pullNumber} not merged: ${outcome.reasons.join(" ")}`,
        "warning",
      );
      return;
    }

    link.status = "completed";
    this.#persistLink(link);
    ctx.ui.setStatus("forgedock", undefined);
    ctx.ui.notify(
      `ForgeDock issue #${link.issueNumber} merged through PR #${outcome.pullNumber}.`,
      "info",
    );
  }

  #restoreLinks(ctx: ExtensionContext): void {
    this.#links.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== RUN_LINK_ENTRY)
        continue;
      if (isActiveRunLink(entry.data))
        this.#links.set(entry.data.subagentRunId, entry.data);
    }
  }

  #persistLink(link: ActiveRunLink): void {
    this.#pi.appendEntry(RUN_LINK_ENTRY, link);
    this.#links.set(link.subagentRunId, link);
  }
}

function chooseIntegrationBranch(policy: ForgePolicy): string {
  const branch = policy.branches.integration.find(
    (candidate) => !candidate.includes("*"),
  );
  if (!branch)
    throw new Error(
      "The first milestone requires one literal integration branch in .forge/config.json.",
    );
  return branch;
}

async function resolveGitHubToken(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await pi.exec("gh", ["auth", "token"], {
    cwd,
    timeout: 10_000,
    ...(signal ? { signal } : {}),
  });
  const token = result.stdout.trim();
  if (result.code !== 0 || !token)
    throw new Error("GitHub CLI authentication is required.");
  return token;
}

function assertResultIdentity(
  result: ForgeWorkOnResult,
  link: ActiveRunLink,
): void {
  if (
    result.runId !== link.forgeRunId ||
    result.issueNumber !== link.issueNumber
  )
    throw new Error("Work-on result run/issue identity mismatch.");
  if (
    result.branch !== link.prepared.branch ||
    result.baseSha !== link.prepared.baseSha
  )
    throw new Error("Work-on result branch/base identity mismatch.");
}

function containsString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value))
    return value.some((entry) => containsString(entry, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((entry) =>
    containsString(entry, expected),
  );
}

function isActiveRunLink(value: unknown): value is ActiveRunLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const link = value as Partial<ActiveRunLink>;
  return (
    typeof link.forgeRunId === "string" &&
    typeof link.subagentRunId === "string" &&
    Number.isSafeInteger(link.issueNumber) &&
    typeof link.repository === "string" &&
    typeof link.stateBranch === "string" &&
    typeof link.resultPath === "string" &&
    (link.status === "running" ||
      link.status === "completed" ||
      link.status === "failed") &&
    Boolean(link.prepared && typeof link.prepared === "object")
  );
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
