---
name: forgedock-review-pr
description: Run the authoritative context-aware ForgeDock review for an exact PR, including routing, verification, risk-derived fresh reviewers, finding issues, verdict, and optional guarded merge.
---

# ForgeDock Review PR

## Required loading

1. Read `../../specs/pi-adapter.md` completely.
2. Parse the arguments appended to this skill invocation.
3. Read the headings of `../../specs/original/commands/review-pr.md`, then load only the
   current phase in bounded chunks as review advances; do not preload later phases.
4. During reviewer selection, read
   `../../specs/original/commands/review-pr-agents/protocols.md` and only the selected
   persona files in that directory.

## Execution contract

Use direct Bash with `gh` and `git` commands for all review operations; verify `gh`
authentication and repository access first. The original specification is authoritative
for phase order, hard rules, automated checks, reviewer selection, findings, verdicts,
and merge policy. Follow it. The Pi adapter only translates runtime mechanics (skill
references, subagent dispatch, `$FORGE_HOME` paths).

Freeze the exact PR head/base from GitHub before review. Every PR is independently
reviewable: a standalone review requires no work-on pipeline state and runs the same
checks and reviewer panel as a pipeline review.
Automatically switch to the staging strategy when the selector or actual route targets
the protected/default branch as specified; load
`../../specs/original/commands/review-pr-staging.md` directly rather than emitting a
nested slash command.

Run configured automated and integration checks. Derive the reviewer roster from the
actual risk surface, and calibrate reviewer effort to that risk: documentation-only,
template, or single-file metadata lanes run their panel at medium thinking effort;
lanes touching executable code paths, security/auth/data/concurrency surfaces, or
cross-file integration run it at high. Set the effort per reviewer task via the model
thinking suffix — never by lowering the blocking standard. For a remediation re-review
of a head with known blockers, the panel is scoped to exactly the remediated change:
reviewers are the personas that produced the blocking findings plus one general
reviewer, each receiving the remediated hunks and the blocker's invariant, verifying
whether the blocker remains reachable on the frozen new head. When a review returns
multiple blockers plus non-blocking findings, remediation is one cohesive pass on the
existing PR branch: every blocker is fixed in the same head in the same worktree —
never one head per blocker — and the scoped blocker-persona re-review verifies all
blocker invariants on that single new head in one review round. A full-domain union
panel is never required to verify a blocker closure — re-reviewing everything
re-introduces the round-count and wall-clock spiral that stalled the previous
generation of this pipeline. Prepare each reviewer bundle
deterministically yourself: fetch the full diff once, slice it per reviewer with its
persona and identity, and pass it inline. Use the owning route's retained full child
model; a standalone review resolves it once from `forge.yaml` (`subagent_model`, then
`default_model`). Never pass legacy aliases. Launch the complete
panel concurrently with the adapter's one synchronous `workflowScript`/`runs.all`, not
separate subagent calls. Each reviewer posts and exact-ID reads back its own role-scoped
exact-head comment. Validate that returned ID directly with `jq` and fixed strings, not a
search across comments or a shell regex. Join and validate every result/readback before
synthesis; never proxy-post or use a partial panel as the verdict. Retain every valid
same-head role result and retry only a missing or invalid role under the same panel
attempt with a new workflow key—never relaunch roles that already succeeded.

For a PR owned by work-on, keep blocking findings on the existing PR and source issue
for cohesive remediation; do not create recursive blocker issues. Create or deduplicate
an issue through `forgedock-issue` only for valuable independent follow-up work that
should outlive the PR, grouping one cohesive concern once. Standalone and staging review
retain the original finding-publication contract. Post exactly one official review tied
to the frozen SHA. Merge only when `--auto-merge` was explicit and the original blocking
policy passes. Review never closes the linked issue or cleans the work-on tree.
