import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { FetchGitHubTransport } from "../adapters/github-api.ts";
import { loadForgePolicy } from "../adapters/config.ts";
import { resolveGitHubToken } from "../adapters/github-auth.ts";
import { RunJournal } from "../adapters/run-journal.ts";
import { GitWorktreeManager } from "../adapters/git.ts";
import { GitHubStateBranchStore } from "../adapters/github-state.ts";
import {
  isTerminalLane,
  nextIntegrationLane,
  readyOrchestrationLanes,
  type OrchestrationState,
} from "../core/orchestration.ts";
import { isLeaseExpired } from "../core/lease.ts";
import { isProtectedBranch, type ForgePolicy } from "../core/policy.ts";
import type { RunState } from "../core/state.ts";
import { OrchestrationJournal } from "./orchestration-journal.ts";
import {
  isProviderSubagentRunId,
  type ForgeWorkOnController,
  type WorkOnLifecycleEvent,
} from "./work-on.ts";

const ORCHESTRATION_LINK_ENTRY = "forgedock-orchestration-link/v1";

export interface ActiveOrchestrationLink {
  orchestrationId: string;
  repository: string;
  repositoryRoot: string;
  stateBranch: string;
  issueNumbers: readonly number[];
  integrationBranch: string;
  maxConcurrent: number;
  leaseEpoch: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  status:
    | "running"
    | "completed"
    | "blocked"
    | "needs-human"
    | "failed"
    | "cancelled";
  sequence: number;
  lastHeartbeatAt: string;
}

export interface StartOrchestrationResult {
  orchestrationId: string;
  issueNumbers: readonly number[];
  maxConcurrent: number;
  integrationBranch: string;
}

export class ForgeOrchestrationController {
  readonly #pi: ExtensionAPI;
  readonly #workOn: ForgeWorkOnController;
  readonly #git: GitWorktreeManager;
  readonly #links = new Map<string, ActiveOrchestrationLink>();
  readonly #pumping = new Set<string>();
  readonly #pumpPending = new Set<string>();
  readonly #cancelling = new Set<string>();
  readonly #heartbeating = new Set<string>();
  readonly #lifecycleQueues = new Map<string, Promise<void>>();
  #lifecycleUnsubscribe: (() => void) | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #attachmentGeneration = 0;

  constructor(pi: ExtensionAPI, workOn: ForgeWorkOnController) {
    this.#pi = pi;
    this.#workOn = workOn;
    this.#git = new GitWorktreeManager({
      exec: (command, args, options) => pi.exec(command, [...args], options),
    });
  }

  async attach(ctx: ExtensionContext): Promise<void> {
    const generation = ++this.#attachmentGeneration;
    this.#restoreLinks(ctx);
    this.#lifecycleUnsubscribe?.();
    this.#lifecycleUnsubscribe = this.#workOn.onLifecycle((event) => {
      if (!event.orchestrationId) return;
      void this.#enqueueLifecycle(event, ctx);
    });
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeat(ctx, generation);
    }, 5_000);
    this.#heartbeatTimer.unref();
  }

  async resume(ctx: ExtensionContext): Promise<void> {
    for (const link of this.#links.values()) {
      if (link.status !== "running") continue;
      try {
        const snapshot = await this.#read(link, ctx.signal);
        this.#syncLink(link, snapshot.state);
        this.#persistLink(link);
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
    this.#attachmentGeneration += 1;
    this.#lifecycleUnsubscribe?.();
    this.#lifecycleUnsubscribe = undefined;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#heartbeating.clear();
    this.#pumpPending.clear();
    this.#cancelling.clear();
    this.#lifecycleQueues.clear();
  }

  async start(
    issueNumbers: readonly number[],
    ctx: ExtensionContext,
    options: {
      confirmExpiredTakeover?: (ownerRunId: string) => Promise<boolean>;
    } = {},
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
    const token = await resolveGitHubToken(this.#pi, repositoryRoot, ctx.signal);
    const store = new GitHubStateBranchStore(
      new FetchGitHubTransport({ token }),
      policy.repository.name,
      policy.state.branch,
    );
    const orchestrationId = randomUUID();
    await store.ensureBranch(new Date(), ctx.signal);
    const leaseProbe = await store.readOrchestration(
      orchestrationId,
      ctx.signal,
    );
    if (leaseProbe.lease && isLeaseExpired(leaseProbe.lease, new Date())) {
      const expiredId = leaseProbe.lease.ownerRunId;
      if (
        !options.confirmExpiredTakeover ||
        !(await options.confirmExpiredTakeover(expiredId))
      )
        throw new Error(
          `Repository lease ${expiredId} expired and requires confirmed takeover.`,
        );
      const expired = await store.readOrchestration(expiredId, ctx.signal);
      const takeoverReason = `Lease expired after its owning Pi session stopped heartbeating; takeover confirmed by operator session ${ctx.sessionManager.getSessionId()}.`;
      if (expired.state?.status === "running") {
        await this.#cancelDurableChildRuns(
          store,
          expired.state,
          ctx,
          takeoverReason,
          true,
        );
        await this.#workOn.stopOrchestration(expiredId, ctx, takeoverReason);
        await new OrchestrationJournal(store).cancel({
          orchestrationId: expiredId,
          reason: takeoverReason,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } else if (!expired.state) {
        await this.#workOn.cancelExpiredDirectRun(
          store,
          expiredId,
          ctx,
          takeoverReason,
        );
      } else {
        throw new Error(
          `Expired repository lease ${expiredId} has no cancellable active owner state.`,
        );
      }
    }
    const journal = new OrchestrationJournal(store);
    const initialized = await journal.initialize({
      orchestrationId,
      repository: policy.repository.name,
      issueNumbers,
      integrationBranch,
      maxConcurrent: policy.orchestration.maxConcurrent,
      sessionId: ctx.sessionManager.getSessionId(),
      leaseSeconds: policy.state.leaseSeconds,
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
      leaseEpoch: initialized.lease.epoch,
      leaseSeconds: policy.state.leaseSeconds,
      heartbeatSeconds: policy.state.heartbeatSeconds,
      status: "running",
      sequence: initialized.state.sequence,
      lastHeartbeatAt: initialized.lease.lastHeartbeatAt,
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

  list(): ActiveOrchestrationLink[] {
    return [...this.#links.values()].map((link) => ({
      ...link,
      issueNumbers: [...link.issueNumbers],
    }));
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
    const token = await resolveGitHubToken(
      this.#pi,
      repositoryRoot,
      ctx.signal,
    );
    const store = new GitHubStateBranchStore(
      new FetchGitHubTransport({ token }),
      policy.repository.name,
      policy.state.branch,
    );
    const link = this.#links.get(orchestrationId);
    if (this.#cancelling.has(orchestrationId))
      throw new Error(
        `Orchestration ${orchestrationId} cancellation is already in progress.`,
      );
    this.#cancelling.add(orchestrationId);
    try {
      await this.#workOn.quiesceOrchestration(orchestrationId);
      await this.#waitForPump(orchestrationId, ctx.signal);
      const current = await store.readOrchestration(
        orchestrationId,
        ctx.signal,
      );
      if (!current.state)
        throw new Error(`Orchestration ${orchestrationId} does not exist.`);
      const state = current.state;
      if (state.status !== "running") {
        if (link) {
          this.#syncLink(link, state);
          this.#persistLink(link);
        }
        return state;
      }
      if (!current.lease || current.lease.ownerRunId !== orchestrationId)
        throw new Error(
          `Orchestration ${orchestrationId} does not own the active repository lease.`,
        );
      const cancelled = await cancelChildrenBeforeParent({
        cancelChildren: async () => {
          await this.#cancelDurableChildRuns(store, state, ctx, reason);
          await this.#workOn.stopOrchestration(orchestrationId, ctx, reason);
        },
        cancelParent: () =>
          new OrchestrationJournal(store).cancel({
            orchestrationId,
            reason,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
      });
      if (link) {
        this.#syncLink(link, cancelled.state);
        this.#persistLink(link);
      }
      return cancelled.state;
    } catch (error) {
      if (link?.status === "running") {
        link.status = "needs-human";
        this.#persistLink(link);
      }
      throw error;
    } finally {
      this.#cancelling.delete(orchestrationId);
    }
  }

  async shutdown(ctx: ExtensionContext, reason: string): Promise<void> {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
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
    allowExpiredLease = false,
  ): Promise<void> {
    const childRunIds = new Set<string>();
    const childStates: RunState[] = [];
    const providerRunIds = new Set<string>();
    for (const lane of state.lanes) {
      if (lane.subagentRunId) providerRunIds.add(lane.subagentRunId);
    }
    for (const durableState of await store.listRunStates(ctx.signal)) {
      if (!isOwnedActiveChildRun(durableState, state)) continue;
      childRunIds.add(durableState.runId);
      childStates.push(durableState);
      for (const node of Object.values(durableState.nodes)) {
        if (node.subagentRunId) providerRunIds.add(node.subagentRunId);
      }
    }
    for (const runId of await this.#workOn.findProviderRunsForDurableStates(
      childStates,
    ))
      providerRunIds.add(runId);
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
          actorKind: "human",
          allowExpiredLease,
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
    // Durable cancellation revokes child authority. Provider cleanup is a
    // best-effort runtime projection and must not retain the repository lease.
    await this.#workOn
      .stopProviderRuns([...providerRunIds])
      .catch(() => undefined);
  }

  async #recoverFalseFailures(
    link: ActiveOrchestrationLink,
    state: OrchestrationState,
    ctx: ExtensionContext,
  ): Promise<void> {
    for (const lane of state.lanes) {
      if (this.#cancelling.has(link.orchestrationId)) return;
      if (
        !["failed", "blocked", "needs-human"].includes(lane.status) ||
        !lane.reason ||
        !/schema-valid Forge result artifact|State branch changed after|unsupported-continuation|WebSocket|timed? out|timeout|connection (?:lost|reset|error)|\b50[0234]\b|\b429\b|No comment found for marker.*FORGE:BUILDER/i.test(
          lane.reason,
        )
      )
        continue;
      if (this.#cancelling.has(link.orchestrationId)) return;
      const active = await this.#workOn.reactivateOrchestrationIssue(
        link.orchestrationId,
        lane.issueNumber,
      );
      if (this.#cancelling.has(link.orchestrationId)) {
        if (active)
          await this.#workOn
            .stopProviderRuns([active.subagentRunId])
            .catch(() => undefined);
        return;
      }
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
    if (!orchestrationId || this.#cancelling.has(orchestrationId)) return;
    const prior = this.#lifecycleQueues.get(orchestrationId) ?? Promise.resolve();
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
    if (!orchestrationId || this.#cancelling.has(orchestrationId)) return;
    const link = this.#links.get(orchestrationId);
    if (!link || link.status !== "running") return;
    let current = await this.#read(link, ctx.signal);
    let lane = current.state.lanes.find(
      (candidate) => candidate.issueNumber === event.issueNumber,
    );
    if (!lane || isTerminalLane(lane)) return;
    if (shouldBindQueuedLifecycle(lane, event)) {
      await current.journal.append({
        orchestrationId,
        type: "lane.started",
        payload: {
          issueNumber: event.issueNumber,
          forgeRunId: event.forgeRunId,
          subagentRunId: event.subagentRunId,
        },
        idempotencyKey: `lane:${event.issueNumber}:started`,
        message: `Bind issue ${event.issueNumber} before lifecycle reconciliation`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      current = await this.#read(link, ctx.signal);
      lane = current.state.lanes.find(
        (candidate) => candidate.issueNumber === event.issueNumber,
      );
      if (!lane || isTerminalLane(lane)) return;
    }
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
          payload: { issueNumber: event.issueNumber, reason: "Closed without code after invalid/decomposed investigation." },
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
    if (this.#cancelling.has(link.orchestrationId)) return;
    if (this.#pumping.has(link.orchestrationId)) {
      this.#pumpPending.add(link.orchestrationId);
      return;
    }
    this.#pumping.add(link.orchestrationId);
    try {
      let progress = true;
      while (
        progress &&
        link.status === "running" &&
        !this.#cancelling.has(link.orchestrationId)
      ) {
        progress = false;
        let current = await this.#read(link, ctx.signal);
        for (const lane of readyOrchestrationLanes(current.state)) {
          if (this.#cancelling.has(link.orchestrationId)) break;
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
              result = await this.#workOn.startIssue(
                lane.issueNumber,
                ctx,
                {
                  orchestrationId: link.orchestrationId,
                  leaseEpoch: link.leaseEpoch,
                },
              );
            } catch (error) {
              const recovered = this.#workOn.listRuns().find(
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
          if (!isPublishableLaneReceipt(result.subagentRunId)) {
            ctx.ui.notify(
              `ForgeDock issue #${lane.issueNumber} is still initializing; its lane will not publish internal receipt ${result.subagentRunId}.`,
              "warning",
            );
            return;
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

        if (this.#cancelling.has(link.orchestrationId)) break;
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

        if (this.#cancelling.has(link.orchestrationId)) break;
        current = await this.#read(link, ctx.signal);
        if (current.state.lanes.every(isTerminalLane)) {
          const completed = await current.journal.complete({
            orchestrationId: link.orchestrationId,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          this.#syncLink(link, completed.state);
          link.lastHeartbeatAt = completed.lease.lastHeartbeatAt;
          this.#persistLink(link);
          ctx.ui.setStatus("forgedock", undefined);
          ctx.ui.notify(
            renderCompletion(completed.state),
            completed.state.status === "completed" ? "info" : "warning",
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

  async #waitForPump(
    orchestrationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    while (
      this.#pumping.has(orchestrationId) ||
      this.#lifecycleQueues.has(orchestrationId)
    ) {
      if (signal?.aborted)
        throw signal.reason ?? new Error("Orchestration cancellation aborted.");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  async #heartbeat(
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    if (generation !== this.#attachmentGeneration) return;
    const now = new Date();
    for (const link of this.#links.values()) {
      if (generation !== this.#attachmentGeneration) break;
      if (
        link.status !== "running" ||
        this.#cancelling.has(link.orchestrationId)
      )
        continue;
      if (
        now.getTime() - Date.parse(link.lastHeartbeatAt) <
          link.heartbeatSeconds * 1_000 ||
        this.#heartbeating.has(link.orchestrationId)
      )
        continue;
      this.#heartbeating.add(link.orchestrationId);
      try {
        const { journal } = await this.#read(link, ctx.signal);
        const result = await journal.heartbeat({
          orchestrationId: link.orchestrationId,
          sessionId: ctx.sessionManager.getSessionId(),
          leaseSeconds: link.leaseSeconds,
          now,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (generation !== this.#attachmentGeneration) return;
        link.lastHeartbeatAt = result.lease.lastHeartbeatAt;
        link.sequence = result.state.sequence;
        this.#persistLink(link);
      } catch (error) {
        if (generation === this.#attachmentGeneration) {
          // Retry at the configured heartbeat cadence instead of every timer
          // tick. The durable lease timestamp is unchanged until a write wins.
          link.lastHeartbeatAt = now.toISOString();
          ctx.ui.notify(
            `ForgeDock orchestration ${link.orchestrationId} heartbeat failed: ${errorMessage(error)}`,
            "warning",
          );
        }
      } finally {
        this.#heartbeating.delete(link.orchestrationId);
      }
    }
  }

  async #read(
    link: ActiveOrchestrationLink,
    signal?: AbortSignal,
  ): Promise<{
    state: OrchestrationState;
    journal: OrchestrationJournal;
  }> {
    const token = await resolveGitHubToken(
      this.#pi,
      link.repositoryRoot,
      signal,
    );
    const store = new GitHubStateBranchStore(
      new FetchGitHubTransport({ token }),
      link.repository,
      link.stateBranch,
    );
    const current = await store.readOrchestration(
      link.orchestrationId,
      signal,
    );
    if (!current.state)
      throw new Error(
        `Orchestration ${link.orchestrationId} is missing authoritative state.`,
      );
    return { state: current.state, journal: new OrchestrationJournal(store) };
  }

  #syncLink(
    link: ActiveOrchestrationLink,
    state: OrchestrationState,
  ): void {
    link.status = state.status;
    link.sequence = state.sequence;
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

export function isOwnedActiveChildRun(
  run: RunState | undefined,
  orchestration: Pick<
    OrchestrationState,
    "orchestrationId" | "leaseEpoch"
  >,
): run is RunState {
  return Boolean(
    run &&
      run.leaseBinding?.ownerRunId === orchestration.orchestrationId &&
      run.leaseBinding.epoch === orchestration.leaseEpoch &&
      run.status !== "completed" &&
      run.status !== "cancelled",
  );
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
    !Number.isSafeInteger(link.leaseEpoch) ||
    !Number.isSafeInteger(link.leaseSeconds) ||
    !Number.isSafeInteger(link.heartbeatSeconds) ||
    typeof link.status !== "string" ||
    !Number.isSafeInteger(link.sequence) ||
    typeof link.lastHeartbeatAt !== "string"
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

export async function cancelChildrenBeforeParent<T>(input: {
  cancelChildren: () => Promise<void>;
  cancelParent: () => Promise<T>;
}): Promise<T> {
  await input.cancelChildren();
  return input.cancelParent();
}

export function isPublishableLaneReceipt(runId: string): boolean {
  return isProviderSubagentRunId(runId);
}

export function shouldBindQueuedLifecycle(
  lane: { status: string; forgeRunId?: string },
  event: { forgeRunId: string; subagentRunId: string },
): boolean {
  return (
    lane.status === "queued" &&
    !lane.forgeRunId &&
    Boolean(event.forgeRunId) &&
    isPublishableLaneReceipt(event.subagentRunId)
  );
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

function requiredNumber(
  value: number | undefined,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1)
    throw new Error(`Work-on lifecycle event is missing ${field}.`);
  return value as number;
}

function isRetryableSetupError(error: unknown): boolean {
  return /forge policy|config\.json|integration branch|remote ref|couldn['’]t find remote ref|repository setup/i.test(
    errorMessage(error),
  );
}

function normalizeReason(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
