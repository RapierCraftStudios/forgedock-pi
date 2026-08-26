import { createHash, randomUUID } from "node:crypto";
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
  type ForgeReviewerResult,
  type ForgeWorkOnResult,
} from "../agents/contracts.ts";
import { materializeForgeAgents } from "../agents/materialize.ts";
import {
  checkPreMergeAuditTrail,
  WORKFLOW_LABEL_BY_STAGE,
} from "../core/artifact-protocol.ts";
import {
  canAutoMerge,
  isProtectedBranch,
  type ForgePolicy,
} from "../core/policy.ts";
import {
  evaluateReviewGate,
  type ReviewFinding,
  type VerificationResult,
} from "../core/review.ts";
import { RunJournal } from "./journal.ts";

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
    const transport = new FetchGitHubTransport({ token });
    const store = new GitHubStateBranchStore(
      transport,
      link.repository,
      link.stateBranch,
    );
    const journal = new RunJournal(store);
    const github = new GitHubWorkflowAdapter(transport, link.repository);
    const projector = new GitHubIssueProjector(transport, link.repository);
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
      link.prepared.baseSha,
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
    const currentRun = await store.readRun(link.forgeRunId, ctx.signal);
    const checks = verificationForGate(policy, result);
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
      leaseValid: currentRun.lease?.ownerRunId === link.forgeRunId,
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
      link.status = "failed";
      this.#persistLink(link);
      ctx.ui.notify(
        `ForgeDock PR #${pull.number} not merged: ${gate.reasons.join(" ")}`,
        "warning",
      );
      return;
    }

    await setWorkflowLabelWithRetry(
      projector,
      link.issueNumber,
      WORKFLOW_LABEL_BY_STAGE.awaitingMerge,
      ctx.signal,
    );
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
    try {
      await setWorkflowLabelWithRetry(
        projector,
        link.issueNumber,
        WORKFLOW_LABEL_BY_STAGE.merged,
        ctx.signal,
      );
    } catch (error) {
      ctx.ui.notify(
        `ForgeDock issue #${link.issueNumber} merged, but workflow label projection will retry during terminal reconciliation: ${errorMessage(error)}`,
        "warning",
      );
    }
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

    await journal.append({
      runId: link.forgeRunId,
      type: "run.completed",
      payload: { outcome: "merged" },
      idempotencyKey: "run:completed",
      sessionId,
      message: `Complete ForgeDock run ${link.forgeRunId}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const released = await journal.append({
      runId: link.forgeRunId,
      type: "lease.released",
      payload: {
        ownerRunId: link.forgeRunId,
        epoch: currentRun.lease?.epoch ?? 1,
      },
      idempotencyKey: "lease:release",
      sessionId,
      message: `Release ForgeDock lease ${link.forgeRunId}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const terminalEvent = released.events.at(-1);
    if (terminalEvent) {
      await projector.projectEvent({
        issueNumber: link.issueNumber,
        event: terminalEvent,
        markdown: `## ForgeDock Pi complete\n\nPR #${pull.number} merged into \`${link.prepared.baseBranch}\`.\nNested review completed at \`${result.review.headSha}\`.\nRun: \`${link.forgeRunId}\`.`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      try {
        await setWorkflowLabelWithRetry(
          projector,
          link.issueNumber,
          WORKFLOW_LABEL_BY_STAGE.merged,
          ctx.signal,
        );
      } catch (error) {
        ctx.ui.notify(
          `ForgeDock issue #${link.issueNumber} completed, but workflow:merged projection failed: ${errorMessage(error)}`,
          "warning",
        );
      }
    }

    link.status = "completed";
    this.#persistLink(link);
    ctx.ui.setStatus("forgedock", undefined);
    ctx.ui.notify(
      `ForgeDock issue #${link.issueNumber} merged through PR #${pull.number}.`,
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

async function setWorkflowLabelWithRetry(
  projector: GitHubIssueProjector,
  issueNumber: number,
  workflowLabel: string,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await projector.setWorkflowLabel(issueNumber, workflowLabel, signal);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3)
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, attempt * 250),
        );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
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
    result.baseSha !== link.prepared.baseSha
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
