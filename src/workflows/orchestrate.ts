import { createHash, randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  FetchGitHubTransport,
  githubRateLimitReservations,
  GITHUB_CONTROL_PLANE_MIN_RESERVE,
  GITHUB_LANE_ESTIMATED_REQUEST_COST,
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
  blockedOrchestrationLanes,
  isTerminalLane,
  nextIntegrationLane,
  readyOrchestrationLanes,
  type OrchestrationDependencyEdge,
  type OrchestrationState,
} from "../core/orchestration.ts";
import {
  canPromoteIntegrationLane,
  createIntegrationLane,
  normalizeIntegrationSlug,
  type IntegrationLane,
  type IntegrationLanePromotionReceipt,
  type IntegrationLaneStagingEvidence,
  validatePromotionQueue,
} from "../core/integration-lane.ts";
import {
  orchestrationChildKey,
  planOrchestrationReload,
  renderOrchestrationReloadReport,
  type RetainedOrchestrationChild,
} from "../core/orchestration-recovery.ts";
import { isLeaseExpired } from "../core/lease.ts";
import { isGitHubCiRequired, isProtectedBranch, type ForgePolicy } from "../core/policy.ts";
import { OrchestrationJournal } from "./orchestration-journal.ts";
import {
  isTransientProviderFailure,
  type ActiveRunLink,
  type ForgeWorkOnController,
  type WorkOnLifecycleEvent,
} from "./work-on.ts";

const ORCHESTRATION_LINK_ENTRY = "forgedock-orchestration-link/v1";

/** Build the durable work-order binding from one frozen deployed-main SHA. */
export function createWorkOrderLane(input: {
  slug: string;
  repository: string;
  issueNumbers: readonly number[];
  frozenBaseSha: string;
  stableId?: string;
  now?: string;
}): IntegrationLane {
  const slug = normalizeIntegrationSlug(input.slug);
  const now = input.now ?? new Date().toISOString();
  return createIntegrationLane({
    kind: "work-order",
    stableId: input.stableId ?? `wo-${slug}`,
    slug,
    repository: input.repository,
    frozenBase: { branch: "main", sha: input.frozenBaseSha },
    membership: input.issueNumbers.map((issueNumber, ordinal) => ({ issueNumber, ordinal })),
    sourceQuery: `work-order:${slug}`,
    createdAt: now,
    updatedAt: now,
    status: "active",
    promotion: {},
  });
}

/** Select the only lane allowed to promote from a durable queue snapshot. */
export function selectPromotionQueueHead(
  lanes: readonly IntegrationLane[],
): IntegrationLane | undefined {
  validatePromotionQueue(lanes);
  return [...lanes]
    .filter((lane) => ["ready", "syncing", "promoting"].includes(lane.status))
    .sort((left, right) =>
      (left.promotion.queuePosition ?? Number.MAX_SAFE_INTEGER) -
        (right.promotion.queuePosition ?? Number.MAX_SAFE_INTEGER),
    )[0];
}

export interface WorkOrderPromotionGateInput {
  lane: IntegrationLane;
  ownerId: string;
  now: string;
  sourceHeadSha: string;
  mergeBaseSha: string;
  staging: IntegrationLaneStagingEvidence;
  reviewPassed: boolean;
  verificationPassed: boolean;
  mergeable: boolean;
  authorityValid: boolean;
  mergeCommit: boolean;
  queueHeadLaneId?: string;
}

/**
 * Controller-facing pure gate. It intentionally returns evidence rather than
 * throwing so callers can persist a durable blocked reason and resume safely.
 */
export function evaluateWorkOrderPromotion(
  input: WorkOrderPromotionGateInput,
): { allowed: true; laneId: string } | { allowed: false; reason: string } {
  const result = canPromoteIntegrationLane(input.lane, input);
  return result.ok
    ? { allowed: true, laneId: input.lane.stableId }
    : { allowed: false, reason: result.reason };
}

export function workOrderPromotionReceipt(input: {
  shippingPullNumber: number;
  sourceHeadSha: string;
  stagingBaseSha: string;
  mergeBaseSha: string;
  mergeCommitSha: string;
  reviewedAt: string;
}): IntegrationLanePromotionReceipt {
  return { ...input, mergeMethod: "merge" };
}

function laneReservationKey(
  orchestrationId: string,
  issueNumber: number,
): string {
  return `${orchestrationId}:${issueNumber}`;
}

function isTerminalLifecycleStatus(
  status: WorkOnLifecycleEvent["status"],
): boolean {
  return ["completed", "blocked", "needs-human", "failed"].includes(status);
}

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

export interface StartOrchestrationOptions {
  /** Explicitly scope this orchestration to a durable work-order lane. */
  workOrderSlug?: string;
}

export interface StartOrchestrationResult {
  orchestrationId: string;
  issueNumbers: readonly number[];
  maxConcurrent: number;
  integrationBranch: string;
  integrationLane?: IntegrationLane;
}

export interface OrchestrationStatusSnapshot {
  link: ActiveOrchestrationLink;
  state?: OrchestrationState;
  error?: string;
}

export class ForgeOrchestrationController {
  readonly #priorInvalidVerdicts = new Map<string, boolean>();
  readonly #gateGithub = new Map<string, GitHubWorkflowAdapter>();

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
    // Zero-touch crash recovery: when configured, adopt orphaned campaigns
    // (every active lane's lease expired) directly at session start.
    void loadForgePolicy(ctx.cwd)
      .then(({ policy }) =>
        policy.orchestration.autoAdopt
          ? this.adoptOrphaned(ctx).then((ids) => {
              if (ids.length > 0)
                ctx.ui.notify(
                  `ForgeDock adopted orphaned orchestration(s): ${ids.join(", ")}`,
                  "info",
                );
            })
          : undefined,
      )
      .catch((error) =>
        ctx.ui.notify(
          `ForgeDock orphan adoption failed: ${errorMessage(error)}`,
          "warning",
        ),
      );
    this.#lifecycleUnsubscribe?.();
    this.#lifecycleUnsubscribe = this.#workOn.onLifecycle((event) => {
      if (!event.orchestrationId) return;
      void this.#enqueueLifecycle(event, ctx);
    });
  }

  /** Lazily built adapter for dispatch-gate and adoption side effects. */
  #githubFor(link: ActiveOrchestrationLink): GitHubWorkflowAdapter {
    let adapter = this.#gateGithub.get(link.orchestrationId);
    if (!adapter) {
      const tokenProvider = createGitHubTokenProvider(
        this.#pi,
        link.repositoryRoot,
      );
      adapter = new GitHubWorkflowAdapter(
        new FetchGitHubTransport({ tokenProvider }),
        link.repository,
      );
      this.#gateGithub.set(link.orchestrationId, adapter);
    }
    return adapter;
  }

  /**
   * Consume durable prior verdicts before dispatch: an issue already
   * adjudicated invalid/no-change (FORGE:INVALID / FORGE:COMMIT:NO-CHANGE)
   * must be closed, never re-built.
   */
  async #priorInvalidVerdict(
    link: ActiveOrchestrationLink,
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const key = `${link.orchestrationId}:${issueNumber}`;
    const cached = this.#priorInvalidVerdicts.get(key);
    if (cached !== undefined) return cached;
    const verdict = await this.#githubFor(link)
      .hasInvalidVerdictMarker(issueNumber, signal)
      .catch(() => false);
    this.#priorInvalidVerdicts.set(key, verdict);
    return verdict;
  }

  /**
   * Adopt orphaned orchestrations whose owning session is gone: every active
   * lane's run lease must be expired (the liveness signal), after which lanes
   * are re-armed via human-authorized takeover, finishable lanes are
   * reconciled to merge, and non-finishable lanes fail with labels cleared so
   * the next campaign re-dispatches them. Returns the adopted ids.
   */
  async adoptOrphaned(ctx: ExtensionContext): Promise<string[]> {
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
    const listed = await store.listOrchestrations(ctx.signal);
    const adopted: string[] = [];
    for (const { orchestrationId, state: persisted } of listed) {
      if (!persisted || persisted.status !== "running") continue;
      if (this.#links.has(orchestrationId)) continue;
      const activeLanes = persisted.lanes.filter((lane) =>
        ["running", "ready", "integrating"].includes(lane.status),
      );
      const promotionPending = Boolean(
        persisted.integrationLane?.kind === "work-order" &&
        !persisted.integrationLane.legacy &&
        persisted.lanes.length > 0 &&
        persisted.lanes.every((lane) => ["integrated", "merged", "closed"].includes(lane.status)),
      );
      if (activeLanes.length === 0 && !promotionPending) continue;
      // Owner-liveness gate: adopt only when EVERY active lane's run lease
      // has expired. Live-owned campaigns are left to their owner.
      const liveness: boolean[] = [];
      for (const lane of activeLanes) {
        if (!lane.forgeRunId) {
          liveness.push(false);
          continue;
        }
        const run = await store.readRun(lane.forgeRunId, ctx.signal);
        const lease = run.state?.lease;
        liveness.push(lease ? !isLeaseExpired(lease, new Date()) : false);
      }
      if (liveness.some(Boolean)) continue;
      const link: ActiveOrchestrationLink = {
        orchestrationId,
        repository: persisted.repository,
        repositoryRoot,
        stateBranch: policy.state.branch,
        issueNumbers: persisted.lanes.map((lane) => lane.issueNumber),
        integrationBranch: persisted.integrationBranch,
        maxConcurrent: persisted.maxConcurrent,
        status: "running",
      };
      this.#links.set(orchestrationId, link);
      adopted.push(orchestrationId);
      for (const lane of activeLanes) {
        if (!lane.forgeRunId) continue;
        let event: WorkOnLifecycleEvent | undefined;
        try {
          event = await this.#workOn.adoptOrphanedRun({
            orchestrationId,
            forgeRunId: lane.forgeRunId,
            subagentRunId: lane.subagentRunId ?? "",
            repositoryRoot,
            ctx,
          });
        } catch {
          event = undefined;
        }
        if (event) {
          await this.#handleLifecycle(event, ctx);
          continue;
        }
        await this.#failOrphanedLane(
          store,
          link,
          { issueNumber: lane.issueNumber, forgeRunId: lane.forgeRunId },
          ctx,
        );
      }
      await this.#pump(link, ctx);
    }
    return adopted;
  }

  /** Fail a non-finishable orphan lane durably and restore dispatch eligibility. */
  async #failOrphanedLane(
    store: GitHubStateBranchStore,
    link: ActiveOrchestrationLink,
    lane: { issueNumber: number; forgeRunId: string },
    ctx: ExtensionContext,
  ): Promise<void> {
    const reason =
      "Orphaned: the work-on child was lost before completion and no durable result could be reconstructed; the issue is re-dispatched by the next campaign.";
    await new OrchestrationJournal(store).append({
      orchestrationId: link.orchestrationId,
      type: "lane.failed",
      payload: { issueNumber: lane.issueNumber, reason },
      idempotencyKey: `lane:${lane.issueNumber}:orphaned`,
      message: `Fail orphaned lane for issue ${lane.issueNumber}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    await new RunJournal(store).append({
      runId: lane.forgeRunId,
      type: "run.cancelled",
      payload: { reason },
      idempotencyKey: "run:cancelled",
      sessionId: ctx.sessionManager.getSessionId(),
      message: `Cancel orphaned ForgeDock run ${lane.forgeRunId}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const adapter = this.#githubFor(link);
    await adapter
      .removeIssueLabels(
        lane.issueNumber,
        ["workflow:building", "workflow:in-review", "workflow:ready-to-build", "needs-human", "staging-review"],
        ctx.signal,
      )
      .catch(() => undefined);
  }

  async resume(ctx: ExtensionContext): Promise<void> {
    await this.adoptOrphaned(ctx).catch((error) =>
      ctx.ui.notify(
        `ForgeDock orphan adoption failed: ${errorMessage(error)}`,
        "warning",
      ),
    );
    for (const link of this.#links.values()) {
      if (link.status !== "running") continue;
      try {
        let snapshot = await this.#read(link, ctx.signal);
        this.#syncLink(link, snapshot.state);
        this.#persistLink(link);
        await this.#recoverFalseFailures(link, snapshot.state, ctx);
        snapshot = await this.#read(link, ctx.signal);
        const reloadPlan = planOrchestrationReload({
          state: snapshot.state,
          retainedChildren: retainedChildrenForReload(
            snapshot.state,
            this.#workOn.listRuns(),
          ),
        });
        if (reloadPlan.paused) {
          ctx.ui.notify(
            renderOrchestrationReloadReport(reloadPlan),
            "warning",
          );
          continue;
        }
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
    options: StartOrchestrationOptions = {},
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
    const workOrderSlug = options.workOrderSlug?.trim();
    if (options.workOrderSlug !== undefined && !workOrderSlug)
      throw new Error("Work-order slug must be non-empty.");
    let integrationLane: IntegrationLane | undefined;
    let integrationBranch: string;
    if (workOrderSlug) {
      const slug = normalizeIntegrationSlug(workOrderSlug);
      // A work-order is based on deployed production, never the active
      // staging integration branch. The protected ref is policy-bound and
      // must include the configured production name `main`.
      const deployedMain = policy.branches.protected.find(
        (branch) => branch === "main",
      );
      if (!deployedMain)
        throw new Error("Work-order routing requires protected branch main.");
      const frozenBaseSha = await this.#git.remoteBaseSha(
        repositoryRoot,
        deployedMain,
        ctx.signal,
      );
      const stableId = `wo-${slug}-${createHash("sha256")
        .update(JSON.stringify(issueNumbers))
        .digest("hex")
        .slice(0, 8)}`;
      integrationLane = createWorkOrderLane({
        slug,
        stableId,
        repository: policy.repository.name,
        issueNumbers,
        frozenBaseSha,
      });
      integrationBranch = integrationLane.branch;
      if (isProtectedBranch(policy, integrationBranch))
        throw new Error(`Work-order branch ${integrationBranch} is protected.`);
      await this.#git.ensureRemoteBranchAt(
        repositoryRoot,
        integrationBranch,
        frozenBaseSha,
        ctx.signal,
      );
    } else {
      integrationBranch = chooseIntegrationBranch(policy);
      if (isProtectedBranch(policy, integrationBranch))
        throw new Error(`Integration branch ${integrationBranch} is protected.`);
      await this.#git.remoteBaseSha(
        repositoryRoot,
        integrationBranch,
        ctx.signal,
      );
    }
    const tokenProvider = createGitHubTokenProvider(this.#pi, repositoryRoot);
    const transport = new FetchGitHubTransport({
        tokenProvider,
        repository: policy.repository.name,
      });
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
      ...(integrationLane ? { lane: integrationLane } : {}),
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
      ...(integrationLane ? { integrationLane } : {}),
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

  /**
   * Complete the lane-level promotion after all member PRs are integrated.
   * Callers supply freshly verified provider evidence; this method persists
   * every gate before closing members or deleting the lane branch.
   */
  async #promotionQueueHead(
    store: GitHubStateBranchStore,
    orchestrationId: string,
    current: OrchestrationState,
    signal?: AbortSignal,
  ): Promise<IntegrationLane | undefined> {
    const records = await store.listOrchestrations(signal);
    const lanes: IntegrationLane[] = [];
    for (const record of records) {
      const state = record.orchestrationId === orchestrationId
        ? current
        : (await store.readOrchestration(record.orchestrationId, signal)).state;
      const lane = state?.integrationLane;
      if (lane?.kind === "work-order" && !lane.legacy) lanes.push(lane);
    }
    return lanes.length > 0 ? selectPromotionQueueHead(lanes) : undefined;
  }

  async #tryPromoteCompletedWorkOrder(
    link: ActiveOrchestrationLink,
    state: OrchestrationState,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    const lane = state.integrationLane;
    if (!lane || lane.kind !== "work-order" || lane.legacy) return false;
    if (!state.lanes.every((member) => ["integrated", "merged", "closed"].includes(member.status))) return false;
    if (lane.status === "promoted" || lane.status === "closed") {
      if (lane.status === "closed" && state.lanes.every((member) => member.status === "closed")) return false;
      const receipt = lane.promotion.receipt;
      const staging = lane.promotion.stagingEvidence;
      const stagingReadbackSha = lane.promotion.stagingReadbackSha;
      if (!receipt || !staging || !stagingReadbackSha) return false;
      await this.promoteWorkOrder({
        orchestrationId: link.orchestrationId,
        ownerId: receipt.sourceHeadSha,
        queuePosition: lane.promotion.queuePosition ?? 0,
        staging,
        stagingReadbackSha,
        sourceHeadSha: receipt.sourceHeadSha,
        mergeBaseSha: receipt.mergeBaseSha,
        shippingPullNumber: receipt.shippingPullNumber,
        mergeCommitSha: receipt.mergeCommitSha,
        reviewedAt: receipt.reviewedAt,
        reviewPassed: true,
        verificationPassed: true,
        mergeable: true,
        authorityValid: true,
        ctx,
      });
      return true;
    }
    // The normal completion path is an explicit evidence-producing caller: it
    // may promote only when the update-in-place shipping PR, its exact review,
    // CI, mergeability, and current staging readback are all available. It
    // never invents a passing gate when any provider evidence is absent.
    const github = this.#githubFor(link);
    const stagingBranch = github.configuredStagingToMainRoute().headRef;
    const shippingPull = await github.findPullRequest(lane.branch, ctx.signal);
    if (!shippingPull || shippingPull.baseRef !== stagingBranch || shippingPull.mergeability !== "mergeable") return false;
    const stagingSha = await github.getBranchHeadSha(stagingBranch, ctx.signal);
    if (shippingPull.baseSha !== stagingSha && !shippingPull.merged) return false;
    const comments = await github.getComments(shippingPull.number, ctx.signal);
    const reviewed = comments.some((body) => body.includes("FORGE:REVIEW_SUMMARY") && body.includes(shippingPull.headSha) && /Decision:\s+APPROVED|Verdict:\s+PASS/.test(body));
    if (!reviewed) return false;
    const policy = (await loadForgePolicy(link.repositoryRoot)).policy;
    const checks = isGitHubCiRequired(policy, shippingPull.baseRef)
      ? await github.waitForPullRequestChecks({ headSha: shippingPull.headSha, baseBranch: shippingPull.baseRef, timeoutMs: policy.verification.github.waitTimeoutMs, pollIntervalMs: policy.verification.github.pollIntervalMs, ...(ctx.signal ? { signal: ctx.signal } : {}) })
      : undefined;
    const verificationPassed = checks === undefined || (!checks.timedOut && checks.checks.every((check) => !check.required || check.status === "passed"));
    if (!verificationPassed) return false;
    const now = new Date().toISOString();
    const staging = { branch: stagingBranch, sha: stagingSha, baselineSha: lane.frozenBase.sha, idle: true, checkedAt: now };
    await this.promoteWorkOrder({
      orchestrationId: link.orchestrationId,
      ownerId: link.orchestrationId,
      queuePosition: lane.promotion.queuePosition ?? 0,
      staging,
      stagingReadbackSha: stagingSha,
      sourceHeadSha: shippingPull.headSha,
      mergeBaseSha: stagingSha,
      shippingPullNumber: shippingPull.number,
      mergeCommitSha: shippingPull.mergeCommitSha ?? "",
      reviewedAt: now,
      reviewPassed: true,
      verificationPassed,
      mergeable: true,
      authorityValid: true,
      readPromotionEvidence: async (latestState) => {
        const latestLane = latestState.integrationLane;
        const latestLease = latestLane?.promotion.queueLease;
        if (!latestLane || !latestLease || latestLease.ownerId !== link.orchestrationId)
          throw new Error("Promotion lease authority changed during provider evidence read.");
        const latestStagingSha = await github.getBranchHeadSha(stagingBranch, ctx.signal);
        return {
          ownerId: latestLease.ownerId,
          queueHeadLaneId: latestLane.stableId,
          leaseEpoch: latestLease.epoch,
          staging: { branch: stagingBranch, sha: latestStagingSha, baselineSha: latestLane.frozenBase.sha, idle: true, checkedAt: new Date().toISOString() },
          stagingReadbackSha: latestStagingSha,
        };
      },
      ctx,
    });
    return true;
  }

  async promoteWorkOrder(input: {
    orchestrationId: string;
    ownerId: string;
    queuePosition: number;
    staging: IntegrationLaneStagingEvidence;
    stagingReadbackSha: string;
    sourceHeadSha: string;
    mergeBaseSha: string;
    shippingPullNumber: number;
    mergeCommitSha: string;
    reviewedAt: string;
    reviewPassed: boolean;
    verificationPassed: boolean;
    mergeable: boolean;
    authorityValid: boolean;
    /** Re-read provider staging, idle, ownership, and lease evidence per CAS attempt. */
    readPromotionEvidence?: (state: OrchestrationState) => Promise<{
      ownerId: string;
      queueHeadLaneId: string;
      leaseEpoch: number;
      staging: IntegrationLaneStagingEvidence;
      stagingReadbackSha: string;
    }>;
    ctx: ExtensionContext;
  }): Promise<OrchestrationState> {
    const link = this.#links.get(input.orchestrationId);
    if (!link) throw new Error(`Unknown orchestration ${input.orchestrationId}.`);
    const current = await this.#read(link, input.ctx.signal);
    const initialLane = current.state.integrationLane;
    if (!initialLane || initialLane.kind !== "work-order" || initialLane.legacy)
      throw new Error("Only typed work-order lanes can be promoted automatically.");
    if (!current.state.lanes.every((member) => ["integrated", "merged", "closed"].includes(member.status)))
      throw new Error("Work-order promotion requires every member PR to be lane-integrated.");
    let state = current.state;
    const journal = current.journal;
    const github = this.#githubFor(link);
    const stagingBranch = github.configuredStagingToMainRoute().headRef;
    const laneState = state.integrationLane;
    if (!laneState) throw new Error("Durable integration lane disappeared during promotion.");
    const alreadyPromoted = laneState.status === "promoted" || laneState.status === "closed";
    const promotionInFlight = laneState.status === "promoting";
    if (!alreadyPromoted) {
      if (!promotionInFlight && state.integrationLane?.promotion.queuePosition === undefined) {
        state = await journal.queueLane({ orchestrationId: input.orchestrationId, laneId: initialLane.stableId, queuePosition: input.queuePosition, signal: input.ctx.signal });
      }
      const currentLane = state.integrationLane;
      if (!currentLane) throw new Error("Durable integration lane disappeared during queueing.");
      const priorEpoch = currentLane.promotion.queueLease?.epoch ?? 0;
      const authorizationNow = new Date().toISOString();
      const leaseExpired = currentLane.promotion.queueLease !== undefined &&
        new Date(currentLane.promotion.queueLease.expiresAt).getTime() <= Date.parse(authorizationNow);
      if (!promotionInFlight && (currentLane.status === "ready" || (currentLane.status === "syncing" && leaseExpired))) {
        state = await journal.acquireLaneQueueLease({ orchestrationId: input.orchestrationId, laneId: initialLane.stableId, ownerId: input.ownerId, leaseSeconds: 900, attempt: priorEpoch + 1, signal: input.ctx.signal });
      }
      const leaseEpoch = state.integrationLane?.promotion.queueLease?.epoch;
      if (!leaseEpoch) throw new Error("Promotion queue lease was not acquired.");
      if (!input.readPromotionEvidence)
        throw new Error("Promotion requires a provider evidence reader for every durable CAS attempt.");
      if (!promotionInFlight && state.integrationLane?.status === "syncing") {
        state = await journal.syncLane({ orchestrationId: input.orchestrationId, laneId: initialLane.stableId, ownerId: input.ownerId, leaseEpoch, staging: input.staging, signal: input.ctx.signal });
      }
      const shippingPull = await github.getPullRequest(input.shippingPullNumber, input.ctx.signal);
      if (shippingPull.headRef !== initialLane.branch ||
          shippingPull.baseRef !== stagingBranch ||
          shippingPull.headSha !== input.sourceHeadSha ||
          (!shippingPull.merged && shippingPull.baseSha !== input.staging.sha) ||
          (shippingPull.merged && (!shippingPull.mergeCommitSha ||
            (input.mergeCommitSha && shippingPull.mergeCommitSha !== input.mergeCommitSha))))
        throw new Error("Shipping PR route, exact head/base, or staging evidence does not match promotion authority.");

      // Re-read provider evidence, then durable queue authority, immediately
      // before the irreversible merge. A changed owner, epoch, queue head, or
      // staging baseline must abort without touching the shipping PR.
      const preMergeEvidence = await input.readPromotionEvidence(state);
      const preMergeStagingSha = await github.getBranchHeadSha(stagingBranch, input.ctx.signal);
      const durableBeforeMerge = await this.#read(link, input.ctx.signal);
      const durableLane = durableBeforeMerge.state.integrationLane;
      const durableQueueHead = await this.#promotionQueueHead(durableBeforeMerge.store, input.orchestrationId, durableBeforeMerge.state, input.ctx.signal);
      const persistedStaging = durableLane?.promotion.stagingEvidence;
      const durableLease = durableLane?.promotion.queueLease;
      const replayingMergedPromotion = promotionInFlight && shippingPull.merged;
      if (!durableLane || (durableLane.status !== "ready" && durableLane.status !== "promoting") ||
          !durableLease || durableLease.ownerId !== input.ownerId ||
          durableLease.epoch !== leaseEpoch ||
          !durableQueueHead || durableQueueHead.stableId !== initialLane.stableId ||
          preMergeEvidence.ownerId !== input.ownerId ||
          preMergeEvidence.queueHeadLaneId !== durableQueueHead.stableId ||
          preMergeEvidence.leaseEpoch !== leaseEpoch ||
          preMergeEvidence.staging.branch !== stagingBranch ||
          preMergeStagingSha !== preMergeEvidence.staging.sha ||
          !persistedStaging ||
          persistedStaging.branch !== preMergeEvidence.staging.branch ||
          (!replayingMergedPromotion && persistedStaging.sha !== preMergeEvidence.staging.sha) ||
          (replayingMergedPromotion && persistedStaging.sha !== input.staging.sha) ||
          (replayingMergedPromotion && shippingPull.mergeCommitSha !== preMergeStagingSha))
        throw new Error("Promotion authority or provider staging evidence changed before the shipping merge.");
      const promotionStaging = replayingMergedPromotion ? persistedStaging : preMergeEvidence.staging;
      state = durableBeforeMerge.state;
      const gate = evaluateWorkOrderPromotion({ lane: durableLane, ownerId: input.ownerId, now: authorizationNow, sourceHeadSha: input.sourceHeadSha, mergeBaseSha: input.mergeBaseSha, staging: promotionStaging, reviewPassed: input.reviewPassed, verificationPassed: input.verificationPassed, mergeable: input.mergeable, authorityValid: input.authorityValid, mergeCommit: true, queueHeadLaneId: durableQueueHead.stableId });
      if (!gate.allowed) throw new Error(`Work-order promotion gated: ${gate.reason}`);
      if (!promotionInFlight)
        state = await journal.beginPromotion({ orchestrationId: input.orchestrationId, laneId: initialLane.stableId, ownerId: input.ownerId, queueHeadLaneId: durableQueueHead.stableId, leaseEpoch, staging: preMergeEvidence.staging, signal: input.ctx.signal });
      const shippingMerge = await github.mergePullRequest({
        pullNumber: input.shippingPullNumber,
        expectedRoute: {
          pullNumber: shippingPull.number,
          headRef: shippingPull.headRef,
          headSha: shippingPull.headSha,
          baseRef: shippingPull.baseRef,
          baseSha: promotionStaging.sha,
        },
        method: "merge",
        ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
      });
      if (!shippingMerge.merged || !/^[0-9a-f]{40}$/i.test(shippingMerge.sha) ||
          (input.mergeCommitSha && input.mergeCommitSha !== shippingMerge.sha))
        throw new Error("Shipping merge did not return the exact merge commit SHA.");
      const receipt = workOrderPromotionReceipt({ shippingPullNumber: input.shippingPullNumber, sourceHeadSha: input.sourceHeadSha, stagingBaseSha: promotionStaging.sha, mergeBaseSha: input.mergeBaseSha, mergeCommitSha: shippingMerge.sha, reviewedAt: input.reviewedAt });
      const finalStagingSha = await github.getBranchHeadSha(stagingBranch, input.ctx.signal);
      if (finalStagingSha !== shippingMerge.sha)
        throw new Error("Protected staging must read back the exact SHA returned by the shipping merge operation.");
      state = await journal.promoteLane({
        orchestrationId: input.orchestrationId,
        laneId: initialLane.stableId,
        ownerId: input.ownerId,
        queueHeadLaneId: durableQueueHead.stableId,
        leaseEpoch,
        staging: promotionStaging,
        stagingReadbackSha: finalStagingSha,
        receipt,
        reviewPassed: input.reviewPassed,
        verificationPassed: input.verificationPassed,
        mergeable: input.mergeable,
        authorityValid: input.authorityValid,
        mergeCommit: true,
        readPromotionEvidence: async (latestState) => {
          const evidence = await input.readPromotionEvidence!(latestState);
          if (evidence.ownerId !== input.ownerId ||
              evidence.queueHeadLaneId !== durableQueueHead.stableId ||
              evidence.leaseEpoch !== leaseEpoch ||
              evidence.staging.branch !== preMergeEvidence.staging.branch ||
              evidence.staging.sha !== receipt.mergeCommitSha ||
              evidence.stagingReadbackSha !== receipt.mergeCommitSha)
            throw new Error("Protected staging moved during promotion CAS; fresh review and queue evidence are required.");
          return { ...evidence, staging: promotionStaging, stagingReadbackSha: receipt.mergeCommitSha };
        },
        ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
      });
    }
    const lane = state.integrationLane!;
    for (const member of lane.membership) await github.closeIssue(member.issueNumber, input.ctx.signal);
    await github.deleteBranch(lane.branch, input.ctx.signal);
    if (state.integrationLane?.status === "promoted")
      state = await journal.closeLane({ orchestrationId: input.orchestrationId, laneId: lane.stableId, signal: input.ctx.signal });
    for (const member of state.lanes.filter((candidate) => candidate.status === "integrated" || candidate.status === "merged"))
      state = await journal.append({ orchestrationId: input.orchestrationId, type: "lane.closed", payload: { issueNumber: member.issueNumber, reason: `Work-order lane ${lane.stableId} promoted to staging.` }, idempotencyKey: `lane:${member.issueNumber}:closed-after-promotion`, message: `Close promoted work-order member ${member.issueNumber}`, ...(input.ctx.signal ? { signal: input.ctx.signal } : {}) });
    return state;
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
      new FetchGitHubTransport({
        tokenProvider,
        repository: policy.repository.name,
      }),
      policy.repository.name,
      policy.state.branch,
    );
    const current = await store.readOrchestration(orchestrationId, ctx.signal);
    if (!current.state)
      throw new Error(`Orchestration ${orchestrationId} does not exist.`);
    if (current.state.status !== "running") return current.state;
    const lane = current.state.integrationLane;
    if (lane?.status === "promoting")
      throw new Error("Cannot cancel while work-order promotion is in flight; resume the fenced promotion.");
    await this.#cancelDurableChildRuns(store, current.state, ctx, reason);
    const cancellationJournal = new OrchestrationJournal(store);
    const laneLease = lane?.promotion.queueLease;
    if (laneLease) {
      await cancellationJournal.releaseLaneQueueLease({
        orchestrationId,
        laneId: current.state.integrationLane!.stableId,
        ownerId: laneLease.ownerId,
        leaseEpoch: laneLease.epoch,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    }
    if (lane && !lane.legacy && ["queued", "active", "ready", "syncing"].includes(lane.status)) {
      const removed = await cancellationJournal.append({
        orchestrationId,
        type: "integration-lane.blocked",
        payload: { laneId: lane.stableId, reason: `Orchestration cancelled: ${reason}` },
        idempotencyKey: `integration-lane:${lane.stableId}:cancelled`,
        message: `Remove cancelled integration lane ${lane.stableId} from promotion queue`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (removed.integrationLane?.status !== "blocked")
        throw new Error("Cancelled orchestration did not durably remove its lane from the promotion queue.");
    }
    await this.#workOn.stopOrchestration(orchestrationId, ctx, reason);
    const cancelled = await cancellationJournal.cancel({
      orchestrationId,
      reason,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const link = this.#links.get(orchestrationId);
    if (link) {
      this.#syncLink(link, cancelled);
      this.#persistLink(link);
    }
    githubRateLimitReservations.releaseOrchestration(
      policy.repository.name,
      orchestrationId,
    );
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
    if (!lane || isTerminalLane(lane)) {
      if (isTerminalLifecycleStatus(event.status))
        githubRateLimitReservations.release(
          link.repository,
          laneReservationKey(orchestrationId, event.issueNumber),
        );
      return;
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
      if (event.laneIntegrated) {
        await journal.append({
          orchestrationId,
          type: "lane.integrated",
          payload: {
            issueNumber: event.issueNumber,
            headSha: required(event.headSha, "headSha"),
            baseSha: required(event.baseSha, "baseSha"),
          },
          idempotencyKey: `lane:${event.issueNumber}:integrated`,
          message: `Record issue ${event.issueNumber} integrated into its work-order lane`,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } else if (event.outcome === "closed") {
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
    if (isTerminalLifecycleStatus(event.status))
      githubRateLimitReservations.release(
        link.repository,
        laneReservationKey(orchestrationId, event.issueNumber),
      );
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
        const dependencyBlocks = blockedOrchestrationLanes(current.state);
        if (dependencyBlocks.length > 0) {
          // Persist one event per dependent lane. Re-reading after each event
          // makes transitive blocks durable and keeps evidence deterministic
          // under concurrent lifecycle notifications.
          for (const blocked of dependencyBlocks) {
            const state = await current.journal.append({
              orchestrationId: link.orchestrationId,
              type: "lane.blocked",
              payload: {
                issueNumber: blocked.lane.issueNumber,
                reason: blocked.reason,
              },
              idempotencyKey: `lane:${blocked.lane.issueNumber}:dependency-blocked`,
              message: `Block issue ${blocked.lane.issueNumber} on failed dependency #${blocked.blockedBy.issueNumber}`,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            current = { ...current, state };
          }
          progress = true;
          continue;
        }
        githubRateLimitReservations.synchronize(
          link.repository,
          link.orchestrationId,
          activeReservationIssueNumbers(current.state),
        );
        const readyQueue = readyOrchestrationLanes(
          current.state,
          current.state.maxConcurrent,
        );
        const effectiveConcurrency =
          readyQueue.length === 0
            ? current.state.maxConcurrent
            : await this.#effectiveConcurrency(
                link,
                current.state.maxConcurrent,
                activeReservationIssueNumbers(current.state).length,
                ctx.signal,
              );
        for (const lane of readyOrchestrationLanes(
          current.state,
          effectiveConcurrency,
        )) {
          const reservation = githubRateLimitReservations.tryReserve(
            link.repository,
            laneReservationKey(link.orchestrationId, lane.issueNumber),
          );
          if (!reservation) break;
          if (
            await this.#priorInvalidVerdict(link, lane.issueNumber, ctx.signal)
          ) {
            reservation.release();
            await current.journal.append({
              orchestrationId: link.orchestrationId,
              type: "lane.closed",
              payload: {
                issueNumber: lane.issueNumber,
                reason:
                  "Prior durable invalid/no-change verdict for this finding; closed invalid instead of re-building.",
              },
              idempotencyKey: `lane:${lane.issueNumber}:closed-prevalidated`,
              message: `Close pre-validated invalid issue ${lane.issueNumber}`,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            const gateGithub = this.#githubFor(link);
            await gateGithub
              .postIssueComment(
                lane.issueNumber,
                "<!-- FORGE:INVALID -->\nClosed invalid: a prior run durably adjudicated this finding (FORGE:COMMIT:NO-CHANGE / FORGE:INVALID). Re-build skipped by dispatch gate.",
                ctx.signal,
              )
              .catch(() => undefined);
            await gateGithub.closeIssue(lane.issueNumber, ctx.signal).catch(
              () => undefined,
            );
            progress = true;
            current = await this.#read(link, ctx.signal);
            continue;
          }
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
                reservation.release();
                ctx.ui.notify(
                  `ForgeDock orchestration ${link.orchestrationId} is paused before issue #${lane.issueNumber}: ${normalizeReason(errorMessage(error), "Repository setup is incomplete.")} Run /forge:init, then it will resume the queued lanes.`,
                  "warning",
                );
                return;
              } else {
                reservation.release();
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
            reservation.release();
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
          let integrationError: unknown;
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              await this.#workOn.integrateIssue(integration.forgeRunId, ctx);
              integrationError = undefined;
              break;
            } catch (error) {
              integrationError = error;
              if (
                attempt === 3 ||
                !isTransientProviderFailure(errorMessage(error))
              )
                break;
              await orchestrationDelay(2_000 * 2 ** (attempt - 1), ctx.signal);
            }
          }
          if (integrationError) {
            const latest = await this.#read(link, ctx.signal);
            await latest.journal.append({
              orchestrationId: link.orchestrationId,
              type: "lane.failed",
              payload: {
                issueNumber: integration.issueNumber,
                reason: normalizeReason(
                  errorMessage(integrationError),
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
        if (current.state.integrationLane?.status === "promoted" || current.state.lanes.every((member) => ["integrated", "merged", "closed"].includes(member.status))) {
          try {
            if (await this.#tryPromoteCompletedWorkOrder(link, current.state, ctx)) {
              progress = true;
              continue;
            }
          } catch (error) {
            ctx.ui.notify(`ForgeDock work-order promotion is awaiting durable evidence: ${errorMessage(error)}`, "warning");
            return;
          }
          if (
            current.state.integrationLane?.kind === "work-order" &&
            current.state.integrationLane.status !== "promoted" &&
            current.state.integrationLane.status !== "closed"
          ) {
            ctx.ui.notify("ForgeDock work-order promotion is gated: independent review, verification, authority, and staging-idle evidence are required.", "warning");
            return;
          }
        }
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
    activeReservations: number,
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
          new FetchGitHubTransport({
            tokenProvider,
            repository: link.repository,
          }),
          signal,
          link.repository,
        );
        cached = { checkedAt: now, budget };
        this.#rateBudgets.set(link.repository, cached);
      } else {
        githubRateLimitReservations.update(link.repository, cached.budget);
      }
      const available = githubRateLimitReservations.availableSlots(
        link.repository,
        GITHUB_CONTROL_PLANE_MIN_RESERVE,
        GITHUB_LANE_ESTIMATED_REQUEST_COST,
      );
      const concurrency = Math.min(
        configuredMax,
        activeReservations + available,
      );
      if (concurrency > activeReservations || activeReservations > 0)
        return concurrency;
      await githubRateLimitReservations.waitForCapacity(
        link.repository,
        signal,
      );
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
      new FetchGitHubTransport({
        tokenProvider,
        repository: link.repository,
      }),
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
    if (state.status !== "running")
      githubRateLimitReservations.releaseOrchestration(
        link.repository,
        link.orchestrationId,
      );
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

export class ExternalIssueDependencyError extends Error {
  readonly code = "external-dependency" as const;
  readonly issueNumber: number;
  readonly blockerIssueNumber: number;

  constructor(issueNumber: number, blockerIssueNumber: number) {
    super(
      `Cannot dispatch orchestration: issue #${issueNumber} is blocked by unselected external issue #${blockerIssueNumber}. Select #${blockerIssueNumber} or resolve the GitHub dependency before dispatching.`,
    );
    this.name = "ExternalIssueDependencyError";
    this.issueNumber = issueNumber;
    this.blockerIssueNumber = blockerIssueNumber;
  }
}

export async function discoverIssueDependencies(
  github: Pick<GitHubWorkflowAdapter, "listIssueBlockedBy">,
  issueNumbers: readonly number[],
  signal?: AbortSignal,
): Promise<OrchestrationDependencyEdge[]> {
  const confirmed = new Set(issueNumbers);
  const dependencies: OrchestrationDependencyEdge[] = [];
  for (const issueNumber of issueNumbers) {
    const blockers = await github.listIssueBlockedBy(issueNumber, signal);
    for (const blocker of blockers) {
      if (!confirmed.has(blocker))
        throw new ExternalIssueDependencyError(issueNumber, blocker);
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
      reject(signal?.reason ?? new Error("Integration retry aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (typeof timer === "object" && timer !== null && "unref" in timer)
      (timer as { unref: () => void }).unref();
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

function retainedChildrenForReload(
  state: OrchestrationState,
  runs: readonly Pick<
    ActiveRunLink,
    "orchestrationId" | "issueNumber" | "status" | "forgeRunId" | "prepared" | "leaseEpoch"
  >[],
): RetainedOrchestrationChild[] {
  return runs
    .filter((run) => run.orchestrationId === state.orchestrationId)
    .map((run) => ({
      childKey:
        state.batch?.childKeys[String(run.issueNumber)] ??
        orchestrationChildKey(state.orchestrationId, run.issueNumber),
      issueNumber: run.issueNumber,
      status: (run.status === "completed"
        ? "completed"
        : run.status === "failed"
          ? "failed"
          : "running") as RetainedOrchestrationChild["status"],
      forgeRunId: run.forgeRunId,
      ...(state.integrationLane
        ? {
            laneId: state.integrationLane.stableId,
            // Compare immutable lane authority on reload, not the child
            // worktree's moving integration tip.
            baseSha: state.integrationLane.frozenBase.sha,
            leaseEpoch: run.leaseEpoch,
          }
        : {}),
    }));
}

function activeReservationIssueNumbers(
  state: Pick<OrchestrationState, "lanes">,
): number[] {
  return state.lanes
    .filter((lane) =>
      ["running", "ready", "refreshing", "integrating"].includes(
        lane.status,
      ),
    )
    .map((lane) => lane.issueNumber);
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
