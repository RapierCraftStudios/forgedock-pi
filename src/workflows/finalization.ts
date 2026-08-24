import { createHash } from "node:crypto";

import {
  FetchGitHubTransport,
  type GitHubTransport,
} from "../adapters/github-api.ts";
import { GitHubIssueProjector } from "../adapters/github-projection.ts";
import {
  GitHubStateBranchStore,
  type ReadRunStateResult,
} from "../adapters/github-state.ts";
import {
  GitHubWorkflowAdapter,
  type GitHubPullRequestData,
} from "../adapters/github-workflow.ts";
import { GitWorktreeManager, type PreparedWorktree } from "../adapters/git.ts";
import type {
  ForgeReviewerResult,
  ForgeWorkOnResult,
} from "../core/work-on-contracts.ts";
import { checkPreMergeAuditTrail } from "../core/artifact-protocol.ts";
import { canAutoMerge, type ForgePolicy } from "../core/policy.ts";
import {
  evaluateReviewGate,
  type ReviewFinding,
  type VerificationResult,
} from "../core/review.ts";
import { RunJournal } from "./journal.ts";

export interface FinalizationLink {
  forgeRunId: string;
  issueNumber: number;
  repository: string;
  stateBranch: string;
  prepared: PreparedWorktree;
}

export interface FinalizationInput {
  link: FinalizationLink;
  result: ForgeWorkOnResult;
  policy: ForgePolicy;
  token: string;
  sessionId: string;
  signal?: AbortSignal;
}

export type FinalizationOutcome =
  | {
      status: "merged";
      pullNumber: number;
      mergedSha: string;
    }
  | {
      status: "blocked";
      pullNumber: number;
      reasons: readonly string[];
    };

export interface FinalizationSession extends FinalizationInput {
  transport: GitHubTransport;
  store: GitHubStateBranchStore;
  journal: RunJournal;
  github: GitHubWorkflowAdapter;
  projector: GitHubIssueProjector;
  pull?: GitHubPullRequestData;
  currentRun?: ReadRunStateResult;
  mergedSha?: string;
}

/**
 * Parent-owned effect pipeline. Each public stage owns one authority-sensitive
 * boundary and records its journal effect before the next stage can run.
 */
export class ForgeWorkOnFinalizer {
  readonly #git: GitWorktreeManager;
  readonly #transportFactory: (token: string) => GitHubTransport;

  constructor(
    git: GitWorktreeManager,
    transportFactory: (token: string) => GitHubTransport = (token) =>
      new FetchGitHubTransport({ token }),
  ) {
    this.#git = git;
    this.#transportFactory = transportFactory;
  }

  async run(input: FinalizationInput): Promise<FinalizationOutcome> {
    const transport = this.#transportFactory(input.token);
    const store = new GitHubStateBranchStore(
      transport,
      input.link.repository,
      input.link.stateBranch,
    );
    const session: FinalizationSession = {
      ...input,
      transport,
      store,
      journal: new RunJournal(store),
      github: new GitHubWorkflowAdapter(transport, input.link.repository),
      projector: new GitHubIssueProjector(transport, input.link.repository),
    };

    await this.push(session);
    await this.preparePullRequest(session);
    const gate = await this.audit(session);
    if (gate.decision !== "approved") {
      const action = gate.decision === "needs-human" ? "needs-human" : "block";
      await appendPhase(
        session.journal,
        session.link.forgeRunId,
        "merge",
        action,
        1,
        session.sessionId,
        session.signal,
        gate.reasons.join(" "),
      );
      return {
        status: "blocked",
        pullNumber: this.requirePull(session).number,
        reasons: gate.reasons,
      };
    }

    await this.merge(session);
    await this.close(session);
    await this.cleanup(session);
    await this.complete(session);
    return {
      status: "merged",
      pullNumber: this.requirePull(session).number,
      mergedSha: this.requireMergedSha(session),
    };
  }

  async push(session: FinalizationSession): Promise<void> {
    await this.#git.assertClean(session.link.prepared.worktreePath, session.signal);
    const actualHead = await this.#git.head(
      session.link.prepared.worktreePath,
      session.signal,
    );
    if (
      actualHead !== session.result.headSha ||
      session.result.review.headSha !== actualHead
    ) {
      throw new Error(
        `Work-on/review SHA mismatch: git=${actualHead} result=${session.result.headSha} review=${session.result.review.headSha}.`,
      );
    }
    const actualFiles = await this.#git.changedFiles(
      session.link.prepared.worktreePath,
      session.link.prepared.baseSha,
      session.signal,
    );
    if (!sameStrings(actualFiles, session.result.changedFiles))
      throw new Error(
        "Work-on changed-file result does not match the actual committed diff.",
      );

    await appendPhase(
      session.journal,
      session.link.forgeRunId,
      "merge",
      "queue",
      1,
      session.sessionId,
      session.signal,
    );
    await appendPhase(
      session.journal,
      session.link.forgeRunId,
      "merge",
      "start",
      1,
      session.sessionId,
      session.signal,
    );
    await this.#git.push(
      session.link.prepared.worktreePath,
      session.link.prepared.branch,
      session.signal,
    );
    await appendEffect(
      session.journal,
      session.link.forgeRunId,
      "push",
      `branch:${session.link.prepared.branch}`,
      digest(actualHead),
      session.sessionId,
      session.signal,
    );
  }

  async preparePullRequest(session: FinalizationSession): Promise<void> {
    const issue = await session.github.getIssue(
      session.link.issueNumber,
      session.signal,
    );
    const pull = await session.github.createPullRequest({
      title: issue.title,
      body: buildPullBody(session.link, session.result),
      head: session.link.prepared.branch,
      base: session.link.prepared.baseBranch,
      ...(session.signal ? { signal: session.signal } : {}),
    });
    session.pull = pull;
    await appendEffect(
      session.journal,
      session.link.forgeRunId,
      "pull-request",
      `pr:${pull.number}`,
      digest(pull.htmlUrl),
      session.sessionId,
      session.signal,
    );
    session.pull = await resolveMergeability(
      session.github,
      pull.number,
      session.signal,
    );
  }

  async audit(session: FinalizationSession) {
    const pull = this.requirePull(session);
    await publishReviewArtifacts(
      session.github,
      pull.number,
      session.result,
      session.signal,
    );
    const issueComments = await session.github.getComments(
      session.link.issueNumber,
      session.signal,
    );
    const pullComments = await session.github.getComments(
      pull.number,
      session.signal,
    );
    const audit = checkPreMergeAuditTrail({
      issueComments,
      pullRequestComments: pullComments,
      requiredReviewerDomains: session.policy.review.required.map(reviewerDomain),
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
    const currentRun = await session.store.readRun(
      session.link.forgeRunId,
      session.signal,
    );
    session.currentRun = currentRun;
    const checks = verificationForGate(session.policy, session.result);
    const findings = session.result.review.findings as readonly ReviewFinding[];
    return evaluateReviewGate({
      identity: {
        repository: session.link.repository,
        runId: session.link.forgeRunId,
        pullRequest: pull.number,
        headSha: session.result.review.headSha,
        baseSha: session.result.baseSha,
        rosterVersion: "forgedock.review-roster/v1",
      },
      currentHeadSha: pull.headSha,
      currentBaseSha: pull.baseSha,
      requiredReviewers: session.policy.review.required,
      completedReviewers: session.result.review.completedReviewers,
      findings,
      checks,
      mergeability: pull.mergeability,
      leaseValid: currentRun.lease?.ownerRunId === session.link.forgeRunId,
      baseBranch: pull.baseRef,
      protectedBranches: session.policy.branches.protected,
      autoMergeAuthorized: canAutoMerge(session.policy, pull.baseRef),
      malformedResults: auditFailures,
    });
  }

  async merge(session: FinalizationSession): Promise<void> {
    const pull = this.requirePull(session);
    const merged = await session.github.mergePullRequest({
      pullNumber: pull.number,
      expectedHeadSha: session.result.review.headSha,
      method: "squash",
      ...(session.signal ? { signal: session.signal } : {}),
    });
    session.mergedSha = merged.sha;
    await appendEffect(
      session.journal,
      session.link.forgeRunId,
      "merge",
      `pr:${pull.number}:merge`,
      digest(merged.sha),
      session.sessionId,
      session.signal,
    );
    await appendPhase(
      session.journal,
      session.link.forgeRunId,
      "merge",
      "complete",
      1,
      session.sessionId,
      session.signal,
      undefined,
      [merged.sha],
    );
    await postReviewCompletionArtifacts({
      github: session.github,
      projector: session.projector,
      link: session.link,
      result: session.result,
      pullNumber: pull.number,
      mergedSha: merged.sha,
      signal: session.signal,
    });
  }

  async close(session: FinalizationSession): Promise<void> {
    this.requirePull(session);
    await appendPhase(
      session.journal,
      session.link.forgeRunId,
      "close",
      "queue",
      1,
      session.sessionId,
      session.signal,
    );
    await appendPhase(
      session.journal,
      session.link.forgeRunId,
      "close",
      "start",
      1,
      session.sessionId,
      session.signal,
    );
    await session.github.closeIssue(session.link.issueNumber, session.signal);
    await appendEffect(
      session.journal,
      session.link.forgeRunId,
      "issue-close",
      `issue:${session.link.issueNumber}:close`,
      digest(this.requireMergedSha(session)),
      session.sessionId,
      session.signal,
    );
    await appendPhase(
      session.journal,
      session.link.forgeRunId,
      "close",
      "complete",
      1,
      session.sessionId,
      session.signal,
      undefined,
      ["issue close read-back passed"],
    );
  }

  async cleanup(session: FinalizationSession): Promise<void> {
    await appendPhase(
      session.journal,
      session.link.forgeRunId,
      "cleanup",
      "queue",
      1,
      session.sessionId,
      session.signal,
    );
    await appendPhase(
      session.journal,
      session.link.forgeRunId,
      "cleanup",
      "start",
      1,
      session.sessionId,
      session.signal,
    );
    await this.#git.deleteRemoteBranch(session.link.prepared, session.signal);
    await this.#git.cleanup(session.link.prepared, session.signal);
    await appendEffect(
      session.journal,
      session.link.forgeRunId,
      "cleanup",
      `worktree:${session.link.forgeRunId}`,
      digest(session.link.prepared.worktreePath),
      session.sessionId,
      session.signal,
    );
    await appendPhase(
      session.journal,
      session.link.forgeRunId,
      "cleanup",
      "complete",
      1,
      session.sessionId,
      session.signal,
      undefined,
      ["owned worktree removed", "remote feature branch deleted"],
    );
  }

  async complete(session: FinalizationSession): Promise<void> {
    const pull = this.requirePull(session);
    const mergedSha = this.requireMergedSha(session);
    await postTerminalIssueArtifacts({
      projector: session.projector,
      link: session.link,
      result: session.result,
      pullNumber: pull.number,
      mergedSha,
      signal: session.signal,
    });
    await session.journal.append({
      runId: session.link.forgeRunId,
      type: "run.completed",
      payload: { outcome: "merged" },
      idempotencyKey: "run:completed",
      sessionId: session.sessionId,
      message: `Complete ForgeDock run ${session.link.forgeRunId}`,
      ...(session.signal ? { signal: session.signal } : {}),
    });
    const released = await session.journal.append({
      runId: session.link.forgeRunId,
      type: "lease.released",
      payload: {
        ownerRunId: session.link.forgeRunId,
        epoch: session.currentRun?.lease?.epoch ?? 1,
      },
      idempotencyKey: "lease:release",
      sessionId: session.sessionId,
      message: `Release ForgeDock lease ${session.link.forgeRunId}`,
      ...(session.signal ? { signal: session.signal } : {}),
    });
    const terminalEvent = released.events.at(-1);
    if (terminalEvent) {
      await session.projector.projectEvent({
        issueNumber: session.link.issueNumber,
        event: terminalEvent,
        markdown: `## ForgeDock Pi complete\n\nPR #${pull.number} merged into \`${session.link.prepared.baseBranch}\`.\nNested review completed at \`${session.result.review.headSha}\`.\nRun: \`${session.link.forgeRunId}\`.`,
        ...(session.signal ? { signal: session.signal } : {}),
      });
      await session.projector.setWorkflowLabel(
        session.link.issueNumber,
        "workflow:merged",
        session.signal,
      );
    }
  }

  private requirePull(session: FinalizationSession): GitHubPullRequestData {
    if (!session.pull) throw new Error("Finalization PR stage has not completed.");
    return session.pull;
  }

  private requireMergedSha(session: FinalizationSession): string {
    if (!session.mergedSha)
      throw new Error("Finalization merge stage has not completed.");
    return session.mergedSha;
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
  link: FinalizationLink;
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
  link: FinalizationLink;
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

function buildPullBody(link: FinalizationLink, result: ForgeWorkOnResult): string {
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
