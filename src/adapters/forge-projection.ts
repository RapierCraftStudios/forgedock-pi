import type { RunEvent, RunPhase } from "../core/events.ts";
import { GitHubIssueProjector } from "./github-projection.ts";

export type CheckpointAction =
  | "queue"
  | "start"
  | "complete"
  | "fail"
  | "block"
  | "needs-human"
  | "abandon";

export interface ForgeProjectionBinding {
  issueNumber: number;
  runId: string;
}

export interface PhaseProjectionInput {
  phase: RunPhase;
  attempt: number;
  action: CheckpointAction;
  evidence?: readonly string[];
  report?: string;
  reason?: string;
  commitSha?: string;
}

export class ForgeGitHubProjectionService {
  readonly #projector: GitHubIssueProjector;
  readonly #binding: ForgeProjectionBinding;

  constructor(
    projector: GitHubIssueProjector,
    binding: ForgeProjectionBinding,
  ) {
    this.#projector = projector;
    this.#binding = binding;
  }

  async projectPhase(
    event: RunEvent,
    params: PhaseProjectionInput,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      params.action === "complete" &&
      (params.phase === "resolve" ||
        params.phase === "prepare-worktree" ||
        params.phase === "review")
    )
      return;
    if (
      params.phase === "plan" &&
      params.action === "complete" &&
      params.report
    ) {
      for (const block of splitPlanReport(params.report)) {
        await this.#projector.postArtifact({
          issueNumber: this.#binding.issueNumber,
          runId: this.#binding.runId,
          eventId: event.eventId,
          artifactKey: block.key,
          markdown: block.body,
          ...(signal ? { signal } : {}),
        });
      }
      return;
    }
    await this.#projector.projectEvent({
      issueNumber: this.#binding.issueNumber,
      event,
      markdown: checkpointMarkdown(params, this.#binding.runId),
      addLabels: ["fail", "block", "needs-human"].includes(params.action)
        ? ["needs-human"]
        : [],
      ...(signal ? { signal } : {}),
    });
  }

  async projectDerived(
    event: RunEvent,
    params: PhaseProjectionInput,
    signal?: AbortSignal,
  ): Promise<void> {
    if (params.action !== "complete") return;
    if (params.phase === "investigate") {
      await this.#projector.postArtifact({
        issueNumber: this.#binding.issueNumber,
        runId: this.#binding.runId,
        eventId: event.eventId,
        artifactKey: "investigation-checkpoint",
        markdown: `<!-- FORGE:CHECKPOINT -->\n\`\`\`json\n${JSON.stringify({ phase: "INVESTIGATION", status: "COMPLETE", next_phase: "BUILD", timestamp: event.occurredAt })}\n\`\`\``,
        ...(signal ? { signal } : {}),
      });
      await this.#projector.postArtifact({
        issueNumber: this.#binding.issueNumber,
        runId: this.#binding.runId,
        eventId: event.eventId,
        artifactKey: "fast-path",
        markdown:
          "<!-- FORGE:FAST_PATH -->\n## Fast-Path Classification\n\n**COMPLEXITY_BAND**: STANDARD\n**Task type**: Bug Fix\n**Rationale**: Full Pi-native work-on pipeline selected from the confirmed investigation.\n**Phases skipped**: none — full pipeline",
        ...(signal ? { signal } : {}),
      });
    }
    if (params.phase === "verify") {
      await this.#projector.appendToLatestComment({
        issueNumber: this.#binding.issueNumber,
        marker: "<!-- FORGE:BUILDER -->",
        append: "<!-- FORGE:BUILDER:COMPLETE -->",
        skipIfContains: "<!-- FORGE:BUILDER:COMPLETE -->",
        ...(signal ? { signal } : {}),
      });
      await this.#projector.postArtifact({
        issueNumber: this.#binding.issueNumber,
        runId: this.#binding.runId,
        eventId: event.eventId,
        artifactKey: "build-checkpoint",
        markdown: `<!-- FORGE:CHECKPOINT -->\n${JSON.stringify({ phase: "BUILD", status: "COMPLETE", next_phase: "REVIEW", timestamp: event.occurredAt, commit: params.commitSha ?? null, acceptance_gate: "PASSED" })}`,
        ...(signal ? { signal } : {}),
      });
    }
  }

  async setWorkflowLabel(
    params: PhaseProjectionInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const label = workflowLabelForCheckpoint(params);
    if (label)
      await this.#projector.setWorkflowLabel(
        this.#binding.issueNumber,
        label,
        signal,
      );
  }
}

export function validatePhaseReport(phase: RunPhase, report: string): void {
  const requiredByPhase: Partial<Record<RunPhase, readonly string[]>> = {
    investigate: [
      "<!-- FORGE:INVESTIGATOR -->",
      "## Investigation Report",
      "### Root Cause",
      "### Evidence",
      "### Acceptance Spec",
      "<!-- INVESTIGATION:COMPLETE -->",
    ],
    plan: [
      "<!-- FORGE:CONTRACT -->",
      "## Builder Contract",
      "<!-- FORGE:CONTEXT -->",
      "<!-- FORGE:CONTEXT:COMPLETE -->",
      "<!-- FORGE:ARCHITECT -->",
      "<!-- FORGE:ARCHITECT:COMPLETE -->",
    ],
    implement: [
      "<!-- FORGE:BUILDER -->",
      "## Implementation Complete",
      "### Approach",
      "### Changes",
      "### Acceptance Criteria Status",
      "### Testing Checklist",
    ],
    verify: [
      "<!-- FORGE:ACCEPTANCE_GATE -->",
      "## Acceptance Gate — PASSED",
      "<!-- FORGE:LOCAL_VERIFICATION -->",
      "<!-- FORGE:IMPLEMENTATION_READY_FOR_CI -->",
      "<!-- FORGE:ACCEPTANCE_GATE:PASSED -->",
    ],
  };
  const missing = (requiredByPhase[phase] ?? []).filter(
    (marker) => !report.includes(marker),
  );
  if (missing.length > 0) {
    throw new Error(
      `Phase ${phase} report is missing canonical ForgeDock fields: ${missing.join(", ")}.`,
    );
  }
}

function splitPlanReport(report: string): Array<{ key: string; body: string }> {
  const markers = [
    { key: "builder-contract", marker: "<!-- FORGE:CONTRACT -->" },
    { key: "implementation-context", marker: "<!-- FORGE:CONTEXT -->" },
    { key: "architecture-plan", marker: "<!-- FORGE:ARCHITECT -->" },
  ];
  return markers.map((entry, index) => {
    const start = report.indexOf(entry.marker);
    if (start < 0) throw new Error(`Plan report is missing ${entry.marker}.`);
    const nextMarker = markers[index + 1];
    const end = nextMarker
      ? report.indexOf(nextMarker.marker, start + entry.marker.length)
      : report.length;
    if (end < 0)
      throw new Error(
        `Plan report markers are out of order near ${entry.marker}.`,
      );
    return { key: entry.key, body: report.slice(start, end).trim() };
  });
}

function checkpointMarkdown(
  params: PhaseProjectionInput,
  runId: string,
): string {
  if (params.action === "complete" && params.report) {
    validatePhaseReport(params.phase, params.report);
    return params.report.trim();
  }
  const evidence = params.evidence?.length
    ? `\n\n### Evidence\n${params.evidence.map((entry) => `- ${entry}`).join("\n")}`
    : "";
  const reason = params.reason ? `\n\n**Reason**: ${params.reason}` : "";
  return `## ForgeDock Phase — ${params.phase}\n\n**Status**: ${params.action}\n**Attempt**: ${params.attempt}\n**Run**: \`${runId}\`${reason}${evidence}`;
}

function workflowLabelForCheckpoint(
  params: PhaseProjectionInput,
): string | undefined {
  if (params.action === "start") {
    if (params.phase === "investigate") return "workflow:investigating";
    if (
      params.phase === "plan" ||
      params.phase === "prepare-worktree" ||
      params.phase === "implement" ||
      params.phase === "verify"
    ) {
      return "workflow:building";
    }
    if (params.phase === "review") return "workflow:in-review";
  }
  if (params.action === "complete" && params.phase === "investigate") {
    return params.report?.includes("**Verdict**: INVALID")
      ? "workflow:invalid"
      : "workflow:ready-to-build";
  }
  return undefined;
}
