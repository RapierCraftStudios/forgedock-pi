---
name: forgedock-review-pr
description: Run the authoritative context-aware ForgeDock review for an exact PR, including routing, verification, risk-derived fresh reviewers, finding issues, verdict, and optional guarded merge.
---

# ForgeDock Review PR

## Required loading

1. Read `../../specs/pi-adapter.md` completely.
2. Read `../../specs/original/commands/review-pr.md` completely in bounded chunks.
3. Parse the arguments appended to this skill invocation.
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
persona and identity (repository, PR, head SHA; remaining tuple fields optional), and
pass it inline — reviewers receive a complete bundle and never search for one. Launch
the fresh-context reviewer panel with Pi subagents and join every selected reviewer.
Reviewers start from the frozen diff but retain repository read/search access for
evidence tracing.

For a PR owned by work-on, keep blocking findings on the existing PR and source issue
for cohesive remediation; do not create recursive blocker issues. Create or deduplicate
an issue through `forgedock-issue` only for valuable independent follow-up work that
should outlive the PR, grouping one cohesive concern once. Standalone and staging review
retain the original finding-publication contract. Post exactly one official review tied
to the frozen SHA. Merge only when `--auto-merge` was explicit and the original blocking
policy passes. Review never closes the linked issue or cleans the work-on tree.
