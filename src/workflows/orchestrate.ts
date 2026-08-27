import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  FetchGitHubTransport,
  type GitHubCoreRateLimit,
  readGitHubCoreRateLimit,
} from "../adapters/github-api.ts";
import { createGitHubTokenProvider } from "../adapters/github-auth.ts";
import { loadForgePolicy } from "../adapters/config.ts";
import { RunJournal } from "../adapters/run-journal.ts";
import { GitWorktreeManager } from "../adapters/git.ts";
import { GitHubStateBranchStore } from "../adapters/github-state.ts";
import { GitHubWorkflowAdapter } from "../adapters/github-workflow.ts";
import {
  isTerminalLane,
  nextIntegrationLane,
  readyOrchestrationLanes,
  type OrchestrationDependencyEdge,
  type OrchestrationState,
} from "../core/orchestration.ts";
import { isProtectedBranch, type ForgePolicy } from "../core/policy.ts";
import { OrchestrationJournal } from "./orchestration-journal.ts";
import type { ForgeWorkOnController, WorkOnLifecycleEvent } from "./work-on.ts";

const ORCHESTRATION_LINK_ENTRY = "forgedock-orchestration-link/v1";

export interface ActiveOrchestrationLink {
  orchestrationId: string;
  repository: string;
  repositoryRoot: string;
  stateBranch: string;
  issueNumbers: readonly number[];
  integrationBranch: string;
  maxConcurrent: number;
  status:
    | "running"
    | "completed"
    | "blocked"
    | "needs-human"
    | "failed"
    | "cancelled";
}

export interface StartOrchestrationResult {
  orchestrationId: string;
  issueNumbers: readonly number[];
  maxConcurrent: number;
  integrationBranch: string;
}

export interface OrchestrationStatusSnapshot {
  link: ActiveOrchestrationLink;
  state?: OrchestrationState;
  error?: string;
}

export class ForgeOrchestrationController {
  readonly #pi: ExtensionAPI;
  readonly #workOn: ForgeWorkOnController;
  readonly #git: GitWorktreeManager;
  readonly #links = new Map<string, ActiveOrchestrationLink>();
  readonly #pumping = new Set<string>();
  readonly #pumpPending = new Set<string>();
  readonly #lifecycleQueues = new Map<string, Promise<void>>();
  readonly #rateBudgets = new Map<
    string,
    { checkedAt: number; budget: GitHubCoreRateLimit }
  >();
  #lifecycleUnsubscribe: (() => void) | undefined;

  constructor(pi: ExtensionAPI, workOn: ForgeWorkOnController) {
    this.#pi = pi;
    this.#workOn = workOn;
    this.#git = new GitWorktreeManager({
      exec: (command, args, options) => pi.exec(command, [...args], options),
    });
  }

  async attach(ctx: ExtensionContext): Promise<void> {
    this.#restoreLinks(ctx);
    this.#lifecycleUnsubscribe?.();
    this.#lifecycleUnsubscribe = this.#workOn.onLifecycle((event) => {
      if (!event.orchestrationId) return;
      void this.#enqueueLifecycle(event, ctx);
    });
  }

  async resume(ctx: ExtensionContext): Promise<void> {
    for (const link of this.#links.values()) {
      if (link.status !== "running") continue;
      try {
        let snapshot = await this.#read(link, ctx.signal);
        this.#syncLink(link, snapshot.state);
        this.#persistLink(link);
        await this.#recoverFalseFailures(link, snapshot.state, ctx);
        snapshot = await this.#read(link, ctx.signal);
        for (const lane of snapshot.state.lanes) {
          if (lane.status !== "running") continue;
          const event = await this.#workOn.reconcileOrchestrationIssue(
            link.orchestrationId,
            lane.issueNumber,
            ctx,
          );
          if (event) await this.#handleLifecycle(event, ctx);
        }
        await this.#lifecycleQueues.get(link.orchestrationId);
        snapshot = await this.#read(link, ctx.signal);
        await this.#recoverFalseFailures(link, snapshot.state, ctx);
        await this.#pump(link, ctx);
      } catch (error) {
        ctx.ui.notify(
          `ForgeDock orchestration ${link.orchestrationId} could not resume: ${errorMessage(error)}`,
          "warning",
        );
      }
    }
  }

  dispose(): void {
    this.#lifecycleUnsubscribe?.();
    this.#lifecycleUnsubscribe = undefined;
    this.#pumpPending.clear();
    this.#lifecycleQueues.clear();
  }

  async start(
    issueNumbers: readonly number[],
    ctx: ExtensionContext,
  ): Promise<StartOrchestrationResult> {
    validateIssueNumbers(issueNumbers);
    const repositoryRoot = await this.#git.resolveRepositoryRoot(
      ctx.cwd,
      ctx.signal,
    );
    const { policy } = await loadForgePolicy(repositoryRoot);
    if (issueNumbers.length > policy.orchestration.maxIssues)
      throw new Error(
        `Orchestration accepts at most ${policy.orchestration.maxIssues} issues by policy.`,
      );
    const integrationBranch = chooseIntegrationBranch(policy);
    if (isProtectedBranch(policy, integrationBranch))
      throw new Error(`Integration branch ${integrationBranch} is protected.`);
    await this.#git.remoteBaseSha(
      repositoryRoot,
      integrationBranch,
      ctx.signal,
    );
    const tokenProvider = createGitHubTokenProvider(this.#pi, repositoryRoot);
    const transport = new FetchGitHubTransport({ tokenProvider });
    const dependencies = await discoverIssueDependencies(
      new GitHubWorkflowAdapter(transport, policy.repository.name),
      issueNumbers,
      ctx.signal,
    );
    const store = new GitHubStateBranchStore(
      transport,
      policy.repository.name,
      policy.state.branch,
    );
    const orchestrationId = randomUUID();
    await store.ensureBranch(new Date(), ctx.signal);
    const journal = new OrchestrationJournal(store);
    await journal.initialize({
      orchestrationId,
      repository: policy.repository.name,
      issueNumbers,
      integrationBranch,
      maxConcurrent: policy.orchestration.maxConcurrent,
      dependencies,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const link: ActiveOrchestrationLink = {
      orchestrationId,
      repository: policy.repository.name,
      repositoryRoot,
      stateBranch: policy.state.branch,
      issueNumbers: [...issueNumbers],
      integrationBranch,
      maxConcurrent: policy.orchestration.maxConcurrent,
      status: "running",
    };
    this.#links.set(orchestrationId, link);
    this.#persistLink(link);
    ctx.ui.setStatus(
      "forgedock",
      `orchestrating ${issueNumbers.length} issues · ${policy.orchestration.maxConcurrent} parallel`,
    );
    await this.#pump(link, ctx);
    return {
      orchestrationId,
      issueNumbers: [...issueNumbers],
      maxConcurrent: policy.orchestration.maxConcurrent,
      integrationBranch,
    };
  }

  async inspect(signal?: AbortSignal): Promise<OrchestrationStatusSnapshot[]> {
    return Promise.all(
      [...this.#links.values()].map(async (link) => {
        const snapshot = cloneLink(link);
        try {
          const current = await this.#read(link, signal);
          return { link: snapshot, state: current.state };
        } catch (error) {
          return { link: snapshot, error: errorMessage(error) };
        }
      }),
    );
  }

  async cancel(
    orchestrationId: string,
    ctx: ExtensionContext,
    reason: string,
  ): Promise<OrchestrationState> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(orchestrationId))
      throw new Error("Invalid orchestration ID.");
    const repositoryRoot = await this.#git.resolveRepositoryRoot(
      ctx.cwd,
      ctx.signal,
    );
    const { policy } = await loadForgePolicy(repositoryRoot);
    const tokenProvider = createGitHubTokenProvider(this.#pi, repositoryRoot);
    const store = new GitHubStateBranchStore(
      new FetchGitHubTransport({ tokenProvider }),
      policy.repository.name,
      policy.state.branch,
    );
    const current = await store.readOrchestration(orchestrationId, ctx.signal);
    if (!current.state)
      throw new Error(`Orchestration ${orchestrationId} does not exist.`);
    if (current.state.status !== "running") return current.state;
    await this.#cancelDurableChildRuns(store, current.state, ctx, reason);
    await this.#workOn.stopOrchestration(orchestrationId, ctx, reason);
    const cancelled = await new OrchestrationJournal(store).cancel({
      orchestrationId,
      reason,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const link = this.#links.get(orchestrationId);
    if (link) {
      this.#syncLink(link, cancelled);
      this.#persistLink(link);
    }
    return cancelled;
  }

  async shutdown(ctx: ExtensionContext, reason: string): Promise<void> {
    const active = [...this.#links.values()].filter(
      (link) => link.status === "running",
    );
    await Promise.allSettled(
      active.map((link) => this.cancel(link.orchestrationId, ctx, reason)),
    );
  }

  async #cancelDurableChildRuns(
    store: GitHubStateBranchStore,
    state: OrchestrationState,
    ctx: ExtensionContext,
    reason: string,
  ): Promise<void> {
    const childRunIds: string[] = [];
    const providerRunIds: string[] = [];
    for (const lane of state.lanes) {
      if (!lane.forgeRunId) continue;
      const current = await store.readRun(lane.forgeRunId, ctx.signal);
      if (
        !current.state ||
        current.state.status === "completed" ||
        current.state.status === "cancelled"
      )
        continue;
      childRunIds.push(lane.forgeRunId);
      if (lane.subagentRunId) providerRunIds.push(lane.subagentRunId);
      for (const node of Object.values(current.state.nodes)) {
        if (node.status === "running" && node.subagentRunId)
          providerRunIds.push(node.subagentRunId);
      }
    }
    await this.#workOn.stopProviderRuns(providerRunIds);
    const journal = new RunJournal(store);
    for (const runId of childRunIds) {
      const current = await store.readRun(runId, ctx.signal);
      if (
        current.state &&
        current.state.status !== "completed" &&
        current.state.status !== "cancelled"
      ) {
        await journal.append({
          runId,
          type: "run.cancelled",
          payload: { reason },
          idempotencyKey: "run:cancelled",
          sessionId: ctx.sessionManager.getSessionId(),
          message: `Cancel child ForgeDock run ${runId}`,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }
      const readBack = await store.readRun(runId, ctx.signal);
      if (readBack.state?.status !== "cancelled")
        throw new Error(
          `Child ForgeDock run ${runId} did not durably reach cancelled state.`,
        );
    }
  }

  async #recoverFalseFailures(
    link: ActiveOrchestrationLink,
    state: OrchestrationState,
    ctx: ExtensionContext,
  ): Promise<void> {
    const runs = this.#workOn.listRuns();
    for (const lane of state.lanes) {
      const run = runs.find(
        (candidate) =>
          candidate.orchestrationId === link.orchestrationId &&
          candidate.issueNumber === lane.issueNumber,
      );
      if (
        lane.status === "running" &&
        run?.status === "needs-human" &&
        run.subagentRunId.startsWith("launch:")
      ) {
        const current = await this.#read(link, ctx.signal);
        await current.journal.append({
          orchestrationId: link.orchestrationId,
          type: "lane.failed",
          payload: {
            issueNumber: lane.issueNumber,
            reason:
              "Provider continuation did not return a durable receipt; rerun this issue in a new orchestration.",
          },
          idempotencyKey: `lane:${lane.issueNumber}:continuation-unbound`,
          message: `Fail issue ${lane.issueNumber} unbound continuation`,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        continue;
      }
      if (
        !["failed", "blocked", "needs-human"].includes(lane.status) ||
        !lane.reason ||
        !/schema-valid Forge result artifact|State branch changed after|unsupported-continuation|WebSocket|timed? out|timeout|connection (?:lost|reset|error)|\b50[0234]\b|\b429\b|No comment found for marker.*FORGE:BUILDER|checkpoint failed validation|omitted the required canonical|required canonical .* section|Invalid username or token|Bound branch push failed|^forge-work-on:\s*$/i.test(
          lane.reason,
        )
      )
        continue;
      const active = await this.#workOn.reactivateOrchestrationIssue(
        link.orchestrationId,
        lane.issueNumber,
      );
      if (!active) continue;
      const current = await this.#read(link, ctx.signal);
      await current.journal.append({
        orchestrationId: link.orchestrationId,
        type: "lane.recovered",
        payload: {
          issueNumber: lane.issueNumber,
          forgeRunId: active.forgeRunId,
          subagentRunId: active.subagentRunId,
        },
        idempotencyKey: `lane:${lane.issueNumber}:recovered:${active.forgeRunId}`,
        message: `Recover issue ${lane.issueNumber} lane receipt`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (active.state === "complete")
        await this.#workOn.reconcileRun(active.forgeRunId, ctx);
    }
  }

  async #enqueueLifecycle(
    event: WorkOnLifecycleEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    const orchestrationId = event.orchestrationId;
    if (!orchestrationId) return;
    const prior =
      this.#lifecycleQueues.get(orchestrationId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.#handleLifecycle(event, ctx))
      .catch((error) => {
        ctx.ui.notify(
          `ForgeDock orchestration ${orchestrationId} reconciliation failed: ${errorMessage(error)}`,
          "error",
        );
      });
    this.#lifecycleQueues.set(orchestrationId, next);
    await next;
    if (this.#lifecycleQueues.get(orchestrationId) === next)
      this.#lifecycleQueues.delete(orchestrationId);
  }

  async #handleLifecycle(
    event: WorkOnLifecycleEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    const orchestrationId = event.orchestrationId;
    if (!orchestrationId) return;
    const link = this.#links.get(orchestrationId);
    if (!link || link.status !== "running") return;
    const current = await this.#read(link, ctx.signal);
    const lane = current.state.lanes.find(
      (candidate) => candidate.issueNumber === event.issueNumber,
    );
    if (!lane || isTerminalLane(lane)) return;
    if (!lifecycleMatchesForgeRun(lane, event)) return;
    // A work-on run uses a new child receipt for each bounded node. The stable
    // Forge run ID, not the latest child receipt, owns lane lifecycle events.
    const journal = current.journal;
    if (event.status === "ready") {
      await journal.append({
        orchestrationId,
        type: "lane.ready",
        payload: {
          issueNumber: event.issueNumber,
          headSha: required(event.headSha, "headSha"),
          baseSha: required(event.baseSha, "baseSha"),
          subagentRunId: event.subagentRunId,
        },
        idempotencyKey: `lane:${event.issueNumber}:ready:${lane.refreshes}`,
        message: `Mark issue ${event.issueNumber} ready for integration`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } else if (event.status === "refreshing") {
      await journal.append({
        orchestrationId,
        type: "lane.refreshing",
        payload: {
          issueNumber: event.issueNumber,
          subagentRunId: event.subagentRunId,
          baseSha: required(event.baseSha, "baseSha"),
        },
        idempotencyKey: `lane:${event.issueNumber}:refresh:${lane.refreshes + 1}`,
        message: `Refresh issue ${event.issueNumber} on the latest base`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } else if (event.status === "completed") {
      if (event.outcome === "closed") {
        await journal.append({
          orchestrationId,
          type: "lane.closed",
          payload: {
            issueNumber: event.issueNumber,
            reason:
              "Closed without code after invalid/decomposed investigation.",
          },
          idempotencyKey: `lane:${event.issueNumber}:closed`,
          message: `Close issue ${event.issueNumber} without code`,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } else {
        await journal.append({
          orchestrationId,
          type: "lane.merged",
          payload: {
            issueNumber: event.issueNumber,
            pullNumber: requiredNumber(event.pullNumber, "pullNumber"),
            headSha: required(event.headSha, "headSha"),
          },
          idempotencyKey: `lane:${event.issueNumber}:merged`,
          message: `Complete issue ${event.issueNumber} integration`,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }
    } else if (
      event.status === "blocked" ||
      event.status === "needs-human" ||
      event.status === "failed"
    ) {
      await journal.append({
        orchestrationId,
        type:
          event.status === "blocked"
            ? "lane.blocked"
            : event.status === "needs-human"
              ? "lane.needs-human"
              : "lane.failed",
        payload: {
          issueNumber: event.issueNumber,
          reason: normalizeReason(event.reason, event.status),
        },
        idempotencyKey: `lane:${event.issueNumber}:${event.status}`,
        message: `Stop issue ${event.issueNumber}: ${event.status}`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } else return;
    const latest = await this.#read(link, ctx.signal);
    await this.#recoverFalseFailures(link, latest.state, ctx);
    await this.#pump(link, ctx);
  }

  async #pump(
    link: ActiveOrchestrationLink,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (this.#pumping.has(link.orchestrationId)) {
      this.#pumpPending.add(link.orchestrationId);
      return;
    }
    this.#pumping.add(link.orchestrationId);
    try {
      let progress = true;
      while (progress && link.status === "running") {
        progress = false;
        let current = await this.#read(link, ctx.signal);
        const effectiveConcurrency = await this.#effectiveConcurrency(
          link,
          current.state.maxConcurrent,
          ctx.signal,
        );
        for (const lane of readyOrchestrationLanes(
          current.state,
          effectiveConcurrency,
        )) {
          const existing = this.#workOn
            .listRuns()
            .find(
              (run) =>
                run.orchestrationId === link.orchestrationId &&
                run.issueNumber === lane.issueNumber,
            );
          let result = existing
            ? {
                runId: existing.forgeRunId,
                subagentRunId: existing.subagentRunId,
              }
            : undefined;
          if (!result) {
            try {
              result = await this.#workOn.startIssue(lane.issueNumber, ctx, {
                orchestrationId: link.orchestrationId,
              });
            } catch (error) {
              const recovered = this.#workOn
                .listRuns()
                .find(
                  (run) =>
                    run.orchestrationId === link.orchestrationId &&
                    run.issueNumber === lane.issueNumber &&
                    Object.keys(run.activeNodes).length > 0,
                );
              if (recovered) {
                result = {
                  runId: recovered.forgeRunId,
                  subagentRunId: recovered.subagentRunId,
                };
              } else if (isRetryableSetupError(error)) {
                ctx.ui.notify(
                  `ForgeDock orchestration ${link.orchestrationId} is paused before issue #${lane.issueNumber}: ${normalizeReason(errorMessage(error), "Repository setup is incomplete.")} Run /forge:init, then it will resume the queued lanes.`,
                  "warning",
                );
                return;
              } else {
                await current.journal.append({
                  orchestrationId: link.orchestrationId,
                  type: "lane.failed",
                  payload: {
                    issueNumber: lane.issueNumber,
                    reason: normalizeReason(
                      errorMessage(error),
                      "Lane launch failed.",
                    ),
                  },
                  idempotencyKey: `lane:${lane.issueNumber}:launch-failed`,
                  message: `Fail issue ${lane.issueNumber} launch`,
                  ...(ctx.signal ? { signal: ctx.signal } : {}),
                });
                progress = true;
                current = await this.#read(link, ctx.signal);
                continue;
              }
            }
          }
          try {
            await current.journal.append({
              orchestrationId: link.orchestrationId,
              type: "lane.started",
              payload: {
                issueNumber: lane.issueNumber,
                forgeRunId: result.runId,
                subagentRunId: result.subagentRunId,
              },
              idempotencyKey: `lane:${lane.issueNumber}:started`,
              message: `Start issue ${lane.issueNumber}`,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
          } catch (error) {
            ctx.ui.notify(
              `ForgeDock issue #${lane.issueNumber} launched as run ${result.runId}, but its lane receipt is waiting for CAS reconciliation: ${errorMessage(error)}`,
              "warning",
            );
            return;
          }
          progress = true;
          current = await this.#read(link, ctx.signal);
        }

        current = await this.#read(link, ctx.signal);
        const integration = nextIntegrationLane(current.state);
        if (integration?.forgeRunId) {
          await current.journal.append({
            orchestrationId: link.orchestrationId,
            type: "lane.integrating",
            payload: { issueNumber: integration.issueNumber },
            idempotencyKey: `lane:${integration.issueNumber}:integrate:${integration.refreshes}`,
            message: `Integrate issue ${integration.issueNumber}`,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          try {
            await this.#workOn.integrateIssue(integration.forgeRunId, ctx);
          } catch (error) {
            const latest = await this.#read(link, ctx.signal);
            await latest.journal.append({
              orchestrationId: link.orchestrationId,
              type: "lane.failed",
              payload: {
                issueNumber: integration.issueNumber,
                reason: normalizeReason(
                  errorMessage(error),
                  "Lane integration failed.",
                ),
              },
              idempotencyKey: `lane:${integration.issueNumber}:integration-failed`,
              message: `Fail issue ${integration.issueNumber} integration`,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
          }
          progress = true;
        }

        current = await this.#read(link, ctx.signal);
        if (current.state.lanes.every(isTerminalLane)) {
          const reason = childCleanupReason(current.state);
          if (reason) {
            await this.#cancelDurableChildRuns(
              current.store,
              current.state,
              ctx,
              reason,
            );
            await this.#workOn.stopOrchestration(
              link.orchestrationId,
              ctx,
              reason,
            );
            current = await this.#read(link, ctx.signal);
          }
          const completed = await current.journal.complete({
            orchestrationId: link.orchestrationId,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          this.#syncLink(link, completed);
          this.#persistLink(link);
          ctx.ui.setStatus("forgedock", undefined);
          ctx.ui.notify(
            renderCompletion(completed),
            completed.status === "completed" ? "info" : "warning",
          );
          break;
        }
      }
      const latest = await this.#read(link, ctx.signal);
      this.#syncLink(link, latest.state);
      this.#persistLink(link);
    } finally {
      this.#pumping.delete(link.orchestrationId);
      if (this.#pumpPending.delete(link.orchestrationId))
        void this.#pump(link, ctx);
    }
  }

  async #effectiveConcurrency(
    link: ActiveOrchestrationLink,
    configuredMax: number,
    signal?: AbortSignal,
  ): Promise<number> {
    while (true) {
      const now = Date.now();
      let cached = this.#rateBudgets.get(link.repository);
      if (!cached || now - cached.checkedAt > 15_000) {
        const tokenProvider = createGitHubTokenProvider(
          this.#pi,
          link.repositoryRoot,
        );
        const budget = await readGitHubCoreRateLimit(
          new FetchGitHubTransport({ tokenProvider }),
          signal,
        );
        cached = { checkedAt: now, budget };
        this.#rateBudgets.set(link.repository, cached);
      }
      const concurrency = rateLimitedOrchestrationConcurrency(
        configuredMax,
        cached.budget,
      );
      if (concurrency > 0) return concurrency;
      const waitMs = Math.min(
        60 * 60_000,
        Math.max(1_000, cached.budget.resetAt - now + 1_000),
      );
      await orchestrationDelay(waitMs, signal);
      this.#rateBudgets.delete(link.repository);
    }
  }

  async #read(
    link: ActiveOrchestrationLink,
    signal?: AbortSignal,
  ): Promise<{
    state: OrchestrationState;
    journal: OrchestrationJournal;
    store: GitHubStateBranchStore;
  }> {
    const tokenProvider = createGitHubTokenProvider(
      this.#pi,
      link.repositoryRoot,
    );
    const store = new GitHubStateBranchStore(
      new FetchGitHubTransport({ tokenProvider }),
      link.repository,
      link.stateBranch,
    );
    const current = await store.readOrchestration(link.orchestrationId, signal);
    if (!current.state)
      throw new Error(
        `Orchestration ${link.orchestrationId} is missing authoritative state.`,
      );
    return {
      state: current.state,
      journal: new OrchestrationJournal(store),
      store,
    };
  }

  #syncLink(link: ActiveOrchestrationLink, state: OrchestrationState): void {
    link.status = state.status;
  }

  #restoreLinks(ctx: ExtensionContext): void {
    this.#links.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type !== "custom" ||
        entry.customType !== ORCHESTRATION_LINK_ENTRY
      )
        continue;
      const link = normalizeLink(entry.data);
      if (link) this.#links.set(link.orchestrationId, link);
    }
  }

  #persistLink(link: ActiveOrchestrationLink): void {
    this.#pi.appendEntry(ORCHESTRATION_LINK_ENTRY, link);
    this.#links.set(link.orchestrationId, link);
  }
}

async function discoverIssueDependencies(
  github: GitHubWorkflowAdapter,
  issueNumbers: readonly number[],
  signal?: AbortSignal,
): Promise<OrchestrationDependencyEdge[]> {
  const confirmed = new Set(issueNumbers);
  const dependencies: OrchestrationDependencyEdge[] = [];
  for (const issueNumber of issueNumbers) {
    const blockers = await github.listIssueBlockedBy(issueNumber, signal);
    for (const blocker of blockers) {
      if (!confirmed.has(blocker)) continue;
      dependencies.push({
        fromIssue: blocker,
        toIssue: issueNumber,
        kind: "explicit",
        reason: `GitHub issue dependency: #${issueNumber} is blocked by #${blocker}.`,
      });
    }
  }
  return dependencies;
}

const GITHUB_CONTROL_PLANE_MIN_RESERVE = 1_000;
const GITHUB_LANE_ESTIMATED_REQUEST_COST = 750;

export function rateLimitedOrchestrationConcurrency(
  configuredMax: number,
  budget: GitHubCoreRateLimit,
): number {
  if (!Number.isSafeInteger(configuredMax) || configuredMax < 1)
    throw new TypeError(
      "Configured orchestration concurrency must be positive.",
    );
  const reserve = Math.max(
    GITHUB_CONTROL_PLANE_MIN_RESERVE,
    Math.ceil(budget.limit * 0.2),
  );
  const available = Math.max(0, budget.remaining - reserve);
  return Math.min(
    configuredMax,
    Math.floor(available / GITHUB_LANE_ESTIMATED_REQUEST_COST),
  );
}

async function orchestrationDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Orchestration rate wait aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref();
  });
}

function chooseIntegrationBranch(policy: ForgePolicy): string {
  const exact = policy.branches.integration.find(
    (candidate) => !candidate.includes("*"),
  );
  if (!exact)
    throw new Error(
      "Forge policy needs at least one exact integration branch for work-on.",
    );
  return exact;
}

function validateIssueNumbers(issueNumbers: readonly number[]): void {
  if (issueNumbers.length === 0)
    throw new Error("Orchestration requires at least one issue number.");
  for (const issueNumber of issueNumbers) {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
      throw new Error("Issue numbers must be positive safe integers.");
  }
  if (new Set(issueNumbers).size !== issueNumbers.length)
    throw new Error("Orchestration issue numbers must be unique.");
}

function cloneLink(link: ActiveOrchestrationLink): ActiveOrchestrationLink {
  return { ...link, issueNumbers: [...link.issueNumbers] };
}

function normalizeLink(value: unknown): ActiveOrchestrationLink | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const link = value as Partial<ActiveOrchestrationLink>;
  if (
    typeof link.orchestrationId !== "string" ||
    typeof link.repository !== "string" ||
    typeof link.repositoryRoot !== "string" ||
    typeof link.stateBranch !== "string" ||
    !Array.isArray(link.issueNumbers) ||
    !link.issueNumbers.every(Number.isSafeInteger) ||
    typeof link.integrationBranch !== "string" ||
    !Number.isSafeInteger(link.maxConcurrent) ||
    typeof link.status !== "string"
  )
    return undefined;
  return link as ActiveOrchestrationLink;
}

function renderCompletion(state: OrchestrationState): string {
  const counts = new Map<string, number>();
  for (const lane of state.lanes)
    counts.set(lane.status, (counts.get(lane.status) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([status, count]) => `${status}=${count}`)
    .join(" · ");
  return `ForgeDock orchestration ${state.orchestrationId} finished: ${state.status}.\n${summary}`;
}

export function childCleanupReason(
  state: Pick<OrchestrationState, "lanes">,
): string | undefined {
  if (!state.lanes.every(isTerminalLane)) return undefined;
  const unsuccessful = state.lanes.filter(
    (lane) => lane.status !== "merged" && lane.status !== "closed",
  );
  if (unsuccessful.length === 0) return undefined;
  return `Orchestration is terminal with ${unsuccessful
    .map((lane) => `#${lane.issueNumber}:${lane.status}`)
    .join(
      ", ",
    )}; stopping nonterminal child runs before orchestration completion.`;
}

export function lifecycleMatchesForgeRun(
  lane: { forgeRunId?: string },
  event: { forgeRunId: string },
): boolean {
  return !lane.forgeRunId || lane.forgeRunId === event.forgeRunId;
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`Work-on lifecycle event is missing ${field}.`);
  return value;
}

function requiredNumber(value: number | undefined, field: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1)
    throw new Error(`Work-on lifecycle event is missing ${field}.`);
  return value as number;
}

function isRetryableSetupError(error: unknown): boolean {
  return /forge policy|config\.json|integration branch|remote ref|couldn['’]t find remote ref|repository setup/i.test(
    errorMessage(error),
  );
}

function normalizeReason(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
