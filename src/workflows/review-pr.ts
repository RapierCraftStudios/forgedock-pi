import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadForgePolicy } from "../adapters/config.ts";
import {
  GitWorktreeManager,
  type PreparedReviewWorktree,
} from "../adapters/git.ts";
import { FetchGitHubTransport } from "../adapters/github-api.ts";
import { createGitHubTokenProvider } from "../adapters/github-auth.ts";
import { GitHubStateBranchStore } from "../adapters/github-state.ts";
import {
  GitHubWorkflowAdapter,
  type GitHubPullRequestRouteSnapshot,
  type MergeResult,
} from "../adapters/github-workflow.ts";
import { ReviewJournal } from "../adapters/review-journal.ts";
import {
  SubagentsRpcClient,
  type SubagentSpawnReceipt,
} from "../adapters/subagents.ts";
import { isPathWithin } from "../agents/child-containment.ts";
import {
  waitForReviewerResult,
  type ExpectedReviewerResult,
} from "../agents/child-runtime.ts";
import type {
  ForgeReviewFindingResult,
  ForgeReviewerResult,
} from "../agents/contracts.ts";
import { materializeForgeAgents } from "../agents/materialize.ts";
import {
  evaluateReviewGate,
  type FinalReviewDecision,
  type ReviewFinding,
  type VerificationResult,
} from "../core/review.ts";
import type {
  ReviewMode,
  ReviewRoster,
  ReviewState,
} from "../core/review-state.ts";
import {
  canAutoMerge,
  isGitHubCiRequired,
  resolveConcreteBranch,
} from "../core/policy.ts";
import type {
  ParsedReviewArguments,
  ReviewSelector,
} from "../ui/forge-command-parser.ts";
import { publishReviewFindingIssues } from "./review-findings.ts";

export type ReviewExecution =
  | { kind: "standalone"; repositoryRoot: string }
  | { kind: "work-on"; worktreePath: string };

export interface ReviewPrRequest {
  reviewId: string;
  repository: string;
  pullNumber: number;
  issueNumber?: number;
  mode?: ReviewMode;
  route?: GitHubPullRequestRouteSnapshot;
  roster: ReviewRoster;
  execution: ReviewExecution;
  round?: number;
  reviewerTimeoutMs: number;
  githubCheckTimeoutMs: number;
  githubCheckPollIntervalMs: number;
  githubChecksRequired: boolean;
  additionalChecks?: readonly VerificationResult[];
  malformedResults?: readonly string[];
  mergeability?: "mergeable" | "conflicting" | "unknown";
  protectedBranches: readonly string[];
  autoMergeAuthorized: boolean;
  autoMergeRequested: boolean;
  /** Resume may reconcile a terminal GitHub merge against an old route snapshot. */
  resume?: boolean;
  authorityValid?: () => boolean | Promise<boolean>;
  reviewerContext?: string;
  signal?: AbortSignal;
}

export interface ReviewPrResult {
  reviewId: string;
  pullNumber: number;
  route: GitHubPullRequestRouteSnapshot;
  state: ReviewState;
  decision: FinalReviewDecision;
  findings: readonly ForgeReviewFindingResult[];
  checks: readonly VerificationResult[];
  findingIssues: Readonly<Record<string, number>>;
  merged: boolean;
  mergeSha?: string;
}

export interface ReviewPanelRunInput {
  reviewId: string;
  repository: string;
  pullNumber: number;
  issueNumber?: number;
  worktreePath: string;
  route: GitHubPullRequestRouteSnapshot;
  reviewers: readonly string[];
  round: number;
  reviewerTimeoutMs: number;
  context?: string;
  signal?: AbortSignal;
}

export interface ReviewPanelRunner {
  run(input: ReviewPanelRunInput): Promise<readonly ForgeReviewerResult[]>;
  cancel?(reviewId: string): Promise<void>;
}

export interface ReviewPrCoordinatorDependencies {
  github: GitHubWorkflowAdapter;
  journal: ReviewJournal;
  git: GitWorktreeManager;
  panel: ReviewPanelRunner;
  materializeAgents?: (worktreePath: string) => Promise<readonly string[]>;
}

/**
 * Shared, parent-owned PR review workflow. Work-on and standalone commands call
 * this typed entrypoint; reviewer children remain read-only and never publish
 * GitHub effects or authorize a merge.
 */
export class ReviewPrCoordinator {
  readonly #github: GitHubWorkflowAdapter;
  readonly #journal: ReviewJournal;
  readonly #git: GitWorktreeManager;
  readonly #panel: ReviewPanelRunner;
  readonly #materializeAgents: (
    worktreePath: string,
  ) => Promise<readonly string[]>;

  constructor(dependencies: ReviewPrCoordinatorDependencies) {
    this.#github = dependencies.github;
    this.#journal = dependencies.journal;
    this.#git = dependencies.git;
    this.#panel = dependencies.panel;
    this.#materializeAgents =
      dependencies.materializeAgents ?? materializeForgeAgents;
  }

  async review(input: ReviewPrRequest): Promise<ReviewPrResult> {
    assertRequest(input);
    const mode = input.mode ?? "standard";
    if (mode === "staging" && input.autoMergeRequested)
      throw new Error("Staging review cannot merge or deploy.");

    const route =
      input.route ??
      (await this.#github.getPullRequestRouteSnapshot(
        input.pullNumber,
        input.signal,
      ));
    if (route.pullNumber !== input.pullNumber)
      throw new Error("Review route pull request does not match the request.");
    const resumedPull = input.resume
      ? await this.#github.getPullRequest(input.pullNumber, input.signal)
      : undefined;
    const alreadyMergedOnResume = resumedPull?.merged === true;
    if (!alreadyMergedOnResume)
      await this.#github.revalidatePullRequestRoute(route, input.signal);

    let snapshot = await this.#journal.initialize({
      reviewId: input.reviewId,
      repository: input.repository,
      pullNumber: input.pullNumber,
      ...(input.issueNumber === undefined
        ? {}
        : { issueNumber: input.issueNumber }),
      mode,
      headRef: route.headRef,
      headSha: route.headSha,
      baseRef: route.baseRef,
      baseSha: route.baseSha,
      roster: input.roster,
      route,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (snapshot.state.status === "cancelled")
      throw new Error(`Review ${input.reviewId} is cancelled.`);
    if (snapshot.state.status === "completed")
      return completedResult(snapshot.state, route);

    if (alreadyMergedOnResume) {
      if (!snapshot.state.mergeAuthorization?.authorized)
        throw new Error(
          "Already-merged review resume lacks durable merge authorization.",
        );
      const merge = await this.#mergeAuthorized(input, route);
      snapshot = await this.#journal.append({
        reviewId: input.reviewId,
        type: "review.completed",
        payload: {
          round: requirePanelRound(snapshot.state),
          outcome: "merged",
          reason: `Reconciled already-merged PR as ${merge.sha}`,
        },
        idempotencyKey: "review:completed",
        message: `Reconcile already-merged review ${input.reviewId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return completedResult(snapshot.state, route, merge);
    }

    await this.#github.postPullArtifact({
      pullNumber: route.pullNumber,
      marker: reviewRouteMarker(input.reviewId, route),
      body: renderReviewRoute(
        input.reviewId,
        mode,
        route,
        input.roster.reviewers,
      ),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (snapshot.state.mergeAuthorization?.authorized) {
      const merge = await this.#mergeAuthorized(input, route);
      snapshot = await this.#journal.append({
        reviewId: input.reviewId,
        type: "review.completed",
        payload: {
          round: requirePanelRound(snapshot.state),
          outcome: "merged",
          reason: `Merged as ${merge.sha}`,
        },
        idempotencyKey: "review:completed",
        message: `Complete merged review ${input.reviewId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return completedResult(snapshot.state, route, merge);
    }

    let prepared: PreparedReviewWorktree | undefined;
    const worktreePath =
      input.execution.kind === "standalone"
        ? (prepared = await this.#git.prepareReview(
            input.execution.repositoryRoot,
            {
              reviewId: input.reviewId,
              headRef: route.headRef,
              headSha: route.headSha,
              baseRef: route.baseRef,
              baseSha: route.baseSha,
              ...(input.signal ? { signal: input.signal } : {}),
            },
          )).worktreePath
        : input.execution.worktreePath;

    try {
      const localHead = await this.#git.head(worktreePath, input.signal);
      if (localHead !== route.headSha)
        throw new Error(
          `Review worktree head ${localHead} does not match frozen PR head ${route.headSha}.`,
        );
      await this.#materializeAgents(worktreePath);
      snapshot = await this.#runPanelIfNeeded(
        snapshot.state,
        input,
        route,
        worktreePath,
      );
      if (snapshot.state.panel?.status === "running") {
        const additionalChecks: readonly VerificationResult[] = [
          {
            name: "material-change",
            required: true,
            status: route.headSha === route.baseSha ? "failed" : "passed",
          },
          ...(input.additionalChecks ?? []),
        ];
        for (const [index, check] of additionalChecks.entries()) {
          snapshot = await this.#journal.append({
            reviewId: input.reviewId,
            type: "review.check-recorded",
            payload: { round: requirePanelRound(snapshot.state), check },
            idempotencyKey: `check:additional:${index}:${stableKey(check.name)}`,
            message: `Record additional check ${check.name} for ${input.reviewId}`,
            ...(input.signal ? { signal: input.signal } : {}),
          });
        }
      }

      const ci = await this.#github.waitForPullRequestChecks({
        headSha: route.headSha,
        baseBranch: route.baseRef,
        timeoutMs: input.githubCheckTimeoutMs,
        pollIntervalMs: input.githubCheckPollIntervalMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const githubChecks = normalizeGitHubChecks(
        ci,
        input.githubChecksRequired,
      );
      if (snapshot.state.panel?.status === "running") {
        for (const [index, check] of githubChecks.entries()) {
          snapshot = await this.#journal.append({
            reviewId: input.reviewId,
            type: "review.check-recorded",
            payload: { round: requirePanelRound(snapshot.state), check },
            idempotencyKey: `check:github:${index}:${stableKey(check.name)}`,
            message: `Record GitHub check ${check.name} for ${input.reviewId}`,
            ...(input.signal ? { signal: input.signal } : {}),
          });
        }
        const round = requirePanelRound(snapshot.state);
        snapshot = await this.#journal.append({
          reviewId: input.reviewId,
          type: "review.panel-completed",
          payload: {
            round,
            completedReviewers: input.roster.reviewers,
          },
          idempotencyKey: `panel:${round}:complete`,
          message: `Complete review panel ${input.reviewId}`,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      }

      const currentPull = await this.#github.revalidatePullRequestRoute(
        route,
        input.signal,
      );
      const authorityValid = await (input.authorityValid?.() ?? true);
      const findings = snapshot.state.findings as readonly ReviewFinding[];
      let decision = evaluateReviewGate({
        identity: {
          repository: input.repository,
          runId: input.reviewId,
          pullRequest: route.pullNumber,
          headSha: route.headSha,
          baseSha: route.baseSha,
          rosterVersion: input.roster.version,
        },
        currentHeadSha: currentPull.headSha,
        currentBaseSha: currentPull.baseSha,
        requiredReviewers: input.roster.reviewers,
        completedReviewers: snapshot.state.panel?.completedReviewers ?? [],
        findings,
        checks: snapshot.state.checks,
        mergeability: input.mergeability ?? currentPull.mergeability,
        leaseValid: authorityValid,
        baseBranch: route.baseRef,
        protectedBranches: mode === "staging" ? [] : input.protectedBranches,
        autoMergeAuthorized:
          mode === "staging" ? true : input.autoMergeAuthorized,
        ...(input.malformedResults
          ? { malformedResults: input.malformedResults }
          : {}),
      });
      if (mode === "staging") {
        const unresolved = (
          await this.#github.listIssuesByLabel(
            "review-finding",
            "open",
            input.signal,
          )
        ).filter((issue) =>
          issue.body.includes(`source-pr=${route.pullNumber}`),
        );
        decision = strictStagingDecision(
          decision,
          snapshot.state.findings as readonly ForgeReviewFindingResult[],
          unresolved.map((issue) => issue.number),
        );
      }

      snapshot = await this.#journal.append({
        reviewId: input.reviewId,
        type: "review.verdict-recorded",
        payload: {
          round: requirePanelRound(snapshot.state),
          decision: decision.decision,
          headSha: decision.headSha,
          baseSha: decision.baseSha,
          reasons: decision.reasons,
          blockingFindingIds: decision.blockingFindingIds,
          followUpFindingIds: decision.followUpFindingIds,
        },
        idempotencyKey: "review:verdict",
        message: `Record review verdict for ${input.reviewId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const passed =
        decision.decision === "approved" ||
        decision.decision === "approved-with-follow-ups";
      snapshot = await this.#journal.append({
        reviewId: input.reviewId,
        type: "review.gate-recorded",
        payload: {
          round: requirePanelRound(snapshot.state),
          decision: decision.decision,
          passed,
          headSha: decision.headSha,
          baseSha: decision.baseSha,
          reasons: decision.reasons,
        },
        idempotencyKey: "review:gate",
        message: `Record review gate for ${input.reviewId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });

      const forgeFindings = snapshot.state
        .findings as readonly ForgeReviewFindingResult[];
      const findingIssues = await publishReviewFindingIssues({
        github: this.#github,
        pullNumber: route.pullNumber,
        link: {
          forgeRunId: input.reviewId,
          ...(input.issueNumber === undefined
            ? {}
            : { issueNumber: input.issueNumber }),
          repository: input.repository,
        },
        result: {
          review: { headSha: route.headSha, findings: forgeFindings },
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      await this.#github.postPullArtifact({
        pullNumber: route.pullNumber,
        marker: reviewSummaryMarker(input.reviewId, route.headSha),
        body: renderReviewSummary(decision, forgeFindings, findingIssues),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (mode === "staging") {
        const marker = passed
          ? `<!-- FORGE:GATE_PASS id=${input.reviewId} head=${route.headSha} -->`
          : `<!-- FORGE:GATE_FAILURE id=${input.reviewId} head=${route.headSha} -->`;
        await this.#github.postPullArtifact({
          pullNumber: route.pullNumber,
          marker,
          body: renderStagingGate(
            decision,
            snapshot.state.checks,
            forgeFindings,
          ),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      }

      let merge: MergeResult | undefined;
      if (input.autoMergeRequested && passed) {
        if (mode !== "standard" || !input.autoMergeAuthorized)
          throw new Error(
            "Review passed, but this route is not authorized for automatic merge.",
          );
        await this.#github.revalidatePullRequestRoute(route, input.signal);
        snapshot = await this.#journal.append({
          reviewId: input.reviewId,
          type: "review.merge-authorized",
          payload: {
            round: requirePanelRound(snapshot.state),
            authorized: true,
            headSha: route.headSha,
            baseSha: route.baseSha,
            authorizedBy: "review-pr-coordinator",
          },
          idempotencyKey: "review:merge-authorization",
          message: `Authorize merge for ${input.reviewId}`,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        merge = await this.#mergeAuthorized(input, route);
      }

      snapshot = await this.#journal.append({
        reviewId: input.reviewId,
        type: "review.completed",
        payload: {
          round: requirePanelRound(snapshot.state),
          outcome: merge ? "merged" : "reviewed",
          ...(merge ? { reason: `Merged as ${merge.sha}` } : {}),
        },
        idempotencyKey: "review:completed",
        message: `Complete review ${input.reviewId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        reviewId: input.reviewId,
        pullNumber: route.pullNumber,
        route,
        state: snapshot.state,
        decision,
        findings: forgeFindings,
        checks: snapshot.state.checks,
        findingIssues,
        merged: Boolean(merge),
        ...(merge ? { mergeSha: merge.sha } : {}),
      };
    } finally {
      if (prepared) await this.#git.cleanupReview(prepared, input.signal);
    }
  }

  async cancel(
    reviewId: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<ReviewState> {
    const current = await this.#journal.read(reviewId, signal);
    if (!current) throw new Error(`Review ${reviewId} does not exist.`);
    if (current.state.status !== "active") return current.state;
    await this.#panel.cancel?.(reviewId);
    const snapshot = await this.#journal.append({
      reviewId,
      type: "review.cancelled",
      payload: { reason },
      idempotencyKey: "review:cancel",
      message: `Cancel review ${reviewId}`,
      ...(signal ? { signal } : {}),
    });
    return snapshot.state;
  }

  async #runPanelIfNeeded(
    initial: ReviewState,
    input: ReviewPrRequest,
    route: GitHubPullRequestRouteSnapshot,
    worktreePath: string,
  ): Promise<Awaited<ReturnType<ReviewJournal["append"]>>> {
    let state = initial;
    const requestedRound = input.round ?? state.panel?.round ?? 1;
    let snapshot = await this.#journal.read(input.reviewId, input.signal);
    if (!snapshot) throw new Error(`Review ${input.reviewId} disappeared.`);
    if (!state.panel) {
      snapshot = await this.#journal.append({
        reviewId: input.reviewId,
        type: "review.panel-started",
        payload: { round: requestedRound, reviewers: input.roster.reviewers },
        idempotencyKey: `panel:${requestedRound}:start`,
        message: `Start review panel ${input.reviewId} round ${requestedRound}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      state = snapshot.state;
    }
    if (state.panel?.round !== requestedRound)
      throw new Error(
        `Active review round ${state.panel?.round} does not match requested round ${requestedRound}.`,
      );
    if (state.panel.status === "completed") return snapshot;

    const findingsKey = `panel:${requestedRound}:findings`;
    if (!state.idempotencyKeys[findingsKey]) {
      const results = await this.#panel.run({
        reviewId: input.reviewId,
        repository: input.repository,
        pullNumber: input.pullNumber,
        ...(input.issueNumber === undefined
          ? {}
          : { issueNumber: input.issueNumber }),
        worktreePath,
        route,
        reviewers: input.roster.reviewers,
        round: requestedRound,
        reviewerTimeoutMs: input.reviewerTimeoutMs,
        ...(input.reviewerContext ? { context: input.reviewerContext } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const normalized = normalizePanelResults(
        results,
        input.reviewId,
        route.headSha,
        input.roster.reviewers,
      );
      for (const [index, result] of normalized.results.entries()) {
        const check: VerificationResult = {
          name: `reviewer:${result.reviewer}`,
          required: true,
          status:
            result.verdict === "blocked"
              ? "failed"
              : result.limitations.length > 0
                ? "unknown"
                : "passed",
        };
        snapshot = await this.#journal.append({
          reviewId: input.reviewId,
          type: "review.check-recorded",
          payload: { round: requestedRound, check },
          idempotencyKey: `check:reviewer:${index}:${stableKey(result.reviewer)}`,
          message: `Record reviewer ${result.reviewer} for ${input.reviewId}`,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        await this.#github.postPullArtifact({
          pullNumber: route.pullNumber,
          marker: reviewerMarker(
            input.reviewId,
            result.reviewer,
            requestedRound,
            route.headSha,
          ),
          body: renderReviewerResult(result),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      }
      snapshot = await this.#journal.append({
        reviewId: input.reviewId,
        type: "review.findings-recorded",
        payload: { round: requestedRound, findings: normalized.findings },
        idempotencyKey: findingsKey,
        message: `Record review findings for ${input.reviewId}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
    return snapshot;
  }

  async #mergeAuthorized(
    input: ReviewPrRequest,
    route: GitHubPullRequestRouteSnapshot,
  ): Promise<MergeResult> {
    if ((input.mode ?? "standard") !== "standard")
      throw new Error("Only standard review can merge.");
    if (!input.autoMergeRequested || !input.autoMergeAuthorized)
      throw new Error("Merge is not explicitly and structurally authorized.");
    if (!(await (input.authorityValid?.() ?? true)))
      throw new Error("Review authority changed before merge.");
    return this.#github.mergePullRequest({
      pullNumber: route.pullNumber,
      expectedRoute: route,
      method: "squash",
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
}

export class SubagentReviewPanelRunner implements ReviewPanelRunner {
  readonly #rpc: SubagentsRpcClient;
  readonly #active = new Map<string, SubagentSpawnReceipt[]>();

  constructor(rpc: SubagentsRpcClient) {
    this.#rpc = rpc;
  }

  async run(
    input: ReviewPanelRunInput,
  ): Promise<readonly ForgeReviewerResult[]> {
    await this.#rpc.ping();
    const receipts: Array<{
      receipt: SubagentSpawnReceipt;
      expected: ExpectedReviewerResult;
    }> = [];
    this.#active.set(input.reviewId, []);
    try {
      const launched = await Promise.all(
        input.reviewers.map(async (reviewer) => {
          const receipt = await this.#rpc.spawnStandaloneReviewNode({
            reviewId: input.reviewId,
            repository: input.repository,
            pullNumber: input.pullNumber,
            ...(input.issueNumber === undefined
              ? {}
              : { issueNumber: input.issueNumber }),
            worktreeRoot: input.worktreePath,
            headRef: input.route.headRef,
            headSha: input.route.headSha,
            baseRef: input.route.baseRef,
            baseSha: input.route.baseSha,
            reviewer,
            round: input.round,
            reviewerTimeoutMs: input.reviewerTimeoutMs,
            ...(input.context ? { context: input.context } : {}),
          });
          const entry = {
            receipt,
            expected: {
              runId: input.reviewId,
              headSha: input.route.headSha,
              reviewer,
            },
          };
          receipts.push(entry);
          this.#active.get(input.reviewId)?.push(receipt);
          return entry;
        }),
      );
      return await Promise.all(
        launched.map(({ receipt, expected }) =>
          waitForReviewerResult(
            this.#rpc,
            receipt,
            input.reviewerTimeoutMs,
            expected,
            input.worktreePath,
            input.signal,
          ),
        ),
      );
    } catch (error) {
      await Promise.allSettled(
        receipts.map(({ receipt }) => this.#rpc.stop(receipt.runId)),
      );
      throw error;
    } finally {
      this.#active.delete(input.reviewId);
    }
  }

  async cancel(reviewId: string): Promise<void> {
    const receipts = this.#active.get(reviewId) ?? [];
    await Promise.allSettled(
      receipts.map((receipt) => this.#rpc.stop(receipt.runId)),
    );
    this.#active.delete(reviewId);
  }
}

export interface StandaloneReviewRunSummary {
  reviewId: string;
  pullNumber: number;
  status: ReviewState["status"];
  decision?: FinalReviewDecision["decision"];
  merged: boolean;
}

interface ReviewControllerEnvironment {
  repositoryRoot: string;
  policy: Awaited<ReturnType<typeof loadForgePolicy>>["policy"];
  github: GitHubWorkflowAdapter;
  journal: ReviewJournal;
}

/** Session-facing adapter for the standalone command surface. */
export class ForgeReviewController {
  readonly #pi: ExtensionAPI;
  readonly #git: GitWorktreeManager;
  readonly #panel: SubagentReviewPanelRunner;
  readonly #linked = new Map<string, StandaloneReviewRunSummary>();

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
    this.#panel = new SubagentReviewPanelRunner(new SubagentsRpcClient(pi));
    this.#git = new GitWorktreeManager({
      exec: async (command, args, options) =>
        pi.exec(command, [...args], {
          ...(options?.cwd ? { cwd: options.cwd } : {}),
          ...(options?.timeout ? { timeout: options.timeout } : {}),
          ...(options?.env ? { env: options.env } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
    });
  }

  list(): readonly StandaloneReviewRunSummary[] {
    return [...this.#linked.values()];
  }

  async start(
    parsed: ParsedReviewArguments,
    ctx: ExtensionContext,
    mode: ReviewMode = "standard",
  ): Promise<readonly ReviewPrResult[]> {
    if (parsed.ghFlags.length > 0)
      throw new Error(
        "--gh-flag is not supported by the typed GitHub adapter; no flag was executed.",
      );
    const environment = await this.#environment(ctx);
    // A route selector chooses the PR, not the execution policy. Only the
    // staging command explicitly opts into the non-merging staging mode.
    const effectiveMode: ReviewMode = mode;
    const pulls = await environment.github.resolveReviewSelector(
      selectorValue(parsed.selector),
      ctx.signal,
    );
    if (pulls.length === 0)
      throw new Error("No pull requests matched the review selector.");
    if (parsed.selector.kind === "route" && pulls.length !== 1)
      throw new Error(
        `Configured review route matched ${pulls.length} pull requests; expected exactly one.`,
      );
    const results = await Promise.all(
      pulls.map(async (pull) => {
        if (parsed.base !== undefined && pull.baseRef !== parsed.base)
          throw new Error(
            `PR #${pull.number} targets ${pull.baseRef}, not requested base ${parsed.base}.`,
          );
        const route = await environment.github.getPullRequestRouteSnapshot(
          pull.number,
          ctx.signal,
        );
        const reviewId = `review-${randomUUID()}`;
        const execution: ReviewExecution = parsed.worktree
          ? {
              kind: "work-on",
              worktreePath: await resolveReviewWorktree(
                environment.repositoryRoot,
                parsed.worktree,
              ),
            }
          : { kind: "standalone", repositoryRoot: environment.repositoryRoot };
        const coordinator = this.#coordinator(environment);
        this.#linked.set(reviewId, {
          reviewId,
          pullNumber: pull.number,
          status: "active",
          merged: false,
        });
        const result = await coordinator.review({
          reviewId,
          repository: environment.policy.repository.name,
          pullNumber: pull.number,
          ...(parsed.issueNumber === undefined
            ? {}
            : { issueNumber: parsed.issueNumber }),
          mode: effectiveMode,
          route,
          roster: {
            version:
              effectiveMode === "staging" || parsed.thorough
                ? "forgedock.review-roster/thorough-v1"
                : "forgedock.review-roster/v1",
            reviewers: commandReviewers(
              environment.policy.review.required,
              effectiveMode,
              parsed.thorough,
            ),
          },
          execution,
          reviewerTimeoutMs: environment.policy.subagents.reviewerTimeoutMs,
          githubCheckTimeoutMs:
            environment.policy.verification.github.waitTimeoutMs,
          githubCheckPollIntervalMs:
            environment.policy.verification.github.pollIntervalMs,
          githubChecksRequired: isGitHubCiRequired(
            environment.policy,
            pull.baseRef,
          ),
          protectedBranches: environment.policy.branches.protected,
          autoMergeAuthorized: canAutoMerge(environment.policy, pull.baseRef),
          autoMergeRequested: parsed.autoMerge,
          reviewerContext: parsed.thorough
            ? "Thorough mode: inspect the complete patch across every affected domain and report all confidence levels."
            : "Inspect the complete frozen patch and report all confidence levels.",
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        this.#linked.set(reviewId, {
          reviewId,
          pullNumber: pull.number,
          status: result.state.status,
          decision: result.decision.decision,
          merged: result.merged,
        });
        return result;
      }),
    );
    return results.sort((left, right) => left.pullNumber - right.pullNumber);
  }

  async cancel(
    reviewId: string,
    reason: string,
    ctx: ExtensionContext,
  ): Promise<ReviewState> {
    const environment = await this.#environment(ctx);
    const coordinator = this.#coordinator(environment);
    const state = await coordinator.cancel(reviewId, reason, ctx.signal);
    this.#linked.set(reviewId, {
      reviewId,
      pullNumber: state.pullNumber,
      status: state.status,
      decision: state.verdict?.decision,
      merged: state.completion?.outcome === "merged",
    });
    return state;
  }

  async resume(
    reviewId: string,
    ctx: ExtensionContext,
  ): Promise<ReviewPrResult> {
    const environment = await this.#environment(ctx);
    const current = await environment.journal.read(reviewId, ctx.signal);
    if (!current) throw new Error(`Review ${reviewId} does not exist.`);
    const state = current.state;
    const coordinator = this.#coordinator(environment);
    const result = await coordinator.review({
      reviewId,
      repository: state.repository,
      pullNumber: state.pullNumber,
      ...(state.issueNumber === undefined
        ? {}
        : { issueNumber: state.issueNumber }),
      mode: state.mode,
      route: {
        pullNumber: state.pullNumber,
        headRef: state.headRef,
        headSha: state.headSha,
        baseRef: state.baseRef,
        baseSha: state.baseSha,
      },
      roster: state.roster,
      execution: {
        kind: "standalone",
        repositoryRoot: environment.repositoryRoot,
      },
      round: state.panel?.round ?? 1,
      reviewerTimeoutMs: environment.policy.subagents.reviewerTimeoutMs,
      githubCheckTimeoutMs:
        environment.policy.verification.github.waitTimeoutMs,
      githubCheckPollIntervalMs:
        environment.policy.verification.github.pollIntervalMs,
      githubChecksRequired: isGitHubCiRequired(
        environment.policy,
        state.baseRef,
      ),
      protectedBranches: environment.policy.branches.protected,
      autoMergeAuthorized: canAutoMerge(environment.policy, state.baseRef),
      autoMergeRequested: state.mergeAuthorization?.authorized === true,
      resume: true,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    this.#linked.set(reviewId, {
      reviewId,
      pullNumber: result.pullNumber,
      status: result.state.status,
      decision: result.decision.decision,
      merged: result.merged,
    });
    return result;
  }

  #coordinator(
    environment: Pick<ReviewControllerEnvironment, "github" | "journal">,
  ): ReviewPrCoordinator {
    return new ReviewPrCoordinator({
      github: environment.github,
      journal: environment.journal,
      git: this.#git,
      panel: this.#panel,
    });
  }

  async #environment(
    ctx: ExtensionContext,
  ): Promise<ReviewControllerEnvironment> {
    const repositoryRoot = await this.#git.resolveRepositoryRoot(
      ctx.cwd,
      ctx.signal,
    );
    await this.#git.ensureRuntimeIgnored(repositoryRoot, ctx.signal);
    const { policy } = await loadForgePolicy(repositoryRoot);
    const tokenProvider = createGitHubTokenProvider(this.#pi, repositoryRoot);
    const transport = new FetchGitHubTransport({ tokenProvider });
    const github = new GitHubWorkflowAdapter(
      transport,
      policy.repository.name,
      {
        integrationBranch: resolveConcreteBranch(
          policy.branches.integration,
          "staging",
        ),
        defaultBranch: resolveConcreteBranch(
          policy.branches.protected,
          "main",
        ),
      },
    );
    const store = new GitHubStateBranchStore(
      transport,
      policy.repository.name,
      policy.state.branch,
    );
    return {
      repositoryRoot,
      policy,
      github,
      journal: new ReviewJournal(store),
    };
  }
}

function normalizePanelResults(
  values: readonly ForgeReviewerResult[],
  reviewId: string,
  headSha: string,
  roster: readonly string[],
): {
  results: readonly ForgeReviewerResult[];
  findings: readonly ForgeReviewFindingResult[];
} {
  if (values.length !== roster.length)
    throw new Error("Reviewer panel returned an incomplete roster.");
  const byReviewer = new Map<string, ForgeReviewerResult>();
  for (const value of values) {
    const reviewer = canonicalReviewer(value.reviewer, roster);
    if (
      value.runId !== reviewId ||
      value.headSha !== headSha ||
      byReviewer.has(reviewer)
    )
      throw new Error(
        "Reviewer result does not match the frozen panel identity.",
      );
    const findings = value.findings.map((finding) => {
      const findingReviewer = canonicalReviewer(finding.reviewer, roster);
      if (
        findingReviewer !== reviewer ||
        finding.runId !== reviewId ||
        finding.headSha !== headSha
      )
        throw new Error("Review finding does not match its reviewer binding.");
      return { ...finding, reviewer: findingReviewer };
    });
    byReviewer.set(reviewer, { ...value, reviewer, findings });
  }
  const results = roster.map((reviewer) => {
    const result = byReviewer.get(reviewer);
    if (!result)
      throw new Error(`Required reviewer ${reviewer} did not complete.`);
    return result;
  });
  const findings = results.flatMap((result) => result.findings);
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length)
    throw new Error(
      "Reviewer finding IDs must be unique across the complete panel.",
    );
  return { results, findings };
}

function canonicalReviewer(value: string, roster: readonly string[]): string {
  const match = roster.find(
    (reviewer) =>
      reviewer === value ||
      reviewer === `forge-review-${value}` ||
      `forge-review-${reviewer}` === value,
  );
  if (!match) throw new Error(`Reviewer ${value} is not in the frozen roster.`);
  return match;
}

function normalizeGitHubChecks(
  result: Awaited<
    ReturnType<GitHubWorkflowAdapter["waitForPullRequestChecks"]>
  >,
  required: boolean,
): VerificationResult[] {
  if (result.checks.length === 0)
    return [
      {
        name: "github-ci",
        required,
        status:
          result.configuredWorkflowCount > 0 ? "unknown" : "not-configured",
      },
    ];
  return result.checks.map((check) => ({
    name: `github:${check.name}`,
    required: required || check.required,
    status: check.status,
  }));
}

function completedResult(
  state: ReviewState,
  route: GitHubPullRequestRouteSnapshot,
  merge?: MergeResult,
): ReviewPrResult {
  if (!state.verdict || !state.gate || !state.completion)
    throw new Error("Completed review is missing durable decision evidence.");
  const decision: FinalReviewDecision = {
    headSha: state.verdict.headSha,
    baseSha: state.verdict.baseSha,
    decision: state.verdict.decision,
    blockingFindingIds: state.verdict.blockingFindingIds,
    followUpFindingIds: state.verdict.followUpFindingIds,
    checkResults: state.checks,
    reasons: state.verdict.reasons,
  };
  return {
    reviewId: state.reviewId,
    pullNumber: state.pullNumber,
    route,
    state,
    decision,
    findings: state.findings as readonly ForgeReviewFindingResult[],
    checks: state.checks,
    findingIssues: {},
    merged: state.completion.outcome === "merged",
    ...(merge ? { mergeSha: merge.sha } : {}),
  };
}

function requirePanelRound(state: ReviewState): number {
  if (!state.panel) throw new Error("Review panel has not started.");
  return state.panel.round;
}

function assertRequest(input: ReviewPrRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.reviewId))
    throw new TypeError("Review ID contains unsafe characters.");
  if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1)
    throw new TypeError("Pull request number must be positive.");
  if (input.roster.reviewers.length === 0)
    throw new TypeError("Review roster cannot be empty.");
  if (new Set(input.roster.reviewers).size !== input.roster.reviewers.length)
    throw new TypeError("Review roster cannot contain duplicates.");
}

const THOROUGH_REVIEWERS = [
  "forge-review-correctness",
  "forge-review-security",
  "forge-review-api",
  "forge-review-worker",
  "forge-review-web",
  "forge-review-code-quality",
  "forge-review-regression-risk",
  "forge-review-deployment",
] as const;

function commandReviewers(
  configured: readonly string[],
  mode: ReviewMode,
  thorough: boolean,
): readonly string[] {
  if (mode !== "staging" && !thorough) return configured;
  return [...new Set([...configured, ...THOROUGH_REVIEWERS])];
}

function strictStagingDecision(
  decision: FinalReviewDecision,
  findings: readonly ForgeReviewFindingResult[],
  unresolvedIssueNumbers: readonly number[],
): FinalReviewDecision {
  if (
    decision.decision === "approved" &&
    findings.length === 0 &&
    unresolvedIssueNumbers.length === 0
  )
    return decision;
  const reasons = [
    ...decision.reasons,
    ...(findings.length > 0
      ? [
          `Staging gate requires zero open findings; received ${findings.length}.`,
        ]
      : []),
    ...(unresolvedIssueNumbers.length > 0
      ? [
          `Unresolved prior review findings remain: ${unresolvedIssueNumbers
            .map((issue) => `#${issue}`)
            .join(", ")}.`,
        ]
      : []),
  ];
  return Object.freeze({
    headSha: decision.headSha,
    baseSha: decision.baseSha,
    decision:
      decision.decision === "approved" ||
      decision.decision === "approved-with-follow-ups"
        ? "changes-requested"
        : decision.decision,
    blockingFindingIds: Object.freeze([
      ...new Set([
        ...decision.blockingFindingIds,
        ...findings.map((finding) => finding.id),
      ]),
    ]),
    followUpFindingIds: Object.freeze([]),
    checkResults: decision.checkResults,
    reasons: Object.freeze(reasons),
  });
}

function selectorValue(selector: ReviewSelector): number | string {
  switch (selector.kind) {
    case "pull-request":
      return selector.pullNumber;
    case "pull-request-url":
      return selector.url;
    case "collection":
      return selector.state;
    case "route":
      return selector.route;
  }
}

async function resolveReviewWorktree(
  repositoryRoot: string,
  relativePath: string,
): Promise<string> {
  const root = await realpath(repositoryRoot);
  const candidate = await realpath(resolve(root, relativePath));
  if (!isPathWithin(root, candidate))
    throw new Error("Review worktree escapes the repository root.");
  return candidate;
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function reviewRouteMarker(
  reviewId: string,
  route: GitHubPullRequestRouteSnapshot,
): string {
  return `<!-- FORGE:REVIEW_ROUTE id=${reviewId} pr=${route.pullNumber} head=${route.headSha} base=${route.baseSha} -->`;
}

function reviewerMarker(
  reviewId: string,
  reviewer: string,
  round: number,
  headSha: string,
): string {
  return `<!-- FORGE:REVIEW_AGENT id=${reviewId} reviewer=${reviewer} round=${round} head=${headSha} -->`;
}

function reviewSummaryMarker(reviewId: string, headSha: string): string {
  return `<!-- FORGE:REVIEW_SUMMARY id=${reviewId} head=${headSha} -->`;
}

function renderReviewRoute(
  reviewId: string,
  mode: ReviewMode,
  route: GitHubPullRequestRouteSnapshot,
  reviewers: readonly string[],
): string {
  return `## ForgeDock Review Route\n\n- Review: \`${reviewId}\`\n- Mode: \`${mode}\`\n- Head: \`${route.headRef}\` at \`${route.headSha}\`\n- Base: \`${route.baseRef}\` at \`${route.baseSha}\`\n- Required reviewers: ${reviewers.map((reviewer) => `\`${reviewer}\``).join(", ")}`;
}

function renderReviewerResult(result: ForgeReviewerResult): string {
  const findings = result.findings.length
    ? result.findings
        .map(
          (finding) =>
            `- **${finding.id}** (${finding.confidence}/${finding.severity}) \`${finding.file}:${finding.line}\` — ${finding.summary}`,
        )
        .join("\n")
    : "- No findings.";
  const limitations = result.limitations.length
    ? result.limitations.map((value) => `- ${value}`).join("\n")
    : "- None.";
  return `## ${result.reviewer}\n\n**Verdict**: \`${result.verdict}\`\n**Reviewed head**: \`${result.headSha}\`\n\n### Findings\n\n${findings}\n\n### Limitations\n\n${limitations}`;
}

function renderStagingGate(
  decision: FinalReviewDecision,
  checks: readonly VerificationResult[],
  findings: readonly ForgeReviewFindingResult[],
): string {
  const passed = decision.decision === "approved" && findings.length === 0;
  return `## ForgeDock Staging Deployment Gate — ${passed ? "PASS" : "FAILURE"}\n\n**Reviewed head**: \`${decision.headSha}\`\n**Reviewed base**: \`${decision.baseSha}\`\n**Decision**: \`${decision.decision}\`\n**Merge/deploy performed**: no\n\n### Checks\n\n${checks.map((check) => `- ${check.required ? "required" : "optional"} \`${check.name}\`: ${check.status}`).join("\n") || "- No checks recorded."}\n\n### Findings\n\n${findings.length ? findings.map((finding) => `- ${finding.id}: ${finding.summary}`).join("\n") : "- None."}\n\n### Reasons\n\n${decision.reasons.length ? decision.reasons.map((reason) => `- ${reason}`).join("\n") : "- All strict staging gates passed."}`;
}

function renderReviewSummary(
  decision: FinalReviewDecision,
  findings: readonly ForgeReviewFindingResult[],
  issueMap: Readonly<Record<string, number>>,
): string {
  const renderedFindings = findings.length
    ? findings
        .map(
          (finding) =>
            `- ${issueMap[finding.id] ? `#${issueMap[finding.id]} — ` : ""}${finding.id}: ${finding.summary}`,
        )
        .join("\n")
    : "No findings reported.";
  return `# PR Review Summary\n\n**Decision**: \`${decision.decision}\`\n**Reviewed head**: \`${decision.headSha}\`\n**Reviewed base**: \`${decision.baseSha}\`\n\n## Findings\n\n${renderedFindings}\n\n## Gate Reasons\n\n${decision.reasons.length ? decision.reasons.map((reason) => `- ${reason}`).join("\n") : "- None."}\n\n<!-- REVIEW-FINDINGS-START -->\n${findings.map((finding) => `<!-- FINDING:${finding.id}|${finding.confidence.toUpperCase()}|${finding.severity.toUpperCase()}|${finding.file}:${finding.line}|${finding.summary.replaceAll("|", "/")} -->`).join("\n")}\n<!-- REVIEW-FINDINGS-END -->`;
}
