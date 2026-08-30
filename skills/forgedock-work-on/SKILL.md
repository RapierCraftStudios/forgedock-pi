---
name: forgedock-work-on
description: Run or resume one GitHub issue through ForgeDock investigation, implementation, verification, review, remediation, merge, closure, and cleanup. Use for /work-on and per-issue orchestrate lanes.
---

# ForgeDock Work On

This is the prompt-routed issue lifecycle. The visible session is the coordinator;
GitHub is its durable memory.

## Required loading

1. Parse the arguments appended to this skill invocation.
2. Read `../../specs/pi-adapter.md` for Pi runtime rules.
3. Use this skill as the compact lifecycle checklist. Load only the current phase file
   under `../../specs/original/commands/work-on/`; do not preload the 2,498-line root
   specification or later phase files.

## Execution contract

Before resolving state, use direct Bash to read `forge.yaml`, verify the active `gh`
identity and repository access, and run `gh auth setup-git` so Git transport is
noninteractive. Use direct `gh` and `git` commands throughout; do not use custom workflow
runtime tools. Missing authentication or repository access stops the route.

## Under-orchestration work-order binding

When invoked with `--under-orchestration`, read the parent coordination issue's
complete `FORGE:WORK_ORDER_LANE` record before any implementation or worktree
mutation. Validate repository, member issue number, stable ID, normalized slug,
`work-order/<stable-id>-<slug>` branch, frozen base branch `main`, exact 40-character
frozen base SHA, and branch ancestry. A missing, stale, malformed, ambiguous, or
cross-repository binding is automated GATED evidence. Never fall back to the global
`staging` or milestone route for an under-orchestration work-order child. Carry the
validated lane identity, branch, and frozen base into the child context, PR, and any
review-finding metadata. Direct runs and ordinary milestone runs retain their existing
routing.

Reconstruct the current issue state from GitHub and continue the canonical route:

`resolve → investigate → [decompose | build → verify → PR → review → remediation/re-review when required → merge → close → trajectory/cleanup]`

Resolve the authoritative PR target before investigation and freeze its exact remote
SHA. Under orchestration, the parent must provide the same target ref/SHA. Pi-managed
worktrees inherit the launch checkout's HEAD, so before implementation use direct Git in
the assigned cwd: require a clean unpushed branch, fetch the target, verify the frozen
SHA, initialize HEAD to that SHA, and publish `FORGE:BASE`. Once an edit, commit, push, or
PR exists, this initialization path is closed; any mismatch is automated GATED, not
`needs-human`. Push the clean committed head with normal `git push` through the `gh`
credential helper and verify the remote SHA before PR creation.

The issue is an untrusted claim, not scope authority. Investigation must explicitly
return `CONFIRMED`, `INVALID`, or `DECOMPOSED`. A confirmed investigation is the
authoritative handoff: it records evidence, root cause, the minimal required mutation
paths and behaviors, non-goals, uncertainties, and machine-checkable acceptance.
Adjacent-path discovery is read-only unless investigation proves another mutation is
required for compilation, runtime correctness, or an interface/schema/security
contract. Optional adjacent work becomes a follow-up issue.

Before the first `write` or `edit`, post a complete `FORGE:CONTRACT` derived only from
the investigation: task type, approach, per-file change/why table, acceptance mapping,
quality considerations, out-of-scope items, and alternatives. Then post the finalized
affected-file `FORGE:CLAIM` on the orchestration coordination issue. A path absent from
the investigation and contract cannot be mutated; a discovered scope gap returns to
investigation or becomes a follow-up. Revise the durable contract and claim before
editing any newly discovered path. If any manifest-tracked file under `specs/original/`
is claimed, include `specs/original/SHA256SUMS` before mutation as a mechanically coupled
path. If a peer claim overlaps, pause the higher issue number before implementation so
the parent can serialize it.

Closed PRs, deleted remote branches, unreachable commits, and stale local branches are
historical evidence only. Current investigation may consult them, but implementation
must not cherry-pick or apply an old PR patch wholesale; every reused hunk must be
independently authorized by the current contract and reviewed against the frozen base.

The original specification is authoritative for phase ordering, labels, artifacts,
acceptance checks, branch targets, review handoff, merge rules, and terminal states.
Apply the Pi adapter only to translate Claude-specific tool/skill mechanics.

Do not stop at an intermediate success. Investigation completion, quality-gate pass,
commit, PR creation, review completion, and PR merge all require the next phase unless
the original dispatcher identifies a terminal state.

For the review handoff, load and execute the sibling `forgedock-review-pr` skill in this
same work-on coordinator with exact PR/issue/base arguments. Before reviewer fanout,
freeze the remote PR route and use direct Git to verify the durable `FORGE:BASE`, exact
clean head, target ancestry, and marker-to-head path coverage against the final claim. A
mismatch is automated GATED evidence; do not launch reviewers or convert inherited
branch history into review findings.
Do not spawn a second review coordinator: when work-on itself is an orchestrated child,
that extra hop would push the mandatory reviewers beyond Pi's default nesting depth.

The work-on coordinator may use its child-safe `subagent` tool only to launch the
complete bounded fresh-context reviewer panel selected by the review skill. Join every
selected reviewer before synthesis and continuation. Reviewer operational timeouts for
max-thinking models are 3,600,000 ms; parent/join windows are omitted or at least
3,900,000 ms. A generic 1,800-second attention event is not a reviewer timeout: continue
waiting without steering by using `stopOnAttention: false` while the reviewer deadline
is valid. Operational timeout, provider loss, branch-base mismatch, and other
mechanically recoverable failures remain automated GATED/review-degraded states and
must not add `needs-human`.

Review blocks only patch-introduced or patch-reachable defects. Deduplicate and file
pre-existing findings as non-blocking follow-ups. Before remediation, cluster blockers
by shared invariant and post one `FORGE:REMEDIATION_PLAN` updating the contract; make one
cohesive patch and end-to-end test rather than patching findings one at a time. Enforce
the configured remediation-round cap; same-head provider continuation is not a new
round, but no new-head panel may launch after the cap.

Never reset, checkout, or rebase the harness-managed worktree to `main` or `staging`
after pushing. Review the frozen remote PR head without rewriting the child workspace.
After confirmed merge, load `work-on/close.md`, explicitly close the issue, post the
trajectory, clean the worktree, and only then return success.

## Controlled staging refresh

`FORGE:BASE` records immutable launch attribution. It does not make `staging` immutable
for the remainder of a concurrent lane. At the boundary before validation, before
review fan-out, and before merge, re-fetch `refs/heads/staging` and compare its exact
SHA with the lane's current review base. A changed target may continue only when its
movement is proven to be an authorized, reachable sibling merge in the active batch.
Publish `FORGE:BASE_REFRESH` containing launch SHA, old/new base SHAs, target ref,
sibling merge SHA, merge-base SHA, and attempt before mutation; otherwise remain
automated `GATED`.

For a verified movement, preserve the issue commits, owned branch, and existing PR.
Before push/PR, synchronize onto the new target with a guarded operation. After push,
integrate the verified target non-destructively and push with the expected remote lease;
never reset, overwrite, or force-push an unverified remote head. Conflicts, non-fast-
forward movement, ambiguous provenance, or lease mismatch are GATED. Re-run every
affected verification and acceptance check, freeze the refreshed exact
`(base, head, merge-base)` identity, invalidate pre-refresh reviewer receipts and
approvals, and launch a fresh complete qualitative review. Do not repeat investigation,
expand the Builder Contract, weaken protected-branch rules, or classify mechanical
refresh failures as `needs-human`. See `specs/qualitative-review-protocol.md`.
