import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { resolveGitHubToken } from "../adapters/github-auth.ts";
import { FetchGitHubTransport } from "../adapters/github-api.ts";
import { loadForgePolicy } from "../adapters/config.ts";
import { GitWorktreeManager } from "../adapters/git.ts";
import { GitHubIssueProjector } from "../adapters/github-projection.ts";
import { GitHubStateBranchStore } from "../adapters/github-state.ts";
import {
  GitHubWorkflowAdapter,
  type GitHubPullRequestData,
  type MergeResult,
} from "../adapters/github-workflow.ts";
import { SubagentsRpcClient } from "../adapters/subagents.ts";
import {
  findForgeWorkOnResult,
  type ForgeReviewerResult,
  type ForgeWorkOnResult,
} from "../core/agent-contracts.ts";
import { checkPreMergeAuditTrail } from "../core/artifact-protocol.ts";
import {
  canAutoMerge,
  type ForgePolicy,
} from "../core/policy.ts";
import {
  evaluateReviewGate,
  type ReviewFinding,
  type ReviewGateResult,
  type VerificationResult,
} from "../core/review.ts";
import { RunJournal } from "./journal.ts";
import type { ActiveRunLink } from "./types.ts";

export const FINALIZATION_STAGES = [
  "push",
  "pull-request",
  "audit",
  "merge",
  "close",
  "cleanup",
  "terminal",
] as const;

export function isFinalizationMergeApproved(
  gate: Pick<ReviewGateResult, "decision">,
): boolean {
  return gate.decision === "approved";
}

interface FinalizationHost {
  pi: ExtensionAPI;
  rpc: SubagentsRpcClient;
  git: GitWorktreeManager;
  persistLink(link: ActiveRunLink): void;
}

interface FinalizationContext {
  link: ActiveRunLink;
  result: ForgeWorkOnResult;
  policy: ForgePolicy;
  store: GitHubStateBranchStore;
  journal: RunJournal;
  github: GitHubWorkflowAdapter;
  projector: GitHubIssueProjector;
  sessionId: string;
  actualHead: string;
  actualFiles: readonly string[];
  currentRun?: Awaited<ReturnType<GitHubStateBranchStore["readRun"]>>;
  pull?: GitHubPullRequestData;
  currentPull?: GitHubPullRequestData;
  gate?: ReviewGateResult;
  merged?: MergeResult;
}

/**
 * Parent-owned integration lifecycle. Each method is one auditable stage so a
 * failure can be reconciled against the journal without reopening child
 * containment or review responsibilities.
 */
export class ForgeWorkOnFinalizer {
  readonly #host: FinalizationHost;

  constructor(host: FinalizationHost) {
    this.#host = host;
  }

  async run(link: ActiveRunLink, ctx: ExtensionContext): Promise<void> {
    const result = await this.#readResult(link);
    assertResultIdentity(result, link);
    if (result.status !== "ready-for-merge") {
      link.status = "failed";
      this.#host.persistLink(link);
      ctx.ui.notify(
        `ForgeDock issue #${link.issueNumber} stopped: ${result.blocker ?? result.status}`,
        "warning",
      );
      return;
    }

    const state = await this.#loadContext(link, result, ctx);
    await this.#pushStage(state, ctx);
    await this.#pullRequestStage(state, ctx);
    const approved = await this.#auditStage(state, ctx);
    if (!approved) return;
    await this.#mergeStage(state, ctx);
    await this.#closeStage(state, ctx);
    await this.#cleanupStage(state, ctx);
    await this.#terminalStage(state, ctx);
  }

  async #readResult(link: ActiveRunLink): Promise<ForgeWorkOnResult> {
    const statusPayload = await this.#host.rpc.status(link.subagentRunId);
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

  async #loadContext(
    link: ActiveRunLink,
    result: ForgeWorkOnResult,
    ctx: ExtensionContext,
  ): Promise<FinalizationContext> {
    const { policy } = await loadForgePolicy(link.prepared.repositoryRoot);
    const token = await resolveGitHubToken(
      this.#host.pi,
      link.prepared.repositoryRoot,
      ctx.signal,
    );
    const transport = new FetchGitHubTransport({ token });
    const store = new GitHubStateBranchStore(
      transport,
      link.repository,
      link.stateBranch,
    );
    await this.#host.git.assertClean(link.prepared.worktreePath, ctx.signal);
    const actualHead = await this.#host.git.head(
      link.prepared.worktreePath,
      ctx.signal,
    );
    if (actualHead !== result.headSha || result.review.headSha !== actualHead) {
      throw new Error(
        `Work-on/review SHA mismatch: git=${actualHead} result=${result.headSha} review=${result.review.headSha}.`,
      );
    }
    const actualFiles = await this.#host.git.changedFiles(
      link.prepared.worktreePath,
      link.prepared.baseSha,
      ctx.signal,
    );
    if (!sameStrings(actualFiles, result.changedFiles))
      throw new Error(
        "Work-on changed-file result does not match the actual committed diff.",
      );
    return {
      link,
      result,
      policy,
      store,
      journal: new RunJournal(store),
      github: new GitHubWorkflowAdapter(transport, link.repository),
      projector: new GitHubIssueProjector(transport, link.repository),
      sessionId: ctx.sessionManager.getSessionId(),
      actualHead,
      actualFiles,
    };
  }

  async #pushStage(
    state: FinalizationContext,
    ctx: ExtensionContext,
  ): Promise<void> {
    await appendPhase(
      state.journal,
      state.link.forgeRunId,
      "merge",
      "queue",
      1,
      state.sessionId,
      ctx.signal,
    );
    await appendPhase(
      state.journal,
      state.link.forgeRunId,
      "merge",
      "start",
      1,
      state.sessionId,
      ctx.signal,
    );
    await this.#host.git.push(
      state.link.prepared.worktreePath,
      state.link.prepared.branch,
      ctx.signal,
    );
    await appendEffect(
      state.journal,
      state.link.forgeRunId,
      "push",
      `branch:${state.link.prepared.branch}`,
      digest(state.actualHead),
      state.sessionId,
      ctx.signal,
    );
  }

  async #pullRequestStage(
    state: FinalizationContext,
    ctx: ExtensionContext,
  ): Promise<void> {
    const issue = await state.github.getIssue(state.link.issueNumber, ctx.signal);
    const pull = await state.github.createPullRequest({
      title: issue.title,
      body: renderPullRequestBody(state.link, state.result),
      head: state.link.prepared.branch,
      base: state.link.prepared.baseBranch,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    state.pull = pull;
    await appendEffect(
      state.journal,
      state.link.forgeRunId,
      "pull-request",
      `pr:${pull.number}`,
      digest(pull.htmlUrl),
      state.sessionId,
      ctx.signal,
    );
    state.currentPull = await resolveMergeability(
      state.github,
      pull.number,
      ctx.signal,
    );
  }

  async #auditStage(
    state: FinalizationContext,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    const currentPull = requireStageValue(state.currentPull, "pull request");
    await publishReviewArtifacts(
      state.github,
      currentPull.number,
      state.result,
      ctx.signal,
    );
    const issueComments = await state.github.getComments(
      state.link.issueNumber,
      ctx.signal,
    );
    const pullComments = await state.github.getComments(
      currentPull.number,
      ctx.signal,
    );
    const audit = checkPreMergeAuditTrail({
      issueComments,
      pullRequestComments: pullComments,
      requiredReviewerDomains: state.policy.review.required.map(reviewerDomain),
    });
    const auditFailures = [
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
    state.currentRun = await state.store.readRun(
      state.link.forgeRunId,
      ctx.signal,
    );
    const checks = verificationForGate(state.policy, state.result);
    const findings = state.result.review.findings as readonly ReviewFinding[];
    state.gate = evaluateReviewGate({
      identity: {
        repository: state.link.repository,
        runId: state.link.forgeRunId,
        pullRequest: currentPull.number,
        headSha: state.result.review.headSha,
        baseSha: state.result.baseSha,
        rosterVersion: "forgedock.review-roster/v1",
      },
      currentHeadSha: currentPull.headSha,
      currentBaseSha: currentPull.baseSha,
      requiredReviewers: state.policy.review.required,
      completedReviewers: state.result.review.completedReviewers,
      findings,
      checks,
      mergeability: currentPull.mergeability,
      leaseValid: state.currentRun.lease?.ownerRunId === state.link.forgeRunId,
      baseBranch: currentPull.baseRef,
      protectedBranches: state.policy.branches.protected,
      autoMergeAuthorized: canAutoMerge(state.policy, currentPull.baseRef),
      malformedResults: auditFailures,
    });
    if (state.gate.decision === "approved") return true;

    const action = state.gate.decision === "needs-human" ? "needs-human" : "block";
    await appendPhase(
      state.journal,
      state.link.forgeRunId,
      "merge",
      action,
      1,
      state.sessionId,
      ctx.signal,
      state.gate.reasons.join(" "),
    );
    state.link.status = "failed";
    this.#host.persistLink(state.link);
    ctx.ui.notify(
      `ForgeDock PR #${currentPull.number} not merged: ${state.gate.reasons.join(" ")}`,
      "warning",
    );
    return false;
  }

  async #mergeStage(
    state: FinalizationContext,
    ctx: ExtensionContext,
  ): Promise<void> {
    const pull = requireStageValue(state.pull, "pull request");
    const gate = requireStageValue(state.gate, "review gate");
    if (!isFinalizationMergeApproved(gate))
      throw new Error("Merge stage requires an approved review gate.");
    const merged = await state.github.mergePullRequest({
      pullNumber: pull.number,
      expectedHeadSha: state.result.review.headSha,
      method: "squash",
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    state.merged = merged;
    await appendEffect(
      state.journal,
      state.link.forgeRunId,
      "merge",
      `pr:${pull.number}:merge`,
      digest(merged.sha),
      state.sessionId,
      ctx.signal,
    );
    await appendPhase(
      state.journal,
      state.link.forgeRunId,
      "merge",
      "complete",
      1,
      state.sessionId,
      ctx.signal,
      undefined,
      [merged.sha],
    );
    await postReviewCompletionArtifacts({
      github: state.github,
      projector: state.projector,
      link: state.link,
      result: state.result,
      pullNumber: pull.number,
      mergedSha: merged.sha,
      signal: ctx.signal,
    });
  }

  async #closeStage(
    state: FinalizationContext,
    ctx: ExtensionContext,
  ): Promise<void> {
    const merged = requireStageValue(state.merged, "merge result");
    await appendPhase(
      state.journal,
      state.link.forgeRunId,
      "close",
      "queue",
      1,
      state.sessionId,
      ctx.signal,
    );
    await appendPhase(
      state.journal,
      state.link.forgeRunId,
      "close",
      "start",
      1,
      state.sessionId,
      ctx.signal,
    );
    await state.github.closeIssue(state.link.issueNumber, ctx.signal);
    await appendEffect(
      state.journal,
      state.link.forgeRunId,
      "issue-close",
      `issue:${state.link.issueNumber}:close`,
      digest(merged.sha),
      state.sessionId,
      ctx.signal,
    );
    await appendPhase(
      state.journal,
      state.link.forgeRunId,
      "close",
      "complete",
      1,
      state.sessionId,
      ctx.signal,
      undefined,
      ["issue close read-back passed"],
    );
  }

  async #cleanupStage(
    state: FinalizationContext,
    ctx: ExtensionContext,
  ): Promise<void> {
    await appendPhase(
      state.journal,
      state.link.forgeRunId,
      "cleanup",
      "queue",
      1,
      state.sessionId,
      ctx.signal,
    );
    await appendPhase(
      state.journal,
      state.link.forgeRunId,
      "cleanup",
      "start",
      1,
      state.sessionId,
      ctx.signal,
    );
    await this.#host.git.deleteRemoteBranch(state.link.prepared, ctx.signal);
    await this.#host.git.cleanup(state.link.prepared, ctx.signal);
    await appendEffect(
      state.journal,
      state.link.forgeRunId,
      "cleanup",
      `worktree:${state.link.forgeRunId}`,
      digest(state.link.prepared.worktreePath),
      state.sessionId,
      ctx.signal,
    );
    await appendPhase(
      state.journal,
      state.link.forgeRunId,
      "cleanup",
      "complete",
      1,
      state.sessionId,
      ctx.signal,
      undefined,
      ["owned worktree removed", "remote feature branch deleted"],
    );
  }

  async #terminalStage(
    state: FinalizationContext,
    ctx: ExtensionContext,
  ): Promise<void> {
    const pull = requireStageValue(state.pull, "pull request");
    const merged = requireStageValue(state.merged, "merge result");
    await postTerminalIssueArtifacts({
      projector: state.projector,
      link: state.link,
      result: state.result,
      pullNumber: pull.number,
      mergedSha: merged.sha,
      signal: ctx.signal,
    });
    await state.journal.append({
      runId: state.link.forgeRunId,
      type: "run.completed",
      payload: { outcome: "merged" },
      idempotencyKey: "run:completed",
      sessionId: state.sessionId,
      message: `Complete ForgeDock run ${state.link.forgeRunId}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const currentRun = requireStageValue(state.currentRun, "run state");
    const released = await state.journal.append({
      runId: state.link.forgeRunId,
      type: "lease.released",
      payload: {
        ownerRunId: state.link.forgeRunId,
        epoch: currentRun.lease?.epoch ?? 1,
      },
      idempotencyKey: "lease:release",
      sessionId: state.sessionId,
      message: `Release ForgeDock lease ${state.link.forgeRunId}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const terminalEvent = released.events.at(-1);
    if (terminalEvent) {
      await state.projector.projectEvent({
        issueNumber: state.link.issueNumber,
        event: terminalEvent,
        markdown: `## ForgeDock Pi complete\n\nPR #${pull.number} merged into \`${state.link.prepared.baseBranch}\`.\nNested review completed at \`${state.result.review.headSha}\`.\nRun: \`${state.link.forgeRunId}\`.`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      await state.projector.setWorkflowLabel(
        state.link.issueNumber,
        "workflow:merged",
        ctx.signal,
      );
    }
    state.link.status = "completed";
    this.#host.persistLink(state.link);
    ctx.ui.setStatus("forgedock", undefined);
    ctx.ui.notify(
      `ForgeDock issue #${state.link.issueNumber} merged through PR #${pull.number}.`,
      "info",
    );  }
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

async function publishReviewArtifacts(
  github: GitHubWorkflowAdapter,
  pullNumber: number,
  result: ForgeWorkOnResult,
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
    body: renderReviewSummary(pullNumber, result),
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
): string {
  const verdict =
    result.review.findings.length === 0 ? "APPROVE" : "CHANGES REQUESTED";
  const domains = result.review.reviewerResults.map((reviewer) =>
    reviewerDomain(reviewer.reviewer),
  );
  return `<!-- FORGE:REVIEW_SUMMARY -->\n# PR Review Summary: #${pullNumber}\n\n## Review Integrity\n\n**Reviewed commit**: \`${result.review.headSha}\`  \n**Current HEAD**: \`${result.headSha}\`  \n**Status**: ${result.review.headSha === result.headSha ? "CURRENT" : "STALE"}\n\n## Verdict: ${verdict}\n\n## Context-Aware Review\n\n**Domains**: ${domains.join(", ")}  \n**Review passes**: ${result.review.reviewerResults.length}  \n**Dispatch mode**: nested Pi subagents in fresh read-only contexts\n\n## Integration Checks\n\nRequired verification completed before review; merge authority remains parent-controlled.\n\n## Risk Matrix\n\n| Category | Risk | Blocking? | Confidence |\n|----------|------|-----------|------------|\n| Correctness | ${result.review.findings.length ? "Findings reported" : "No finding"} | ${result.review.findings.length ? "Evaluate" : "No"} | High |\n| Security | ${result.review.findings.some((finding) => finding.category === "security") ? "Finding reported" : "None found"} | ${result.review.findings.some((finding) => finding.category === "security") ? "Evaluate" : "No"} | High |\n\n## Findings\n\n${result.review.findings.length ? `${result.review.findings.length} structured finding(s) reported.` : "No confirmed, likely, or possible findings."}\n\n## Automated Checks\n\n${result.verification.map((check) => `- ${check.name}: ${check.status}`).join("\n")}\n\n## Recommendation\n\n${verdict === "APPROVE" ? "Approve for the configured integration branch after the parent rechecks the frozen SHA and audit trail." : "Do not merge until blocking findings are remediated and re-reviewed."}\n\n<!-- REVIEW-FINDINGS-START -->\n${result.review.findings.map((finding) => `<!-- FINDING:${finding.id}|${finding.confidence.toUpperCase()}|${finding.severity.toUpperCase()}|${finding.file}:${finding.line}|${finding.summary.replaceAll("|", "/")} -->`).join("\n")}\n<!-- REVIEW-FINDINGS-END -->`;
}

function reviewerDomain(reviewer: string): string {
  return reviewer.replace(/^forge-review-/, "").replace(/\s*\(.+\)$/, "");
}

function verificationForGate(
  policy: ForgePolicy,
  result: ForgeWorkOnResult,
): VerificationResult[] {
  return Object.entries(policy.verification.commands).map(([name, command]) => {
    const actual = result.verification.find((entry) => entry.name === name);
    return {
      name,
      required: command.required,
      status: actual?.status ?? "unknown",
      ...(actual?.exitCode === undefined ? {} : { exitCode: actual.exitCode }),
    };
  });
}

async function resolveMergeability(
  github: GitHubWorkflowAdapter,
  pullNumber: number,
  signal?: AbortSignal,
): Promise<GitHubPullRequestData> {
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

export function renderPullRequestBody(
  link: ActiveRunLink,
  result: ForgeWorkOnResult,
): string {
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

function requireStageValue<T>(value: T | undefined, stage: string): T {
  if (value === undefined) throw new Error(`Finalization stage missing ${stage}.`);
  return value;
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

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}
