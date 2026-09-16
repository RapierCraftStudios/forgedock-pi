---
name: forgedock-work-on
description: Own one issue end to end with evidence-first implementation and one independent review
---

# ForgeDock work-on

The visible session (or one `forgedock-owner` child under orchestration) is the only writer
for this issue. The issue body and acceptance obligations remain the contract. This skill is
an execution guide, not a second workflow engine.

## Prepare once

1. Resolve the issue selector and target repository/configuration once. Under orchestration,
   use the supplied issue body, target, workspace, model, and dependency binding; do not read
   sibling worktrees or target-local workflow files as authority.
2. Run `"$FORGEDOCK_CANDIDATE_BIN" prepare --issue <N> --cwd "$PWD"` once. Retain the
   resulting read-only intake artifact, source/config identities, verification entrypoints,
   and any explicit linked issue/PR/decision references. Missing setup is an infrastructure
   condition, not a code finding.
3. Verify the actual owned workspace and repository identity. Preserve ordinary target coding
   instructions, but candidate authority controls review, merge, closure, and child use.

## Investigate and contract

- Retrieve linked history first, then follow only decision-relevant commits/symbols. Record
  source → prior decision/failure → applicability → consequence; record no useful history when
  none exists.
- Establish observable expected versus actual behavior, the real producer/consumer path, the
  cause or bounded uncertainty, and the smallest experiment that distinguishes the fix.
- Demonstrate a safe failing regression before editing when feasible. For a new feature, prove
  absence then presence. For inspection-only work, state why execution is unavailable.
- Record a concise contract: original observable outcome; required behavior and scope;
  non-goals; concrete behavioral proof. Do not shrink acceptance to match a proposed patch.
- Save the investigation/plan record with `forge-candidate record`; use stable links and
  preserve original acceptance text. Do not invent headings or duplicate history.

## Implement and prove

Implement the smallest coherent change through the real consumer. Add/update focused
behavioral tests, including relevant caller, compatibility, failure, retry, cancellation, or
concurrency states only when this issue reaches them. Run the configured checks that apply,
using the actual source checkout and recording passed, failed, skipped, and unattempted checks.
Mocks and generated JSON can supplement proof, never replace the behavior claimed.

Before review, reconcile every original obligation against code, tests, and limitations. Do
not knowingly send an incomplete criterion to review as a residual risk. Commit and prepare
the PR with file-backed bodies. Do not merge unless the exact configured authority was granted.

## Independent review and decision

After the complete change is ready, run the generated native review request exactly once:

```text
Use subagent with the request file produced by:
"$FORGEDOCK_CANDIDATE_BIN" prepare-review --input <review-input.json> --out <review-dir>
```

The request uses one fresh `forgedock-reviewer` for correctness. Add security only when the
change materially crosses a trust/privilege/security boundary; add a specialist only for a
concrete question not covered by the selected roles. The parent waits for every role. Each
reviewer has read-only source tools plus a publication-only capability, inspects the frozen
head and relevant consumers, writes its own substantive file-backed report, and publishes it
through the candidate helper when GitHub write authority is available. It must not edit source, create issues, merge, deploy, or decide
for the parent.

The parent reads every report and deduplicates by causal mechanism. Disposition each concern:
`IMMEDIATE REPAIR` for a demonstrated original-acceptance failure or consequential
patch-caused defect; `NON-BLOCKING FOLLOW-UP` for an independently useful permitted item;
`REJECTED/NOT APPLICABLE` for disproven/unrelated concerns with a reason; or
`EVIDENCE/AUTHORITY PREREQUISITE` for missing proof or authority. Severity is not disposition.
Publish one SHA-bound decision record. A missing report/publication is gated, not approval.

A genuine blocker is repaired by this same owner with a regression and scoped re-review. A
second failure of the same mechanism gets an executable diagnosis and respects the configured
limit; it does not spawn recursive repair work. Publication/result transport failures recover
the saved report, not the analysis.

## Terminal result

Merge only when the accepted reviewed head is current, required checks pass, the PR is
mergeable, and authority is explicit. Then read back the merge and close the issue explicitly.
Absent authority, leave the PR ready and return `GATED` with its exact prerequisite. Finish
with the required `FORGE_WORK_ON_RESULT` line and do not label a gate or invalidation as a
successful delivery.
