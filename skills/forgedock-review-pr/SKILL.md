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

Before route discovery or GitHub access, call `forgedock_preflight` and use
`forgedock_github` for every repository GitHub read and write. Missing tools or failed
capabilities stop before review artifacts are created.

Follow the original phase order and hard rules. Freeze the exact PR head/base before
review. Before automated checks or reviewer fanout, run a structural pre-review gate.
For a work-on-owned PR, call `forge_verify_lane_scope` with its durable `FORGE:BASE`,
frozen route/head, and final Builder Contract/claim (including declared mechanically
coupled paths). Standalone reviews without a work-on claim instead require an exact
frozen GitHub patch and do not invent claim authority. A mismatch or inherited broad
branch history is automated GATED evidence. Do not launch reviewers, create patch
findings, or add `needs-human` until this gate passes.
Automatically switch to the staging strategy when the selector or actual route targets
the protected/default branch as specified; load
`../../specs/original/commands/review-pr-staging.md` directly rather than emitting a
nested slash command.

Run configured automated and integration checks. Derive the reviewer roster from the
actual risk surface. Launch one complete fresh-context reviewer panel with Pi subagents
and join every selected reviewer. Every reviewer task must say that blocking findings
are limited to defects introduced or made reachable by the frozen patch, cite the
changed hunk or changed-path call chain, and may return a clean approval. Reviewers may
trace callers for evidence, but pre-existing debt, style, speculative hardening, and
unrelated redesign are non-blocking follow-up issues.

Use `timeoutMs: 3600000` for every max-thinking reviewer and omit the parent deadline or
set it to at least `3900000`. Never use 120000/180000 ms reviewer deadlines. Active
reasoning is not provider inactivity. Pi's generic 1,800-second attention event is not
a timeout; callers must continue waiting with `stopOnAttention: false` and must not
steer, resume, replace, or duplicate an active reviewer before its real deadline.

Create or deduplicate a GitHub issue for every finding before summary publication.
Post an official PR review tied to the frozen SHA. Merge only when `--auto-merge` was
explicit, the original blocking policy passes, route identity is unchanged, and the
base is authorized. Review never closes the linked issue or cleans the work-on tree.

## Recovery contract

Persist each reviewer result as an exact `head + role + attempt` receipt before joining.
A completed detached reviewer receipt is reusable verbatim; never rerun its siblings.
On recoverable transport interruption, resume the retained reviewer when supported;
launch a fresh same-head reviewer only when the prior run is definitively unrecoverable.
Mixed-head, malformed, or partial panels remain actionable gate failures and can never
synthesize or merge.

Operational timeout/provider failure leaves the issue in an automated review-degraded
or `workflow:in-review` state, not `needs-human`. Reserve `needs-human` for a genuine
human authority decision or unavoidable external action. Pi receipts prove execution
only; recover the complete saved result or fail closed rather than claiming completion.
