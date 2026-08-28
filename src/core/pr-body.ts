/**
 * Authoritative pull-request body renderer. The implementing agent authors the
 * narrative (problem, approach, testing); the pipeline contributes verified
 * mechanics (files, checks, review verdicts, evidence). The body must stand
 * alone so future agents can mine the reasoning, not just a run id.
 */

export interface PullBodyInput {
  issueNumber: number;
  issueTitle: string;
  issueBody?: string;
  runId: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  /** Authorial: the defect and why it matters. */
  summary: string;
  /** Authorial: the fix strategy and design decisions. */
  approach: string;
  /** Authorial: what was actually run and what happened. */
  testingNotes?: string;
  /** Per-file change notes from the implement artifact, when available. */
  fileNotes?: ReadonlyArray<{ path: string; change: string }>;
  changedFiles?: readonly string[];
  additions?: number;
  deletions?: number;
  verification?: ReadonlyArray<{ name: string; status: string; evidence?: string }>;
  reviewSummary?: string;
  residualRisks?: readonly string[];
}

function firstParagraph(body: string | undefined): string {
  if (!body) return "";
  const lines = body.trim().split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && out.length > 0) break;
    if (/^(---|<!--)/.test(line.trim())) break;
    out.push(line);
    if (out.join(" ").length > 600) break;
  }
  return out.join(" ").trim();
}

function fileChanges(
  fileNotes: PullBodyInput["fileNotes"],
  changedFiles: PullBodyInput["changedFiles"],
): string {
  if (fileNotes && fileNotes.length > 0)
    return fileNotes
      .map((note) => `- \`${note.path}\`: ${note.change}`)
      .join("\n");
  if (changedFiles && changedFiles.length > 0)
    return changedFiles.map((file) => `- \`${file}\``).join("\n");
  return "- (no tracked changes)";
}

export function renderPullBody(input: PullBodyInput): string {
  const issueContext = firstParagraph(input.issueBody);
  const statLine =
    input.additions !== undefined && input.deletions !== undefined
      ? `**Diff**: +${input.additions} / −${input.deletions} across ${input.changedFiles?.length ?? 0} file(s)\n\n`
      : "";
  const checks = (input.verification ?? [])
    .map((check) => `- ${check.name}: **${check.status}**${check.evidence ? ` — ${check.evidence}` : ""}`)
    .join("\n");
  const risks = (input.residualRisks ?? []).filter((r) => r.trim());
  return [
    "## Summary",
    input.summary.trim(),
    "",
    "## Problem",
    issueContext || input.issueTitle,
    "",
    "## Approach",
    input.approach.trim(),
    "",
    "## Changes",
    statLine + fileChanges(input.fileNotes, input.changedFiles),
    "",
    "## Testing",
    input.testingNotes?.trim() || "- No local verification configured; GitHub CI is authoritative on the promotion path.",
    checks ? `\n### Recorded checks\n${checks}` : "",
    "",
    "## Review",
    input.reviewSummary?.trim() || "- Fresh correctness and security panels at the frozen head; results posted after completion.",
    ...(risks.length ? ["", "## Residual risks", ...risks.map((r) => `- ${r}`)] : []),
    "",
    "---",
    `Closes #${input.issueNumber}`,
    `**Implementation branch**: \`${input.branch}\` · **Base**: \`${input.baseBranch}\``,
    `**ForgeDock run**: \`${input.runId}\` · **Frozen head**: \`${input.headSha}\``,
    "",
  ]
    .filter((section) => section !== "")
    .join("\n");
}
