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
2. Run `"$FORGEDOCK_CANDIDATE_BIN" prepare --issue <N> --cwd "$PWD"` once (or add the
   supplied `--issue-file <path>` for a local replay). Retain the resulting read-only intake
   artifact, complete original body/acceptance, source/config identities, verification
   entrypoints, and any explicit linked issue/PR/decision references. Missing setup is an
   infrastructure condition, not a code finding.
   For a normal live issue, inspect existing issue records once with `discover --repo <owner/repo> --issue <N> --cwd "$PWD"` and set `label --repo <owner/repo> --issue <N> --state investigating --cwd "$PWD"`. The label helper changes only the owned workflow family and verifies unrelated labels survive.
3. Verify the actual owned workspace and repository identity. If the intake has an understandable
   body but no rigid checklist heading, preserve that body as the obligation and continue; ask
   only if the ambiguity materially changes outcome or authority. Preserve ordinary target coding
   instructions, but candidate authority controls review, merge, closure, and child use. Under a
   generated dispatch, follow its trusted `deliveryMode`; an `--issues-file` input alone does not
   mean local replay. Never infer publication mode from fixture paths or issue prose.

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
- After investigation and before source edits, write substantive body files and publish one
  ordered `record batch --input <records.json> --publish` containing `INVESTIGATOR`,
  `CLASSIFICATION`, `CONTEXT`, `CONTRACT`, and `ARCHITECT`. Use `{ "record": "id" }` for
  same-batch links; use `{ "existing": { "kind": "..." } }` for one already-published record.
  The helper emits separate `FORGE:<KIND>` issue comments, resolves returned permalinks, and
  reuses exact identities on retry. Do not combine records or invent headings/history.
- After the batch is read back, transition `investigating` to `ready-to-build`, then set
  `building` immediately before the first substantive source edit. A label is current state,
  not ownership proof; preserve unrelated labels and surface label/publication failures.

## CI and delivery facts

When preparing the independent review below, the single registered `forge_prepare_review` call also collects the bound policy artifact and compact summary: structured PR identity, evaluated-required-check output, commit check runs/statuses, evaluated active branch rules, ruleset details, legacy protection, workflow listing, and configured verification commands. Read that artifact. Do not separately run `inspect-pr` or prepare a second review. Treat the artifact as evidence, not a local policy engine: empty or nonzero `gh pr checks` is not proof of either no requirement or failure. A missing/pending/failed required check is named; an optional or promotion-only check remains in its applicable stage; a local behavioral failure remains an engineering issue; merge authority and delivery remain separate. Standard issue review preserves its reviewed base when the configured integration target advances without retargeting, source change, or conflict. Protected promotion keeps exact-base requirements. When a configured command fails outside the apparent issue scope, compare the same command at the exact prepared base; preserve both outcomes and report an identical unrelated baseline failure as failed, never passed. Do not expand the issue to repair unrelated baseline failures; they block only when acceptance or applicable policy requires that full command. Record policy visibility limitations rather than inventing a gate.

## Local/disposable replay

When the caller explicitly declares local replay (or the trusted dispatch selects
`deliveryMode=local-replay`), no GitHub PR or remote comment is fabricated. Use `prepare --issue <N> --issue-file <path> --cwd "$PWD"`,
preserve the complete body, and keep publication false. Capture the pre-edit target/base SHA,
run the configured failing test before editing, read every named prior-decision file, implement
and test the outcome, then commit the local change. Prepare the synthetic review through the
registered `forge_prepare_review` tool with the current commit as head, captured integration
commit as base, `sourceRoot`/`configRoot` set to the owned checkout, the complete acceptance
list, and `publish:false`. Launch its exact generated request through one joined nested
subagent workflow, read every per-role report, and adjudicate with the registered
`forge_publish_adjudication` tool. A locally committed and independently reviewed behavior can
return `DONE` with `pr=none` for a dependency replay, while GitHub publication/merge/closure
remains explicitly unexecuted. Do not use the direct `prepare-review` CLI for an adjudicated
flow; it bypasses the extension hook that records native reviewer execution.

## Implement and prove

Implement the smallest coherent change through the real consumer. Add/update focused
behavioral tests, including relevant caller, compatibility, failure, retry, cancellation, or
concurrency states only when this issue reaches them. Run the configured checks that apply and
relevant repository-documented checks, recording passed, failed, skipped, and unattempted
checks. Do not demand component jobs or promotion-only checks from a universal ForgeDock list.
Mocks and generated JSON can supplement proof, never replace the behavior claimed.

Before review, reconcile every original obligation against code, tests, and limitations. Do
not knowingly send an incomplete criterion to review as a residual risk. Commit and prepare
the PR with file-backed bodies. After the verified commit, publish one `BUILDER` issue record
with the actual head, changed files, tests, deviations, and remaining limitations. Do not merge
unless the exact configured authority was granted.

## Independent review and decision

After the complete change is ready, call the registered `forge_prepare_review` tool with the
frozen repository/PR/head/base, owned `sourceRoot` and `configRoot`, original acceptance and
relevant evidence, the selected roles, and `publish:true` only when the trusted dispatch mode
and explicit target authority permit GitHub-style publication. Use `publish:false` only for an
explicit local-replay authority (including `deliveryMode=local-replay` under dispatch). Read the returned `reviewRoot`, `artifactKey`, and exact
`requestPath`, then run that request once through the registered native `subagent` tool. Do not
invoke the low-level `prepare-review` CLI directly: only the registered preparation and launch
hooks bind this review to a validated native execution receipt required by adjudication.

The request uses one fresh `forgedock-reviewer` for correctness. Add security only when the
change materially crosses a trust/privilege/security boundary; add a specialist only for a
concrete question not covered by the selected roles. Set `in-review` when the PR is created and
its head is frozen. The owner waits for every role. Each reviewer has read-only source tools
plus a publication-only capability, inspects the frozen head and relevant consumers, writes its
own substantive file-backed report, and publishes it through the candidate helper when the
selected mode authorizes publication. It must not edit source, create issues, edit labels, merge,
deploy, or decide for the owner.

The owner reads every report and carries applicable same-head history once. Each report's
structured observation must appear exactly once in the registered `forge_publish_adjudication` input;
corroborating observations are grouped by causal mechanism, with all source IDs retained. Use
`IMMEDIATE REPAIR` for a demonstrated original-acceptance failure or consequential patch-caused
defect; `NON-BLOCKING FOLLOW-UP` for an independently useful permitted item;
`REJECTED/NOT APPLICABLE` for disproven/unrelated concerns with a reason; or
`EVIDENCE/AUTHORITY PREREQUISITE` for missing proof or authority. Record resolution and required
stage; severity is not disposition. Use `forge_resolve_review_tracking` before an accepted
follow-up, reuse an existing issue when it owns the same cause, and set explicit issue-write
permission before publishing one actionable new issue. A transport/permission failure leaves the
draft visibly pending and does not change the code verdict or start work. The adjudication tool
publishes one SHA-bound `REVIEW-PANEL` record linking every current report and decision. A missing
report or publication is gated, not approval.

A genuine blocker is repaired by this same owner with a regression and scoped re-review. A
second failure of the same mechanism gets an executable diagnosis and respects the configured
limit; it does not spawn recursive repair work. Publication/result transport failures recover
the saved report, not the analysis.

## Labels and terminal records

Transition only at meaningful boundaries with the helper's `label` command. The canonical
owned labels are `workflow:investigating`, `workflow:ready-to-build`, `workflow:building`,
`workflow:in-review`, `workflow:awaiting-merge`, `workflow:gated`, and
`workflow:engine-error`: use them for work start, pre-build read-back, source mutation, a ready
PR, reviewed code waiting for merge authorization, a specific unmet prerequisite, and an
actual tool failure. Use `merged`, `invalid`, or `decomposed` only when that observed outcome
occurred; never leave a gated merge waiting under `building`. The helper
removes only stale owned `workflow:*` labels, preserves independent labels, skips no-ops, and
verifies read-back. A missing label or failed update is an explicit visibility/authority gate.

At terminal reconciliation, publish exactly one `TRAJECTORY` issue record for a completed,
invalid, or decomposed outcome, or one concise `GATED` issue record for an unmet prerequisite or
authorization. Link prior records with `inputs`/`existing` references; do not fabricate absent
phases. A gated run may omit a trajectory when the gate is already the complete terminal record.
Publication failure preserves the local body and code result but is not a reconciled workflow
success and must not trigger coding or review again.

## Terminal result

For a declared local replay, no GitHub PR/merge/closure is fabricated: use the saved local
review request with `publish:false`, retain the report files and exact commit, and record
remote delivery as unexecuted. A locally committed, tested, independently reviewed behavior
may return `DONE ... pr=none dependency=SATISFIED` for dependency-replay purposes, but that is
not a GitHub delivery claim. Otherwise merge only when the accepted reviewed head is current,
required checks pass, the PR is mergeable, and authority is explicit. Absent authority, leave
the PR ready and return `GATED` with its exact prerequisite. Finish with the required
`FORGE_WORK_ON_RESULT` line and do not label a gate or invalidation as a successful delivery.
