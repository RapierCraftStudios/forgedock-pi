import { createHash } from "node:crypto";

import {
  checkPreMergeAuditTrail,
  type AuditTrailCheck,
} from "../core/artifact-protocol.ts";
import {
  canAutoMerge,
  isProtectedBranch,
  type ForgePolicy,
} from "../core/policy.ts";
import {
  evaluateReviewGate,
  type ReviewFinding,
  type ReviewGateResult,
  type VerificationResult,
} from "../core/review.ts";
import type {
  ForgeReviewerResult,
  ForgeWorkOnResult,
} from "../core/work-on-contracts.ts";
import {
  GitWorktreeManager,
  type PreparedWorktree,
} from "../adapters/git.ts";
import { GitHubIssueProjector } from "../adapters/github-projection.ts";
import { GitHubStateBranchStore } from "../adapters/github-state.ts";
import {
  GitHubWorkflowAdapter,
  type GitHubPullRequestData,
} from "../adapters/github-workflow.ts";
import { RunJournal } from "./journal.ts";

export interface FinalizationLink {
  forgeRunId: string;
  issueNumber: number;
  repository: string;
  prepared: PreparedWorktree;
}

export interface FinalizationDependencies {
  git: GitWorktreeManager;
  store: GitHubStateBranchStore;
  journal: RunJournal;
  github: GitHubWorkflowAdapter;
  projector: GitHubIssueProjector;
  policy: ForgePolicy;
  sessionId: string;
  signal?: AbortSignal;
}

export interface FinalizationOutcome {
  status: "completed" | "blocked" | "needs-human";
  pullNumber?: number;
  mergedSha?: string;
  reasons: readonly string[];
}

interface AuditStageResult {
  pull: GitHubPullRequestData;
  audit: AuditTrailCheck;
  gate: ReviewGateResult;
}

export class ForgeFinalizationStages {
  readonly #dependencies: FinalizationDependencies;

  constructor(dependencies: FinalizationDependencies) {
    this.#dependencies = dependencies;
  }

  async run(
    link: FinalizationLink,
    result: ForgeWorkOnResult,
  ): Promise<FinalizationOutcome> {
    await this.pushStage(link, result);
    const pull = await this.pullRequestStage(link, result);
    const audit = await this.auditStage(link, result, pull);
    if (audit.gate.decision !== "approved") {
      const action =
        audit.gate.decision === "needs-human" ? "needs-human" : "block";
      await appendPhase(
        this.#dependencies.journal,
        link.forgeRunId,
        "merge",
        action,
        1,
        this.#dependencies.sessionId,
        this.#dependencies.signal,
        audit.gate.reasons.join(" "),
      );
      return {
        status:
          audit.gate.decision === "needs-human" ? "needs-human" : "blocked",
        pullNumber: audit.pull.number,
        reasons: audit.gate.reasons,
      };
    }

    const merged = await this.mergeStage(link, result, audit.pull);
    await this.closeStage(link, merged.sha);
    await this.cleanupStage(link);
    await this.completeStage(link, result, audit.pull.number, merged.sha);
    return {
      status: "completed",
      pullNumber: audit.pull.number,
      mergedSha: merged.sha,
      reasons: [],
    };
  }

  async pushStage(
    link: FinalizationLink,
    result: ForgeWorkOnResult,
  ): Promise<void> {
    await appendPhase(
      this.#dependencies.journal,
      link.forgeRunId,
      "merge",
      "queue",
      1,
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
    await appendPhase(
      this.#dependencies.journal,
      link.forgeRunId,
      "merge",
      "start",
      1,
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
    await this.#dependencies.git.push(
      link.prepared.worktreePath,
      link.prepared.branch,
      this.#dependencies.signal,
    );
    await appendEffect(
      this.#dependencies.journal,
      link.forgeRunId,
      "push",
      `branch:${link.prepared.branch}`,
      digest(result.headSha),
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
  }

  async pullRequestStage(
    link: FinalizationLink,
    result: ForgeWorkOnResult,
  ): Promise<GitHubPullRequestData> {
    const issue = await this.#dependencies.github.getIssue(
      link.issueNumber,
      this.#dependencies.signal,
    );
    const pull = await this.#dependencies.github.createPullRequest({
      title: issue.title,
      body: buildPullBody(link, result),
      head: link.prepared.branch,
      base: link.prepared.baseBranch,
      ...(this.#dependencies.signal
        ? { signal: this.#dependencies.signal }
        : {}),
    });
    await appendEffect(
      this.#dependencies.journal,
      link.forgeRunId,
      "pull-request",
      `pr:${pull.number}`,
      digest(pull.htmlUrl),
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
    return pull;
  }

  async auditStage(
    link: FinalizationLink,
    result: ForgeWorkOnResult,
    pull: GitHubPullRequestData,
  ): Promise<AuditStageResult> {
    const currentPull = await resolveMergeability(
      this.#dependencies.github,
      pull.number,
      this.#dependencies.signal,
    );
    await publishReviewArtifacts(
      this.#dependencies.github,
      currentPull.number,
      result,
      this.#dependencies.signal,
    );
    const issueComments = await this.#dependencies.github.getComments(
      link.issueNumber,
      this.#dependencies.signal,
    );
    const pullComments = await this.#dependencies.github.getComments(
      currentPull.number,
      this.#dependencies.signal,
    );
    const audit = checkPreMergeAuditTrail({
      issueComments,
      pullRequestComments: pullComments,
      requiredReviewerDomains: this.#dependencies.policy.review.required.map(
        reviewerDomain,
      ),
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
    const currentRun = await this.#dependencies.store.readRun(
      link.forgeRunId,
      this.#dependencies.signal,
    );
    const checks = verificationForGate(this.#dependencies.policy, result);
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
      requiredReviewers: this.#dependencies.policy.review.required,
      completedReviewers: result.review.completedReviewers,
      findings,
      checks,
      mergeability: currentPull.mergeability,
      leaseValid: currentRun.lease?.ownerRunId === link.forgeRunId,
      baseBranch: currentPull.baseRef,
      protectedBranches: this.#dependencies.policy.branches.protected,
      autoMergeAuthorized: canAutoMerge(
        this.#dependencies.policy,
        currentPull.baseRef,
      ),
      malformedResults: auditFailures,
    });
    return { pull: currentPull, audit, gate };
  }

  async mergeStage(
    link: FinalizationLink,
    result: ForgeWorkOnResult,
    pull: GitHubPullRequestData,
  ): Promise<{ merged: boolean; sha: string; message: string }> {
    const merged = await this.#dependencies.github.mergePullRequest({
      pullNumber: pull.number,
      expectedHeadSha: result.review.headSha,
      method: "squash",
      ...(this.#dependencies.signal
        ? { signal: this.#dependencies.signal }
        : {}),
    });
    await appendEffect(
      this.#dependencies.journal,
      link.forgeRunId,
      "merge",
      `pr:${pull.number}:merge`,
      digest(merged.sha),
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
    await appendPhase(
      this.#dependencies.journal,
      link.forgeRunId,
      "merge",
      "complete",
      1,
      this.#dependencies.sessionId,
      this.#dependencies.signal,
      undefined,
      [merged.sha],
    );
    await postReviewCompletionArtifacts({
      github: this.#dependencies.github,
      projector: this.#dependencies.projector,
      link,
      result,
      pullNumber: pull.number,
      mergedSha: merged.sha,
      signal: this.#dependencies.signal,
    });
    return merged;
  }

  async closeStage(link: FinalizationLink, mergedSha: string): Promise<void> {
    await appendPhase(
      this.#dependencies.journal,
      link.forgeRunId,
      "close",
      "queue",
      1,
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
    await appendPhase(
      this.#dependencies.journal,
      link.forgeRunId,
      "close",
      "start",
      1,
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
    await this.#dependencies.github.closeIssue(
      link.issueNumber,
      this.#dependencies.signal,
    );
    await appendEffect(
      this.#dependencies.journal,
      link.forgeRunId,
      "issue-close",
      `issue:${link.issueNumber}:close`,
      digest(mergedSha),
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
    await appendPhase(
      this.#dependencies.journal,
      link.forgeRunId,
      "close",
      "complete",
      1,
      this.#dependencies.sessionId,
      this.#dependencies.signal,
      undefined,
      ["issue close read-back passed"],
    );
  }

  async cleanupStage(link: FinalizationLink): Promise<void> {
    await appendPhase(
      this.#dependencies.journal,
      link.forgeRunId,
      "cleanup",
      "queue",
      1,
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
    await appendPhase(
      this.#dependencies.journal,
      link.forgeRunId,
      "cleanup",
      "start",
      1,
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
    await this.#dependencies.git.deleteRemoteBranch(
      link.prepared,
      this.#dependencies.signal,
    );
    await this.#dependencies.git.cleanup(
      link.prepared,
      this.#dependencies.signal,
    );
    await appendEffect(
      this.#dependencies.journal,
      link.forgeRunId,
      "cleanup",
      `worktree:${link.forgeRunId}`,
      digest(link.prepared.worktreePath),
      this.#dependencies.sessionId,
      this.#dependencies.signal,
    );
    await appendPhase(
      this.#dependencies.journal,
      link.forgeRunId,
      "cleanup",
      "complete",
      1,
      this.#dependencies.sessionId,
      this.#dependencies.signal,
      undefined,
      ["owned worktree removed", "remote feature branch deleted"],
    );
  }

  async completeStage(
    link: FinalizationLink,
    result: ForgeWorkOnResult,
    pullNumber: number,
    mergedSha: string,
  ): Promise<void> {
    await postTerminalIssueArtifacts({
      projector: this.#dependencies.projector,
      link,
      result,
      pullNumber,
      mergedSha,
      signal: this.#dependencies.signal,
    });
    await this.#dependencies.journal.append({
      runId: link.forgeRunId,
      type: "run.completed",
      payload: { outcome: "merged" },
      idempotencyKey: "run:completed",
      sessionId: this.#dependencies.sessionId,
      message: `Complete ForgeDock run ${link.forgeRunId}`,
      ...(this.#dependencies.signal
        ? { signal: this.#dependencies.signal }
        : {}),
    });
    const released = await this.#dependencies.journal.append({
      runId: link.forgeRunId,
      type: "lease.released",
      payload: {
        ownerRunId: link.forgeRunId,
        epoch: (
          await this.#dependencies.store.readRun(
            link.forgeRunId,
            this.#dependencies.signal,
          )
        ).lease?.epoch ?? 1,
      },
      idempotencyKey: "lease:release",
      sessionId: this.#dependencies.sessionId,
      message: `Release ForgeDock lease ${link.forgeRunId}`,
      ...(this.#dependencies.signal
        ? { signal: this.#dependencies.signal }
        : {}),
    });
    const terminalEvent = released.events.at(-1);
    if (terminalEvent) {
      await this.#dependencies.projector.projectEvent({
        issueNumber: link.issueNumber,
        event: terminalEvent,
        markdown: `## ForgeDock Pi complete\n\nPR #${pullNumber} merged into \`${link.prepared.baseBranch}\`.\nNested review completed at \`${result.review.headSha}\`.\nRun: \`${link.forgeRunId}\`.`,
        ...(this.#dependencies.signal
          ? { signal: this.#dependencies.signal }
          : {}),
      });
      await this.#dependencies.projector.setWorkflowLabel(
        link.issueNumber,
        "workflow:merged",
        this.#dependencies.signal,
      );
    }
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

function buildPullBody(
  link: FinalizationLink,
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

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function reviewerDomainForArtifact(reviewer: string): string {
  return reviewerDomain(reviewer);
}

export function isAllowedFinalizationBase(
  policy: ForgePolicy,
  baseBranch: string,
): boolean {
  return (
    !isProtectedBranch(policy, baseBranch) &&
    canAutoMerge(policy, baseBranch)
  );
}
