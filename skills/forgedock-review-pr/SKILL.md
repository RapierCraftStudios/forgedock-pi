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

Before route discovery, use direct Bash to read `forge.yaml` and verify `gh`
authentication and repository access. Use direct `gh` and `git` commands for all review
operations; do not use custom workflow runtime tools.

Follow the original phase order and hard rules. Freeze the exact PR head/base before
review. Before automated checks or reviewer fanout, run a direct Git structural gate.
For a work-on-owned PR, verify its durable `FORGE:BASE`, frozen route/head, ancestry, and
final Builder Contract/claim paths (including declared mechanically coupled paths).
Standalone reviews without a work-on claim instead require an exact frozen GitHub patch
and do not invent claim authority. A mismatch or inherited broad
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

Before summary publication, occurrence-deduplicate every finding, then route every new
public finding issue through the packaged `forgedock-issue` hook. The finding body must
extend—not replace—the global canonical Problem, Root Cause, Affected Files, Expected
Behavior, and Acceptance Criteria sections; preserve reviewer/head/evidence/fingerprint
metadata additively. A deduplicated legacy issue remains valid intake even when its body
is noncanonical; preserve it unchanged and let investigation normalize the claim. Do not
make formatting repair a reuse/admission gate. Post an official PR review tied to the frozen SHA. Merge only when `--auto-merge` was
explicit, the original blocking policy passes, route identity is unchanged, and the
base is authorized. Review never closes the linked issue or cleans the work-on tree.

## Refreshed integration bases

For a work-on-owned PR targeting `staging`, the launch `FORGE:BASE` SHA remains
immutable attribution, but the review base may advance after a verified sibling merge.
Before automated checks and reviewer fan-out, re-fetch `refs/heads/staging` and prove
any movement from the recorded base is an authorized reachable sibling merge. Require a
`FORGE:BASE_REFRESH` record with the old/new base, launch SHA, sibling merge SHA, and
refresh attempt. Preserve the existing PR and owned branch through a guarded,
non-destructive synchronization with the expected remote lease; conflicts, ambiguous
movement, or lease mismatch are automated `GATED` evidence.

Then recompute and freeze the exact refreshed base SHA, PR head SHA, and
`git merge-base` SHA. Rerun all affected verification and acceptance checks before
review. Invalidate every prior reviewer receipt and approval for merge authorization
and launch a fresh complete panel whose receipts bind to the refreshed tuple. A mixed,
partial, stale, or missing panel cannot produce a verdict or merge. Recheck the tuple,
clean tree, remote head, mergeability, and protected-branch policy immediately before
merge. See `specs/qualitative-review-protocol.md` for the shared protocol.

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

### Pinned review event and owner fallback
After semantic checks, coverage, findings, frozen head/base/merge-base, and mergeability pass, publish one review tied to the exact head. Use `gh api --method POST /repos/{owner}/{repo}/pulls/{number}/reviews -f event=APPROVE -f commit_id={head}` with a body containing semantic `APPROVED`, all three identity SHAs, coverage, checks, and finding IDs. If GitHub returns exactly the owner self-approval 422 for this APPROVE operation and the authenticated actor is the PR owner, publish one same-body `COMMENT`; do not fallback for any other status/message/identity/readback error. Read the created review back, require its URL, actor, commit, event, and byte-identical evidence, and persist it as `review_url`. COMMENT records semantic approval but is not an independent branch-protection approval; protected routes remain GATED unless policy supplies a distinct approving identity. Replay reconciles the saved review and never posts a duplicate.
