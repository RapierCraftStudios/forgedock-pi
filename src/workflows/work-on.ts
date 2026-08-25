import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  ExtensionAPI,
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
  type ForgeReviewFindingResult,
  type ForgeReviewerResult,
  type ForgeWorkOnResult,
} from "../agents/contracts.ts";
import { materializeForgeAgents } from "../agents/materialize.ts";
import { checkPreMergeAuditTrail } from "../core/artifact-protocol.ts";
import {
  canAutoMerge,
  isGitHubCiRequired,
  isProtectedBranch,
  type ForgePolicy,
} from "../core/policy.ts";
import {
  evaluateReviewGate,
  findingBlocksMerge,
  type ReviewFinding,
  type VerificationResult,
} from "../core/review.ts";
import { RunJournal } from "./journal.ts";

const RUN_LINK_ENTRY = "forgedock-run-link/v1";

export type ActiveRunStatus =
  | "running"
  | "ready"
  | "refreshing"
  | "finalizing"
  | "completed"
  | "blocked"
  | "needs-human"
  | "failed";

export interface ActiveRunLink {
  forgeRunId: string;
  subagentRunId: string;
  issueNumber: number;
  repository: string;
  stateBranch: string;
  resultPath: string;
  prepared: PreparedWorktree;
  status: ActiveRunStatus;
  orchestrationId?: string;
  leaseOwnerRunId: string;
  leaseEpoch: number;
  reviewBaseSha: string;
  refreshes: number;
  providerRetries: number;
  remediationAttempts: number;
  findingIssueMap: Record<string, number>;
}

export interface WorkOnLifecycleEvent {
  forgeRunId: string;
  issueNumber: number;
  status: ActiveRunStatus;
  orchestrationId?: string;
  subagentRunId: string;
  headSha?: string;
  baseSha?: string;
  reason?: string;
  pullNumber?: number;
}

export interface StartIssueResult {
  runId: string;
  subagentRunId: string;
  issueNumber: number;
  worktreePath: string;
  branch: string;
}

export interface StartIssueOptions {
  orchestrationId?: string;
  leaseEpoch?: number;
}

export class ForgeWorkOnController {
  readonly #pi: ExtensionAPI;
  readonly #rpc: SubagentsRpcClient;
  readonly #git: GitWorktreeManager;
  readonly #links = new Map<string, ActiveRunLink>();
  readonly #lifecycleListeners = new Set<
    (event: WorkOnLifecycleEvent) => void
  >();
  readonly #providerRecovering = new Set<string>();
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
    for (const repositoryRoot of new Set(
      [...this.#links.values()].map((link) => link.prepared.repositoryRoot),
    ))
      await this.#git.ensureRuntimeIgnored(repositoryRoot);
    await this.#rpc.ping();
    this.#completionUnsubscribe?.();
    this.#completionUnsubscribe = this.#rpc.onAsyncComplete((payload) => {
      const completion = parseAsyncCompletion(payload);
      if (!completion) return;
      const link = this.#links.get(completion.runId);
      if (
        !link ||
        (link.status !== "running" && link.status !== "refreshing")
      )
        return;
      if (completion.state === "paused" || completion.state === "running")
        return;
      if (
        completion.state === "failed" ||
        completion.state === "stopped"
      ) {
        const failure = completion.error ?? `Subagent ${completion.state}.`;
        if (
          completion.state === "failed" &&
          /unsupported-continuation/i.test(failure)
        ) {
          link.status = "finalizing";
          this.#persistLink(link);
          void this.#finalize(link, ctx).catch((error) => {
            link.status = "failed";
            this.#persistLink(link);
            this.#emitLifecycle(link, { reason: errorMessage(error) });
          });
          return;
        }
        if (
          completion.state === "failed" &&
          isTransientProviderFailure(failure) &&
          link.providerRetries < 3
        ) {
          void this.#retryProviderFailure(link, ctx, failure);
          return;
        }
        link.status = "failed";
        this.#persistLink(link);
        this.#emitLifecycle(link, { reason: failure });
        return;
      }
      link.status = "finalizing";
      this.#persistLink(link);
      void this.#finalize(link, ctx).catch((error) => {
        link.status = "failed";
        this.#persistLink(link);
        this.#emitLifecycle(link, { reason: errorMessage(error) });
        ctx.ui.notify(
          `ForgeDock run ${link.forgeRunId} finalization failed: ${errorMessage(error)}`,
          "error",
        );
      });
    });
    for (const link of this.#links.values()) {
      if (link.status !== "running" && link.status !== "refreshing") continue;
      try {
        const payload = await this.#rpc.status(link.subagentRunId);
        if (!findForgeWorkOnResult(payload)) continue;
        link.status = "finalizing";
        this.#persistLink(link);
        await this.#finalize(link, ctx);
      } catch (error) {
        if (link.status === "running" || link.status === "refreshing")
          continue;
        link.status = "failed";
        this.#persistLink(link);
        this.#emitLifecycle(link, { reason: errorMessage(error) });
      }
    }
  }

  dispose(): void {
    this.#completionUnsubscribe?.();
    this.#completionUnsubscribe = undefined;
    this.#lifecycleListeners.clear();
    this.#providerRecovering.clear();
  }

  async #retryProviderFailure(
    link: ActiveRunLink,
    ctx: ExtensionContext,
    failure: string,
  ): Promise<void> {
    if (this.#providerRecovering.has(link.forgeRunId)) return;
    this.#providerRecovering.add(link.forgeRunId);
    const previousRunId = link.subagentRunId;
    try {
      const receipt = await this.#rpc.resume(
        previousRunId,
        `Resume the same ForgeDock run from its durable checkpoints after a transient provider transport failure. Do not repeat completed phases. Failure: ${failure}`,
      );
      this.#links.delete(previousRunId);
      link.subagentRunId = receipt.runId;
      link.providerRetries += 1;
      link.status = "running";
      this.#persistLink(link);
      ctx.ui.notify(
        `ForgeDock issue #${link.issueNumber} resumed after transient provider failure (${link.providerRetries}/3).`,
        "warning",
      );
    } catch (error) {
      link.status = "failed";
      this.#persistLink(link);
      this.#emitLifecycle(link, {
        reason: `Transient provider retry failed: ${errorMessage(error)}`,
      });
    } finally {
      this.#providerRecovering.delete(link.forgeRunId);
    }
  }

  async startIssue(
    issueNumber: number,
    ctx: ExtensionContext,
    options: StartIssueOptions = {},
  ): Promise<StartIssueResult> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
      throw new TypeError("Issue number must be positive.");
    const repositoryRoot = await this.#git.resolveRepositoryRoot(
      ctx.cwd,
      ctx.signal,
    );
    await this.#git.ensureRuntimeIgnored(repositoryRoot, ctx.signal);
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
    if (
      preflight.lease &&
      (!options.orchestrationId ||
        preflight.lease.ownerRunId !== options.orchestrationId ||
        preflight.lease.epoch !== options.leaseEpoch)
    ) {
      throw new Error(
        `Repository is already leased by run ${preflight.lease.ownerRunId}; takeover must be explicit.`,
      );
    }
    if (options.orchestrationId && !preflight.lease)
      throw new Error(
        `Orchestration ${options.orchestrationId} does not own an active repository lease.`,
      );

    const prepared = await this.#git.prepare(repositoryRoot, {
      runId,
      issueNumber,
      baseBranch: integrationBranch,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    try {
      await materializeForgeAgents(prepared.worktreePath);
      const journal = new RunJournal(store);
      if (
        options.orchestrationId &&
        (!Number.isSafeInteger(options.leaseEpoch) ||
          (options.leaseEpoch ?? 0) < 1)
      )
        throw new Error(
          "Orchestrated work-on requires a positive repository lease epoch.",
        );
      const initialized = await journal.initialize({
        runId,
        repository: policy.repository.name,
        issueNumber,
        integrationBranch,
        protectedBranch: policy.branches.protected[0] ?? "main",
        sessionId: ctx.sessionManager.getSessionId(),
        leaseSeconds: policy.state.leaseSeconds,
        ...(options.orchestrationId
          ? {
              orchestration: {
                ownerRunId: options.orchestrationId,
                epoch: options.leaseEpoch as number,
              },
            }
          : {}),
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
        leaseEpoch:
          initialized.lease?.epoch ?? options.leaseEpoch ?? 1,
        leaseOwnerRunId: options.orchestrationId ?? runId,
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
        ...(options.orchestrationId
          ? { orchestrationId: options.orchestrationId }
          : {}),
        leaseOwnerRunId: options.orchestrationId ?? runId,
        leaseEpoch:
          initialized.lease?.epoch ?? options.leaseEpoch ?? 1,
        reviewBaseSha: prepared.baseSha,
        refreshes: 0,
        providerRetries: 0,
        remediationAttempts: 0,
        findingIssueMap: {},
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

  async reactivateOrchestrationIssue(
    orchestrationId: string,
    issueNumber: number,
  ): Promise<
    | {
        forgeRunId: string;
        subagentRunId: string;
        state: "running" | "paused" | "complete";
      }
    | undefined
  > {
    const link = [...this.#links.values()].find(
      (candidate) =>
        candidate.orchestrationId === orchestrationId &&
        candidate.issueNumber === issueNumber,
    );
    if (!link) return undefined;
    const payload = await this.#rpc.status(link.subagentRunId);
    const completion = findAsyncCompletionForRun(
      payload,
      link.subagentRunId,
    );
    if (
      completion?.state === "failed" &&
      completion.error &&
      isTransientProviderFailure(completion.error) &&
      link.providerRetries < 3
    ) {
      const previousRunId = link.subagentRunId;
      const receipt = await this.#rpc.resume(
        previousRunId,
        `Resume the same ForgeDock run from durable checkpoints after terminal transient failure. Do not repeat completed phases. Failure: ${completion.error}`,
      );
      this.#links.delete(previousRunId);
      link.subagentRunId = receipt.runId;
      link.providerRetries += 1;
      link.status = "running";
      this.#persistLink(link);
      return {
        forgeRunId: link.forgeRunId,
        subagentRunId: link.subagentRunId,
        state: "running",
      };
    }
    if (completion?.state === "complete") {
      const resultText = await readFile(link.resultPath, "utf8").catch(
        () => "",
      );
      const result = findForgeWorkOnResult(resultText);
      if (
        result?.blocker &&
        /No comment found for marker.*FORGE:BUILDER/i.test(result.blocker)
      ) {
        const previousRunId = link.subagentRunId;
        const receipt = await this.#rpc.resume(
          previousRunId,
          "Resume the same ForgeDock run after a fixed idempotent projection defect. Retry verify complete attempt 1 exactly once; the authoritative phase event and implementation commit already exist. Then continue review preparation and nested review without repeating completed phases.",
        );
        this.#links.delete(previousRunId);
        link.subagentRunId = receipt.runId;
        link.status = "running";
        this.#persistLink(link);
        return {
          forgeRunId: link.forgeRunId,
          subagentRunId: link.subagentRunId,
          state: "running",
        };
      }
    }
    let recoverableState:
      | "running"
      | "paused"
      | "complete"
      | undefined =
      completion?.state === "running" ||
      completion?.state === "paused" ||
      completion?.state === "complete"
        ? completion.state
        : undefined;
    if (
      !recoverableState &&
      completion?.state === "failed" &&
      completion.error &&
      /unsupported-continuation/i.test(completion.error)
    ) {
      const resultText = await readFile(link.resultPath, "utf8").catch(
        () => "",
      );
      if (findForgeWorkOnResult(resultText)) recoverableState = "complete";
    }
    if (!recoverableState) return undefined;
    link.status = "running";
    this.#persistLink(link);
    return {
      forgeRunId: link.forgeRunId,
      subagentRunId: link.subagentRunId,
      state: recoverableState,
    };
  }

  async reconcileRun(
    forgeRunId: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const link = [...this.#links.values()].find(
      (candidate) => candidate.forgeRunId === forgeRunId,
    );
    if (!link || link.status !== "running") return;
    const result = await this.#loadResult(link).catch(() => undefined);
    if (!result) return;
    link.status = "finalizing";
    this.#persistLink(link);
    await this.#finalize(link, ctx, result);
  }

  async stopOrchestration(orchestrationId: string): Promise<void> {
    const active = [...this.#links.values()].filter(
      (link) =>
        link.orchestrationId === orchestrationId &&
        ["running", "refreshing", "finalizing"].includes(link.status),
    );
    await Promise.allSettled(
      active.map(async (link) => {
        link.status = "failed";
        this.#persistLink(link);
        await this.#rpc.stop(link.subagentRunId);
      }),
    );
  }

  onLifecycle(
    listener: (event: WorkOnLifecycleEvent) => void,
  ): () => void {
    this.#lifecycleListeners.add(listener);
    return () => this.#lifecycleListeners.delete(listener);
  }

  async integrateIssue(
    forgeRunId: string,
    ctx: ExtensionContext,
  ): Promise<WorkOnLifecycleEvent> {
    const link = [...this.#links.values()].find(
      (candidate) => candidate.forgeRunId === forgeRunId,
    );
    if (!link) throw new Error(`Unknown ForgeDock run ${forgeRunId}.`);
    if (!link.orchestrationId)
      throw new Error(`Run ${forgeRunId} is not orchestration-owned.`);
    if (link.status !== "ready")
      throw new Error(
        `Run ${forgeRunId} is ${link.status}; expected ready for integration.`,
      );
    const result = await this.#loadResult(link);
    assertResultIdentity(result, link);
    const { policy } = await loadForgePolicy(link.prepared.repositoryRoot);
    const currentBaseSha = await this.#git.remoteBaseSha(
      link.prepared.repositoryRoot,
      link.prepared.baseBranch,
      ctx.signal,
    );
    if (currentBaseSha !== result.baseSha) {
      if (result.review.rounds >= policy.review.maxRounds) {
        link.status = "needs-human";
        this.#persistLink(link);
        return this.#emitLifecycle(link, {
          reason: `Integration base moved to ${currentBaseSha}, but the maximum ${policy.review.maxRounds} review rounds is exhausted.`,
        });
      }
      const receipt = await this.#rpc.spawnRefreshReview({
        runId: link.forgeRunId,
        issueNumber: link.issueNumber,
        repository: link.repository,
        worktreeRoot: link.prepared.worktreePath,
        branch: link.prepared.branch,
        baseBranch: link.prepared.baseBranch,
        baseSha: currentBaseSha,
        leaseEpoch: link.leaseEpoch,
        leaseOwnerRunId: link.leaseOwnerRunId,
        policy,
        issueContext: "",
        previousResult: result,
        refreshAttempt: link.refreshes + 1,
      });
      this.#links.delete(link.subagentRunId);
      link.subagentRunId = receipt.runId;
      link.resultPath = receipt.resultPath;
      link.reviewBaseSha = currentBaseSha;
      link.refreshes += 1;
      link.status = "refreshing";
      this.#persistLink(link);
      return this.#emitLifecycle(link, { baseSha: currentBaseSha });
    }
    link.status = "finalizing";
    this.#persistLink(link);
    await this.#finalize(link, ctx, result, true);
    return this.#lifecycleEvent(link);
  }

  async #loadResult(link: ActiveRunLink): Promise<ForgeWorkOnResult> {
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
    return result;
  }

  async #attemptRemediation(input: {
    link: ActiveRunLink;
    result: ForgeWorkOnResult;
    pullNumber: number;
    findingIssueMap: Record<string, number>;
    github: GitHubWorkflowAdapter;
    projector: GitHubIssueProjector;
    ctx: ExtensionContext;
  }): Promise<boolean> {
    const fixable = input.result.review.findings.filter(
      (finding) =>
        finding.confidence === "confirmed" || finding.confidence === "likely",
    );
    if (
      fixable.length === 0 ||
      input.link.remediationAttempts >= 1 ||
      input.result.review.rounds >= 5
    )
      return false;
    const findingLines = fixable.map((finding) => {
      const issueNumber = input.findingIssueMap[finding.id];
      return `- #${issueNumber ?? "?"} ${finding.id}: ${finding.summary} (${finding.file}:${finding.line})`;
    });
    const remediationBody = `<!-- FORGE:REMEDIATION -->\n## Remediation In Progress for PR #${input.pullNumber}\n\n**Run**: \`${input.link.forgeRunId}\`\n**Reviewed head**: \`${input.result.review.headSha}\`\n**Fixable findings**:\n${findingLines.join("\n")}\n\nA single bounded remediation attempt is authorized. Fresh full review is mandatory.`;
    await input.github.postPullArtifact({
      pullNumber: input.pullNumber,
      marker: `<!-- FORGE:REMEDIATION run=${input.link.forgeRunId} attempt=1 -->`,
      body: remediationBody,
      ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
    });
    await input.projector.postArtifact({
      issueNumber: input.link.issueNumber,
      runId: input.link.forgeRunId,
      eventId: `remediation-${input.result.review.headSha}`,
      artifactKey: "remediation-started",
      markdown: remediationBody,
      ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
    });
    const previousRunId = input.link.subagentRunId;
    const receipt = await this.#rpc.resume(
      previousRunId,
      [
        "Run one legacy-compatible bounded remediation attempt on the existing PR branch.",
        `PR: #${input.pullNumber}`,
        `Issue: #${input.link.issueNumber}`,
        `Prior reviewed head: ${input.result.review.headSha}`,
        "Read the standalone review-finding issues listed below. Apply every confirmed/likely fix that is inside the accepted builder contract; escalate only product/policy/out-of-contract decisions.",
        ...findingLines,
        "Commit with forge_commit kind review-fixes, rerun applicable verification, call forge_prepare_review to update the same PR, and launch a fresh complete correctness/security panel.",
        `Return a schema-valid work-on result with review.rounds=${input.result.review.rounds + 1}, persist it through forge_finalize_work_on, and do not repeat investigation or planning.`,
      ].join("\n"),
    );
    this.#links.delete(previousRunId);
    input.link.subagentRunId = receipt.runId;
    input.link.remediationAttempts += 1;
    input.link.status = "running";
    this.#persistLink(input.link);
    input.ctx.ui.notify(
      `ForgeDock issue #${input.link.issueNumber} started bounded remediation of PR #${input.pullNumber}.`,
      "info",
    );
    return true;
  }

  async #finalize(
    link: ActiveRunLink,
    ctx: ExtensionContext,
    suppliedResult?: ForgeWorkOnResult,
    integrate = false,
  ): Promise<void> {
    const result = suppliedResult ?? (await this.#loadResult(link));
    assertResultIdentity(result, link);
    const { policy } = await loadForgePolicy(link.prepared.repositoryRoot);
    const token = await resolveGitHubToken(
      this.#pi,
      link.prepared.repositoryRoot,
      ctx.signal,
    );
    const transport = new FetchGitHubTransport({ token });
    const github = new GitHubWorkflowAdapter(transport, link.repository);
    const projector = new GitHubIssueProjector(transport, link.repository);
    const existingPull = await github.findPullRequest(
      link.prepared.branch,
      ctx.signal,
    );
    if (result.review.findings.length > 0 && !existingPull)
      throw new Error(
        "Structured review findings exist without the bound pull request.",
      );
    const priorFindingIssueMap = { ...link.findingIssueMap };
    const findingIssueMap = existingPull
      ? await publishReviewFindingIssues({
          github,
          pullNumber: existingPull.number,
          link,
          result,
          signal: ctx.signal,
        })
      : {};
    link.findingIssueMap = findingIssueMap;
    if (link.remediationAttempts > 0 && existingPull) {
      const activeFindingIds = new Set(
        result.review.findings.map((finding) => finding.id),
      );
      for (const [findingId, issueNumber] of Object.entries(
        priorFindingIssueMap,
      )) {
        if (activeFindingIds.has(findingId)) continue;
        await github.commentOnIssue(
          issueNumber,
          `Fixed by remediation of PR #${existingPull.number} at reviewed head \`${result.review.headSha}\`.`,
          ctx.signal,
        );
        await github.closeIssue(issueNumber, ctx.signal);
      }
      await postRemediationArtifact({
        github,
        projector,
        pullNumber: existingPull.number,
        link,
        result,
        findingIssueMap,
        signal: ctx.signal,
      });
    }
    this.#persistLink(link);
    if (
      result.status !== "ready-for-merge" &&
      existingPull &&
      (await this.#attemptRemediation({
        link,
        result,
        pullNumber: existingPull.number,
        findingIssueMap,
        github,
        projector,
        ctx,
      }))
    )
      return;
    if (result.status !== "ready-for-merge") {
      link.status =
        result.status === "needs-human" ? "needs-human" : "blocked";
      this.#persistLink(link);
      this.#emitLifecycle(link, {
        reason: result.blocker ?? result.status,
        headSha: result.headSha,
        baseSha: result.baseSha,
      });
      ctx.ui.notify(
        `ForgeDock issue #${link.issueNumber} stopped: ${result.blocker ?? result.status}`,
        "warning",
      );
      return;
    }
    if (link.orchestrationId && !integrate) {
      link.status = "ready";
      link.reviewBaseSha = result.baseSha;
      this.#persistLink(link);
      this.#emitLifecycle(link, {
        headSha: result.headSha,
        baseSha: result.baseSha,
      });
      return;
    }

    const store = new GitHubStateBranchStore(
      transport,
      link.repository,
      link.stateBranch,
    );
    const journal = new RunJournal(store);
    const sessionId = ctx.sessionManager.getSessionId();

    await this.#git.assertClean(link.prepared.worktreePath, ctx.signal);
    const actualHead = await this.#git.head(
      link.prepared.worktreePath,
      ctx.signal,
    );
    if (actualHead !== result.headSha || result.review.headSha !== actualHead) {
      throw new Error(
        `Work-on/review SHA mismatch: git=${actualHead} result=${result.headSha} review=${result.review.headSha}.`,
      );
    }
    const actualFiles = await this.#git.changedFiles(
      link.prepared.worktreePath,
      result.baseSha,
      ctx.signal,
    );
    if (!sameStrings(actualFiles, result.changedFiles))
      throw new Error(
        "Work-on changed-file result does not match the actual committed diff.",
      );

    await appendPhase(
      journal,
      link.forgeRunId,
      "merge",
      "queue",
      1,
      sessionId,
      ctx.signal,
    );
    await appendPhase(
      journal,
      link.forgeRunId,
      "merge",
      "start",
      1,
      sessionId,
      ctx.signal,
    );
    await this.#git.push(
      link.prepared.worktreePath,
      link.prepared.branch,
      ctx.signal,
    );
    await appendEffect(
      journal,
      link.forgeRunId,
      "push",
      `branch:${link.prepared.branch}`,
      digest(actualHead),
      sessionId,
      ctx.signal,
    );

    const issue = await github.getIssue(link.issueNumber, ctx.signal);
    const pull = await github.createPullRequest({
      title: issue.title,
      body: buildPullBody(link, result),
      head: link.prepared.branch,
      base: link.prepared.baseBranch,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    await appendEffect(
      journal,
      link.forgeRunId,
      "pull-request",
      `pr:${pull.number}`,
      digest(pull.htmlUrl),
      sessionId,
      ctx.signal,
    );
    const currentPull = await resolveMergeability(
      github,
      pull.number,
      ctx.signal,
    );
    await publishReviewArtifacts(
      github,
      currentPull.number,
      result,
      link.findingIssueMap,
      ctx.signal,
    );
    const issueComments = await github.getComments(
      link.issueNumber,
      ctx.signal,
    );
    const pullComments = await github.getComments(
      currentPull.number,
      ctx.signal,
    );
    const audit = checkPreMergeAuditTrail({
      issueComments,
      pullRequestComments: pullComments,
      requiredReviewerDomains: policy.review.required.map(reviewerDomain),
    });
    let auditFailures = [
      ...audit.missingIssueMarkers.map(
        (marker) => `missing issue artifact ${marker}`,
      ),
      ...audit.missingPullRequestMarkers.map(
        (marker) => `missing PR artifact ${marker}`,
      ),
      ...audit.missingReviewerDomains.map(
        (domain) => `missing reviewer artifact ${domain}`,
      ),
    ];
    const currentRun = await store.readRun(link.forgeRunId, ctx.signal);
    const githubCiRequired = isGitHubCiRequired(
      policy,
      currentPull.baseRef,
    );
    const githubCi = githubCiRequired
      ? await github.waitForPullRequestChecks({
          headSha: result.review.headSha,
          baseBranch: currentPull.baseRef,
          timeoutMs: policy.verification.github.waitTimeoutMs,
          pollIntervalMs: policy.verification.github.pollIntervalMs,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      : {
          checks: [],
          headSha: result.review.headSha,
          requiredContexts: [],
          configuredWorkflowCount: 0,
          timedOut: false,
        };
    const checks: VerificationResult[] = githubCi.checks.map((check) => ({
      name: check.name,
      required: check.required,
      status: check.status,
    }));
    if (checks.every((check) => check.status === "passed")) {
      const ciEvidence = checks.length
        ? checks.map((check) => `- ${check.name}: ${check.status}`).join("\n")
        : "- No GitHub checks apply to this PR/base branch.";
      await projector.postArtifact({
        issueNumber: link.issueNumber,
        runId: link.forgeRunId,
        eventId: `github-ci-${result.review.headSha}`,
        artifactKey: "acceptance-gate",
        markdown: `<!-- FORGE:ACCEPTANCE_GATE -->\n## Acceptance Gate — PASSED\n\n**Reviewed head**: \`${result.review.headSha}\`\n**Authority**: ${githubCiRequired ? "GitHub-configured CI and required status checks" : `branch policy exempts PRs targeting ${currentPull.baseRef} from CI merge blocking`}\n\n### Checks\n\n${ciEvidence}\n\n<!-- FORGE:ACCEPTANCE_GATE:PASSED -->`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const refreshedAudit = checkPreMergeAuditTrail({
        issueComments: await github.getComments(link.issueNumber, ctx.signal),
        pullRequestComments: await github.getComments(
          currentPull.number,
          ctx.signal,
        ),
        requiredReviewerDomains: policy.review.required.map(reviewerDomain),
      });
      auditFailures = [
        ...refreshedAudit.missingIssueMarkers.map(
          (marker) => `missing issue artifact ${marker}`,
        ),
        ...refreshedAudit.missingPullRequestMarkers.map(
          (marker) => `missing PR artifact ${marker}`,
        ),
        ...refreshedAudit.missingReviewerDomains.map(
          (domain) => `missing reviewer artifact ${domain}`,
        ),
      ];
    }
    const findings = result.review.findings as readonly ReviewFinding[];
    const gate = evaluateReviewGate({
      identity: {
        repository: link.repository,
        runId: link.forgeRunId,
        pullRequest: currentPull.number,
        headSha: result.review.headSha,
        baseSha: result.baseSha,
        rosterVersion: "forgedock.review-roster/v1",
      },
      currentHeadSha: currentPull.headSha,
      currentBaseSha: currentPull.baseSha,
      requiredReviewers: policy.review.required,
      completedReviewers: result.review.completedReviewers,
      findings,
      checks,
      mergeability: currentPull.mergeability,
      leaseValid:
        currentRun.lease?.ownerRunId === link.leaseOwnerRunId &&
        currentRun.lease?.epoch === link.leaseEpoch,
      baseBranch: currentPull.baseRef,
      protectedBranches: policy.branches.protected,
      autoMergeAuthorized: canAutoMerge(policy, currentPull.baseRef),
      malformedResults: auditFailures,
    });

    if (gate.decision !== "approved") {
      const action = gate.decision === "needs-human" ? "needs-human" : "block";
      await appendPhase(
        journal,
        link.forgeRunId,
        "merge",
        action,
        1,
        sessionId,
        ctx.signal,
        gate.reasons.join(" "),
      );
      link.status =
        gate.decision === "needs-human" ? "needs-human" : "blocked";
      this.#persistLink(link);
      this.#emitLifecycle(link, {
        reason: gate.reasons.join(" "),
        headSha: result.headSha,
        baseSha: result.baseSha,
        pullNumber: pull.number,
      });
      ctx.ui.notify(
        `ForgeDock PR #${pull.number} not merged: ${gate.reasons.join(" ")}`,
        "warning",
      );
      return;
    }

    const merged = await github.mergePullRequest({
      pullNumber: pull.number,
      expectedHeadSha: result.review.headSha,
      method: "squash",
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    await appendEffect(
      journal,
      link.forgeRunId,
      "merge",
      `pr:${pull.number}:merge`,
      digest(merged.sha),
      sessionId,
      ctx.signal,
    );
    await appendPhase(
      journal,
      link.forgeRunId,
      "merge",
      "complete",
      1,
      sessionId,
      ctx.signal,
      undefined,
      [merged.sha],
    );
    await postReviewCompletionArtifacts({
      github,
      projector,
      link,
      result,
      pullNumber: pull.number,
      mergedSha: merged.sha,
      signal: ctx.signal,
    });

    await appendPhase(
      journal,
      link.forgeRunId,
      "close",
      "queue",
      1,
      sessionId,
      ctx.signal,
    );
    await appendPhase(
      journal,
      link.forgeRunId,
      "close",
      "start",
      1,
      sessionId,
      ctx.signal,
    );
    await github.closeIssue(link.issueNumber, ctx.signal);
    await appendEffect(
      journal,
      link.forgeRunId,
      "issue-close",
      `issue:${link.issueNumber}:close`,
      digest(merged.sha),
      sessionId,
      ctx.signal,
    );
    await appendPhase(
      journal,
      link.forgeRunId,
      "close",
      "complete",
      1,
      sessionId,
      ctx.signal,
      undefined,
      ["issue close read-back passed"],
    );

    await appendPhase(
      journal,
      link.forgeRunId,
      "cleanup",
      "queue",
      1,
      sessionId,
      ctx.signal,
    );
    await appendPhase(
      journal,
      link.forgeRunId,
      "cleanup",
      "start",
      1,
      sessionId,
      ctx.signal,
    );
    await this.#git.deleteRemoteBranch(link.prepared, ctx.signal);
    await this.#git.cleanup(link.prepared, ctx.signal);
    await appendEffect(
      journal,
      link.forgeRunId,
      "cleanup",
      `worktree:${link.forgeRunId}`,
      digest(link.prepared.worktreePath),
      sessionId,
      ctx.signal,
    );
    await appendPhase(
      journal,
      link.forgeRunId,
      "cleanup",
      "complete",
      1,
      sessionId,
      ctx.signal,
      undefined,
      ["owned worktree removed", "remote feature branch deleted"],
    );

    await postTerminalIssueArtifacts({
      projector,
      link,
      result,
      pullNumber: pull.number,
      mergedSha: merged.sha,
      signal: ctx.signal,
    });

    const completed = await journal.append({
      runId: link.forgeRunId,
      type: "run.completed",
      payload: { outcome: "merged" },
      idempotencyKey: "run:completed",
      sessionId,
      message: `Complete ForgeDock run ${link.forgeRunId}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const terminal = link.orchestrationId
      ? completed
      : await journal.append({
          runId: link.forgeRunId,
          type: "lease.released",
          payload: {
            ownerRunId: link.leaseOwnerRunId,
            epoch: link.leaseEpoch,
          },
          idempotencyKey: "lease:release",
          sessionId,
          message: `Release ForgeDock lease ${link.forgeRunId}`,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
    const terminalEvent = terminal.events.at(-1);
    if (terminalEvent) {
      await projector.projectEvent({
        issueNumber: link.issueNumber,
        event: terminalEvent,
        markdown: `## ForgeDock Pi complete\n\nPR #${pull.number} merged into \`${link.prepared.baseBranch}\`.\nNested review completed at \`${result.review.headSha}\`.\nRun: \`${link.forgeRunId}\`.`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      await projector.setWorkflowLabel(
        link.issueNumber,
        "workflow:merged",
        ctx.signal,
      );
    }

    link.status = "completed";
    this.#persistLink(link);
    this.#emitLifecycle(link, {
      headSha: result.headSha,
      baseSha: result.baseSha,
      pullNumber: pull.number,
    });
    ctx.ui.setStatus("forgedock", undefined);
    ctx.ui.notify(
      `ForgeDock issue #${link.issueNumber} merged through PR #${pull.number}.`,
      "info",
    );
  }

  #lifecycleEvent(
    link: ActiveRunLink,
    details: Partial<WorkOnLifecycleEvent> = {},
  ): WorkOnLifecycleEvent {
    return {
      forgeRunId: link.forgeRunId,
      issueNumber: link.issueNumber,
      status: link.status,
      subagentRunId: link.subagentRunId,
      ...(link.orchestrationId
        ? { orchestrationId: link.orchestrationId }
        : {}),
      ...details,
    };
  }

  #emitLifecycle(
    link: ActiveRunLink,
    details: Partial<WorkOnLifecycleEvent> = {},
  ): WorkOnLifecycleEvent {
    const event = this.#lifecycleEvent(link, details);
    for (const listener of this.#lifecycleListeners) listener(event);
    return event;
  }

  #restoreLinks(ctx: ExtensionContext): void {
    this.#links.clear();
    const latest = new Map<string, ActiveRunLink>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== RUN_LINK_ENTRY)
        continue;
      const link = normalizeActiveRunLink(entry.data);
      if (link) latest.set(link.forgeRunId, link);
    }
    for (const link of latest.values())
      this.#links.set(link.subagentRunId, link);
  }

  #persistLink(link: ActiveRunLink): void {
    this.#pi.appendEntry(RUN_LINK_ENTRY, link);
    this.#links.set(link.subagentRunId, link);
  }
}

async function appendPhase(
  journal: RunJournal,
  runId: string,
  phase: "merge" | "close" | "cleanup",
  action: "queue" | "start" | "complete" | "block" | "needs-human",
  attempt: number,
  sessionId: string,
  signal?: AbortSignal,
  reason?: string,
  evidence?: readonly string[],
): Promise<void> {
  const type = {
    queue: "phase.queued",
    start: "phase.started",
    complete: "phase.completed",
    block: "phase.blocked",
    "needs-human": "phase.needs-human",
  } as const;
  const payload =
    action === "queue"
      ? {
          phase,
          attempt,
          restartAction: `reconcile and retry parent-owned ${phase}`,
        }
      : action === "start"
        ? { phase, attempt, logicalNodeId: `parent-${phase}-${attempt}` }
        : action === "complete"
          ? { phase, attempt, evidence: evidence ?? [] }
          : { phase, attempt, reason: reason ?? `${phase} ${action}` };
  await journal.append({
    runId,
    type: type[action],
    payload,
    idempotencyKey: `phase:${phase}:${attempt}:${action}`,
    sessionId,
    message: `Checkpoint ${runId} ${phase} ${action}`,
    ...(signal ? { signal } : {}),
  });
}

async function appendEffect(
  journal: RunJournal,
  runId: string,
  effectType: "push" | "pull-request" | "merge" | "issue-close" | "cleanup",
  effectId: string,
  effectDigest: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  await journal.append({
    runId,
    type: "effect.recorded",
    payload: { effectType, effectId, digest: effectDigest },
    idempotencyKey: `effect:${effectId}`,
    sessionId,
    message: `Record ForgeDock effect ${effectId}`,
    ...(signal ? { signal } : {}),
  });
}

async function postReviewCompletionArtifacts(input: {
  github: GitHubWorkflowAdapter;
  projector: GitHubIssueProjector;
  link: ActiveRunLink;
  result: ForgeWorkOnResult;
  pullNumber: number;
  mergedSha: string;
  signal?: AbortSignal;
}): Promise<void> {
  await input.projector.postArtifact({
    issueNumber: input.link.issueNumber,
    runId: input.link.forgeRunId,
    eventId: `review-${input.mergedSha}`,
    artifactKey: "review-checkpoint",
    markdown: `<!-- FORGE:CHECKPOINT -->\n${JSON.stringify({ phase: "REVIEW", status: "COMPLETE", next_phase: "CLOSE", timestamp: new Date().toISOString(), pr: input.pullNumber, head: input.result.review.headSha, merge_commit: input.mergedSha, base: input.link.prepared.baseBranch, verdict: "APPROVED", findings: input.result.review.findings.length, review_domains: input.result.review.reviewerResults.map((reviewer) => reviewerDomain(reviewer.reviewer)) })}`,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const decision = {
    schema_version: "1",
    issue: input.link.issueNumber,
    pr: input.pullNumber,
    repo: input.link.repository,
    lane: "integration",
    pr_base: input.link.prepared.baseBranch,
    branch: input.link.prepared.branch,
    head_sha: input.result.review.headSha,
    merge_commit: input.mergedSha,
    build: {
      files_changed: input.result.changedFiles.length,
      quality_gate: "pass",
    },
    review: {
      verdict: "APPROVED",
      findings_created: input.result.review.findings.length,
      agents_run: input.result.review.reviewerResults.length,
    },
  };
  await input.github.postPullArtifact({
    pullNumber: input.pullNumber,
    marker: "<!-- FORGE:DECISION_RECORD -->",
    body: `## Graph Decision Record — Issue #${input.link.issueNumber} / PR #${input.pullNumber}\n\n\`\`\`json\n${JSON.stringify(decision, null, 2)}\n\`\`\``,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

async function postTerminalIssueArtifacts(input: {
  projector: GitHubIssueProjector;
  link: ActiveRunLink;
  result: ForgeWorkOnResult;
  pullNumber: number;
  mergedSha: string;
  signal?: AbortSignal;
}): Promise<void> {
  await input.projector.postArtifact({
    issueNumber: input.link.issueNumber,
    runId: input.link.forgeRunId,
    eventId: `close-${input.mergedSha}`,
    artifactKey: "close-evidence",
    markdown: `Closed after PR #${input.pullNumber} was merged only to \`${input.link.prepared.baseBranch}\`.\n\nExact evidence:\n\n- PR: #${input.pullNumber}\n- Reviewed head: \`${input.result.review.headSha}\`\n- Merge commit on \`${input.link.prepared.baseBranch}\`: \`${input.mergedSha}\`\n- Verification: ${input.result.verification.map((check) => `${check.name}=${check.status}`).join(", ")}\n- Review domains: ${input.result.review.reviewerResults.map((reviewer) => reviewerDomain(reviewer.reviewer)).join(", ")}\n- Findings: ${input.result.review.findings.length}`,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const card = {
    base: input.link.prepared.baseBranch,
    commit: input.mergedSha,
    files: String(input.result.changedFiles.length),
    findings: String(input.result.review.findings.length),
    issue: String(input.link.issueNumber),
    pr: String(input.pullNumber),
    review: "APPROVED",
    reviewed: input.result.review.headSha,
    status: "CLOSED",
    tests: String(
      input.result.verification.filter((check) => check.status === "passed")
        .length,
    ),
    type: "CARD",
  };
  const encodedCard = Buffer.from(JSON.stringify(card)).toString("base64");
  const cardSha = createHash("sha256")
    .update(JSON.stringify(card))
    .digest("hex")
    .slice(0, 8);
  const trajectory = `<!-- FORGE:TRAJECTORY -->\n## Pipeline Trajectory — #${input.link.issueNumber}\n\n| Phase | Result | Notes |\n|-------|--------|-------|\n| Phase 0: Context Load | ✅ Complete | Repository policy and issue context loaded |\n| Phase 1: Investigation | ✅ CONFIRMED | Durable investigation report posted |\n| Phase 2: Decomposition | ⏭ Skipped | Single-concern change |\n| Phase 3: Build | ✅ Complete | Branch \`${input.link.prepared.branch}\`; head \`${input.result.headSha}\` |\n| Phase 3F.5: Validate | ✅ Gate passed | ${input.result.verification.map((check) => `${check.name}: ${check.status}`).join(", ")} |\n| Phase 4–5: Review + PR | ✅ Merged | PR #${input.pullNumber} → \`${input.link.prepared.baseBranch}\`; merge \`${input.mergedSha}\` |\n| Phase C6: Cleanup | ✅ Removed | Owned worktree removed |\n| Phase 7: Close | ✅ Complete | Issue closed with exact evidence |\n\n**Decisions**:\n\n- Pi-native work-on used nested fresh correctness and security reviewers.\n- Merge was limited to the configured integration branch; protected production branches were not touched.\n\n**Review**: ${input.result.review.reviewerResults.length} isolated passes; ${input.result.review.findings.length} findings.\n\n**Anomalies**:\n\n${input.result.residualRisks.length ? input.result.residualRisks.map((risk) => `- ${risk}`).join("\n") : "- None."}\n\n<!-- FORGE:CARD: v1 sha:${cardSha} b64:${encodedCard} -->`;
  await input.projector.postArtifact({
    issueNumber: input.link.issueNumber,
    runId: input.link.forgeRunId,
    eventId: `trajectory-${input.mergedSha}`,
    artifactKey: "trajectory",
    markdown: trajectory,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function publishReviewFindingIssues(input: {
  github: GitHubWorkflowAdapter;
  pullNumber: number;
  link: ActiveRunLink;
  result: ForgeWorkOnResult;
  signal?: AbortSignal;
}): Promise<Record<string, number>> {
  const existing = await input.github.listIssuesByLabel(
    "review-finding",
    "all",
    input.signal,
  );
  const issueMap: Record<string, number> = {};
  for (const finding of input.result.review.findings) {
    const marker = reviewFindingMarker(
      input.pullNumber,
      finding.id,
      input.result.review.headSha,
    );
    const exact = existing.find((issue) => issue.body.includes(marker));
    if (exact?.state === "open") {
      issueMap[finding.id] = exact.number;
      continue;
    }
    const similar = existing.find(
      (issue) =>
        issue.state === "open" &&
        issue.body.includes(`**File**: \`${finding.file}\``) &&
        lineWithinTolerance(issue.body, finding.line) &&
        similarFindingTitle(issue.title, finding.summary),
    );
    if (similar) {
      issueMap[finding.id] = similar.number;
      continue;
    }
    const regression = exact?.state === "closed";
    const priority = regression
      ? "priority:P1"
      : findingPriority(finding.severity);
    const title = `fix: ${finding.summary} (review finding — PR #${input.pullNumber})`.slice(
      0,
      240,
    );
    const body = renderFindingIssueBody({
      finding,
      pullNumber: input.pullNumber,
      link: input.link,
      headSha: input.result.review.headSha,
      marker,
      regressionIssue: regression ? exact?.number : undefined,
    });
    const created = await input.github.createIssue({
      title,
      body,
      labels: ["review-finding", "needs-validation", priority],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    issueMap[finding.id] = created.number;
    if (!existing.some((issue) => issue.number === created.number))
      existing.push(created);
  }
  if (input.result.review.findings.length > 0) {
    const lines = input.result.review.findings.map(
      (finding) =>
        `- #${issueMap[finding.id]} — ${finding.id}: ${finding.summary}`,
    );
    await input.github.postPullArtifact({
      pullNumber: input.pullNumber,
      marker: `<!-- FORGE:REVIEW_FINDING_ISSUES head=${input.result.review.headSha} -->`,
      body: `## Review Finding Issues\n\n${lines.join("\n")}`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
  return issueMap;
}

export function reviewFindingMarker(
  pullNumber: number,
  findingId: string,
  headSha: string,
): string {
  return `<!-- FORGE:REVIEW_FINDING source-pr=${pullNumber} finding=${encodeURIComponent(findingId)} head=${headSha} -->`;
}

function renderFindingIssueBody(input: {
  finding: ForgeReviewFindingResult;
  pullNumber: number;
  link: ActiveRunLink;
  headSha: string;
  marker: string;
  regressionIssue?: number;
}): string {
  const evidence = input.finding.evidence
    .map((entry) => `- ${entry}`)
    .join("\n");
  return `${input.marker}\n## Review Finding\n\n**Source PR**: #${input.pullNumber}\n**Source issue**: #${input.link.issueNumber}\n**Forge run**: \`${input.link.forgeRunId}\`\n**Reviewed head**: \`${input.headSha}\`\n**Reviewer**: \`${input.finding.reviewer}\`\n**Finding ID**: \`${input.finding.id}\`\n**Confidence**: ${input.finding.confidence.toUpperCase()}\n**Severity**: ${input.finding.severity.toUpperCase()}\n**Category**: ${input.finding.category}\n**File**: \`${input.finding.file}\`\n**Line**: ${input.finding.line}\n${input.regressionIssue ? `**Regression of**: #${input.regressionIssue}\n` : ""}\n### Problem\n\n${input.finding.summary}\n\n### Evidence\n\n${evidence || "- Reviewer supplied no additional evidence."}\n\n### Acceptance Criteria\n\n- [ ] Reproduce or validate the finding against the current integration branch.\n- [ ] Fix the root cause without expanding unrelated scope.\n- [ ] Add focused regression coverage.\n- [ ] Re-review the exact remediation head.\n\n<!-- FORGE:PATTERN: ${findingPattern(input.finding)} -->\n<!-- FORGE:CLASS: ${findingPattern(input.finding)} -->`;
}

function findingPattern(finding: ForgeReviewFindingResult): string {
  return `${finding.category}-${finding.id}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export function findingPriority(severity: ForgeReviewFindingResult["severity"]): string {
  return {
    critical: "priority:P0",
    high: "priority:P1",
    medium: "priority:P2",
    low: "priority:P3",
  }[severity];
}

export function lineWithinTolerance(body: string, line: number): boolean {
  const match = /\*\*Line\*\*:\s*(\d+)/.exec(body);
  if (!match?.[1]) return false;
  return Math.abs(Number(match[1]) - line) <= 5;
}

export function similarFindingTitle(title: string, summary: string): boolean {
  const words = (value: string): Set<string> =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3),
    );
  const left = words(title);
  const right = words(summary);
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared >= 3;
}

async function postRemediationArtifact(input: {
  github: GitHubWorkflowAdapter;
  projector: GitHubIssueProjector;
  pullNumber: number;
  link: ActiveRunLink;
  result: ForgeWorkOnResult;
  findingIssueMap: Record<string, number>;
  signal?: AbortSignal;
}): Promise<void> {
  const outcome =
    input.result.status === "ready-for-merge"
      ? "CLEAN RE-REVIEW"
      : "RE-ESCALATED";
  const body = `<!-- FORGE:REMEDIATION -->\n## Remediation Complete for PR #${input.pullNumber}\n\n**Attempt**: ${input.link.remediationAttempts}\n**Reviewed head**: \`${input.result.review.headSha}\`\n**Outcome**: ${outcome}\n**Remaining findings**: ${Object.entries(input.findingIssueMap)
    .map(([id, number]) => `#${number} (${id})`)
    .join(", ") || "none"}\n\n<!-- FORGE:REMEDIATION:COMPLETE -->`;
  await input.github.postPullArtifact({
    pullNumber: input.pullNumber,
    marker: `<!-- FORGE:REMEDIATION:COMPLETE run=${input.link.forgeRunId} -->`,
    body,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  await input.projector.postArtifact({
    issueNumber: input.link.issueNumber,
    runId: input.link.forgeRunId,
    eventId: `remediation-complete-${input.result.review.headSha}`,
    artifactKey: "remediation-complete",
    markdown: body,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

async function publishReviewArtifacts(
  github: GitHubWorkflowAdapter,
  pullNumber: number,
  result: ForgeWorkOnResult,
  findingIssueMap: Readonly<Record<string, number>>,
  signal?: AbortSignal,
): Promise<void> {
  for (const reviewer of result.review.reviewerResults) {
    const domain = reviewerDomain(reviewer.reviewer);
    await github.postPullArtifact({
      pullNumber,
      marker: `<!-- FORGE:REVIEW-AGENT:${domain} -->`,
      body: renderReviewerArtifact(reviewer, domain),
      ...(signal ? { signal } : {}),
    });
  }
  await github.postPullArtifact({
    pullNumber,
    marker: "<!-- FORGE:REVIEW -->",
    body: renderReviewSummary(pullNumber, result, findingIssueMap),
    ...(signal ? { signal } : {}),
  });
}

function renderReviewerArtifact(
  reviewer: ForgeReviewerResult,
  domain: string,
): string {
  const title = domain
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const findings =
    reviewer.findings.length === 0
      ? "No confirmed, likely, or possible findings."
      : reviewer.findings
          .map(
            (finding) =>
              `- **${finding.id}** ${finding.file}:${finding.line} — ${finding.summary}\n  - Confidence: ${finding.confidence}; severity: ${finding.severity}\n  - Evidence: ${finding.evidence.join("; ")}`,
          )
          .join("\n");
  const findingMarkers = reviewer.findings
    .map(
      (finding) =>
        `<!-- FINDING:${finding.id}|${finding.confidence.toUpperCase()}|${finding.severity.toUpperCase()}|${finding.file}:${finding.line}|${finding.summary.replaceAll("|", "/")} -->`,
    )
    .join("\n");
  return `## ${title} Review\n\n**Review mode**: isolated fresh-context pass from PR head \`${reviewer.headSha}\`.\n**Scope**: ${reviewer.filesReviewed.join(", ") || "frozen PR diff"}.\n\n### Findings\n\n${findings}\n\n**Verdict**: ${reviewer.verdict === "pass" ? "PASS" : reviewer.verdict.toUpperCase()}\n\n### Verification\n\n${reviewer.limitations.length ? reviewer.limitations.map((item) => `- Limitation: ${item}`).join("\n") : "- No reviewer limitations reported."}\n\n<!-- REVIEW-FINDINGS-START -->\n${findingMarkers}\n<!-- REVIEW-FINDINGS-END -->`;
}

function renderReviewSummary(
  pullNumber: number,
  result: ForgeWorkOnResult,
  findingIssueMap: Readonly<Record<string, number>>,
): string {
  const hasBlockingFindings = result.review.findings.some((finding) =>
    findingBlocksMerge(finding as ReviewFinding),
  );
  const verdict = hasBlockingFindings
    ? "CHANGES REQUESTED"
    : result.review.findings.length > 0
      ? "APPROVE WITH FOLLOW-UPS"
      : "APPROVE";
  const domains = result.review.reviewerResults.map((reviewer) =>
    reviewerDomain(reviewer.reviewer),
  );
  return `<!-- FORGE:REVIEW_SUMMARY -->\n# PR Review Summary: #${pullNumber}\n\n## Review Integrity\n\n**Reviewed commit**: \`${result.review.headSha}\`  \n**Current HEAD**: \`${result.headSha}\`  \n**Status**: ${result.review.headSha === result.headSha ? "CURRENT" : "STALE"}\n\n## Verdict: ${verdict}\n\n## Context-Aware Review\n\n**Domains**: ${domains.join(", ")}  \n**Review passes**: ${result.review.reviewerResults.length}  \n**Dispatch mode**: nested Pi subagents in fresh read-only contexts\n\n## Integration Checks\n\nRequired verification completed before review; merge authority remains parent-controlled.\n\n## Risk Matrix\n\n| Category | Risk | Blocking? | Confidence |\n|----------|------|-----------|------------|\n| Correctness | ${result.review.findings.length ? "Findings reported" : "No finding"} | ${result.review.findings.length ? "Evaluate" : "No"} | High |\n| Security | ${result.review.findings.some((finding) => finding.category === "security") ? "Finding reported" : "None found"} | ${result.review.findings.some((finding) => finding.category === "security") ? "Evaluate" : "No"} | High |\n\n## Findings\n\n${result.review.findings.length ? result.review.findings.map((finding) => `- #${findingIssueMap[finding.id] ?? "?"} — ${finding.id}: ${finding.summary}`).join("\n") : "No confirmed, likely, or possible findings."}\n\n## Automated Checks\n\n${result.verification.map((check) => `- ${check.name}: ${check.status}`).join("\n")}\n\n## Recommendation\n\n${hasBlockingFindings ? "Do not merge until blocking findings are remediated and re-reviewed." : result.review.findings.length > 0 ? "Approve for the configured integration branch with standalone follow-up issues for every non-blocking finding." : "Approve for the configured integration branch after the parent rechecks the frozen SHA and audit trail."}\n\n<!-- REVIEW-FINDINGS-START -->\n${result.review.findings.map((finding) => `<!-- FINDING:${finding.id}|${finding.confidence.toUpperCase()}|${finding.severity.toUpperCase()}|${finding.file}:${finding.line}|${finding.summary.replaceAll("|", "/")} -->`).join("\n")}\n<!-- REVIEW-FINDINGS-END -->`;
}

function reviewerDomain(reviewer: string): string {
  return reviewer.replace(/^forge-review-/, "").replace(/\s*\(.+\)$/, "");
}

async function resolveMergeability(
  github: GitHubWorkflowAdapter,
  pullNumber: number,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<GitHubWorkflowAdapter["getPullRequest"]>>> {
  let pull = await github.getPullRequest(pullNumber, signal);
  for (
    let attempt = 0;
    attempt < 4 && pull.mergeability === "unknown";
    attempt += 1
  ) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    pull = await github.getPullRequest(pullNumber, signal);
  }
  return pull;
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

function buildPullBody(link: ActiveRunLink, result: ForgeWorkOnResult): string {
  const checks = result.verification
    .map(
      (check) =>
        `- ${check.status === "passed" ? "[x]" : "[ ]"} ${check.name}: ${check.status}`,
    )
    .join("\n");
  return [
    "## Summary",
    `Implements #${link.issueNumber} through ForgeDock Pi run \`${link.forgeRunId}\`.`,
    "",
    "## Changed files",
    ...result.changedFiles.map((file) => `- \`${file}\``),
    "",
    "## Verification",
    checks || "- No verification results",
    "",
    "## Review",
    `Nested reviewers: ${result.review.completedReviewers.join(", ")}`,
    `Frozen head: \`${result.review.headSha}\``,
    `Findings: ${result.review.findings.length}`,
  ].join("\n");
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
    result.baseSha !== link.reviewBaseSha
  )
    throw new Error("Work-on result branch/base identity mismatch.");
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSorted = [...new Set(left)].sort((first, second) =>
    first.localeCompare(second),
  );
  const rightSorted = [...new Set(right)].sort((first, second) =>
    first.localeCompare(second),
  );
  return leftSorted.join("\0") === rightSorted.join("\0");
}

function findAsyncCompletionForRun(
  value: unknown,
  runId: string,
): ReturnType<typeof parseAsyncCompletion> {
  const direct = parseAsyncCompletion(value);
  if (direct?.runId === runId) return direct;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findAsyncCompletionForRun(entry, runId);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findAsyncCompletionForRun(entry, runId);
    if (found) return found;
  }
  return undefined;
}

export function parseAsyncCompletion(value: unknown):
  | {
      runId: string;
      state: "running" | "complete" | "failed" | "paused" | "stopped";
      error?: string;
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const runId =
    typeof record.runId === "string"
      ? record.runId
      : typeof record.id === "string"
        ? record.id
        : undefined;
  if (!runId) return undefined;
  const rawState =
    typeof record.state === "string"
      ? record.state
      : record.success === true
        ? "complete"
        : record.success === false
          ? "failed"
          : undefined;
  const state = rawState === "completed" ? "complete" : rawState;
  if (
    state !== "running" &&
    state !== "complete" &&
    state !== "failed" &&
    state !== "paused" &&
    state !== "stopped"
  )
    return undefined;
  const error =
    typeof record.error === "string"
      ? record.error.trim()
      : typeof record.summary === "string" && state !== "complete"
        ? record.summary.trim()
        : undefined;
  return { runId, state, ...(error ? { error } : {}) };
}

function normalizeActiveRunLink(value: unknown): ActiveRunLink | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const link = value as Partial<ActiveRunLink>;
  const statuses: readonly ActiveRunStatus[] = [
    "running",
    "ready",
    "refreshing",
    "finalizing",
    "completed",
    "blocked",
    "needs-human",
    "failed",
  ];
  if (
    typeof link.forgeRunId !== "string" ||
    typeof link.subagentRunId !== "string" ||
    !Number.isSafeInteger(link.issueNumber) ||
    typeof link.repository !== "string" ||
    typeof link.stateBranch !== "string" ||
    typeof link.resultPath !== "string" ||
    !link.status ||
    !statuses.includes(link.status) ||
    !link.prepared ||
    typeof link.prepared !== "object"
  )
    return undefined;
  return {
    ...(link as ActiveRunLink),
    leaseOwnerRunId: link.leaseOwnerRunId ?? link.forgeRunId,
    leaseEpoch: link.leaseEpoch ?? 1,
    reviewBaseSha: link.reviewBaseSha ?? link.prepared.baseSha,
    refreshes: link.refreshes ?? 0,
    providerRetries: link.providerRetries ?? 0,
    remediationAttempts: link.remediationAttempts ?? 0,
    findingIssueMap: link.findingIssueMap ?? {},
  };
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

export function isTransientProviderFailure(message: string): boolean {
  if (
    /insufficient_quota|quota exceeded|out of budget|billing|authentication|unauthorized|forbidden/i.test(
      message,
    )
  )
    return false;
  return /websocket\s*(?:closed|closure|error)|connection\s*(?:error|refused|lost|reset)|socket hang up|socket connection was closed|network error|fetch failed|EAI_AGAIN|ENOTFOUND|terminated|timed? out|timeout|rate.?limit|too many requests|\b429\b|\b50[0234]\b|\b524\b|service unavailable|server error|internal error|provider returned error|stream ended/i.test(
    message,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
