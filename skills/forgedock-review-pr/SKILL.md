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

Follow the original phase order and hard rules. Freeze the exact PR head/base before
review. Automatically switch to the staging strategy when the selector or actual route
targets the protected/default branch as specified; load
`../../specs/original/commands/review-pr-staging.md` directly rather than emitting a
nested slash command.

Run configured automated and integration checks. Derive the reviewer roster from the
actual risk surface. Launch one complete fresh-context reviewer panel with Pi subagents
and join every selected reviewer. Reviewers start from the frozen diff but retain
repository read/search access for evidence tracing.

Create or deduplicate a GitHub issue for every finding before summary publication.
Post an official PR review tied to the frozen SHA. Merge only when `--auto-merge` was
explicit, the original blocking policy passes, route identity is unchanged, and the
base is authorized. Review never closes the linked issue or cleans the work-on tree.

## Recovery contract

Persist each reviewer result as an exact `head + role + attempt` receipt before joining.
A completed detached reviewer receipt is reusable verbatim; never rerun its siblings.
If one reviewer times out or becomes provider-inactive, retain completed receipts and
retry only the missing role once with the capped extended timeout. Cancellation and
parent termination are not retryable. Mixed-head, malformed, or partial panels remain
actionable gate failures and can never synthesize or merge. Parent deadlines must
exceed nested reviewer timeout plus join grace, or be omitted. Pi subagent resume
receipts are execution evidence only: if JavaScript continuation is unavailable,
recover the complete saved result or fail closed rather than claiming continuation.
