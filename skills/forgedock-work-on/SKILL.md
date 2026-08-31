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

Before composing the contract, read
`../../specs/original/commands/work-on/build.md` with `--phase-role coordinator` and
execute its B0-B2 planning requirements without source mutation, including the explicit complexity classification.
Before the first `write` or `edit` of source, post a complete `FORGE:CONTRACT` derived only
from the investigation: task type, approach, per-file change/why table, acceptance
mapping, quality considerations, out-of-scope items, alternatives, and one concise
execution path from the active public/production entrypoint through every owning
caller/adapter and changed boundary to an observable result and exact public-seam test.
Every executable owner of the requested effect must be a deliverable unless exact source
evidence proves it already performs the behavior. A related/read-only owner, test-local
fixture/mock, unwired export, or prose path cannot substitute for production wiring. For bug fixes, include a safe failing-before
reproduction when one is deterministic. For every HIGH architecture risk, require one
closed verification row with its failure scenario, discriminating inputs or full durable-
state sequence, and named executable test; omit this table when no HIGH risks exist. For
irreversible/provider side effects, include a closed Provider Transaction Proof before
builder launch, with one row per actual mutation or fallback: authority/preconditions,
exact call and failure scope, required result/readback, replay/recovery, and a deterministic
test. A fallback may be authorized only by failure of its named operation. When running under orchestration, post the
finalized affected-file `FORGE:CLAIM` on the coordination issue; standalone work-on has
no coordination claim. A path absent from the
investigation and contract cannot be mutated; a discovered scope gap returns to
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

## Fresh build handoff

If the authoritative Task Type is `Investigation`, keep it in the coordinator and execute
the `build/implement.md` Investigation special case with its mandatory read-only research
fanout and packaged `forgedock-issue` creation; it has no mutation-builder handoff.
`Feature (UI/UX)` and `Full-Stack` also remain coordinator-owned so the existing mandatory
frontend-design skill and browser-capability route is preserved.

For every other confirmed build task, after completed B0-B2 planning, contract, complexity marker,
exact `FORGE:BASE`, and any required orchestration claim are durable, launch exactly one packaged
`forgedock-builder` with `context: "fresh"` and `acceptance: false`. Pass the
authoritative issue worktree as its `cwd`: the coordinator's current managed cwd under
orchestration, or the B1 worktree for standalone build. Do not allocate another managed
worktree, pass the coordinator transcript, or inject generic harness acceptance. The issue-specific GitHub
acceptance contract remains authoritative. Wait synchronously and do not mutate the worktree while the builder runs.
The task supplies issue/repository identity, cwd authority, `--phase-role builder`, exact
`--expected-base-sha`, exact `--expected-branch`, optional `--coord-issue`, and the required
durable markers. The builder rehydrates its primary context from
GitHub and must read `specs/original/commands/work-on/build.md` with
`--phase-role builder` before any other repository file or source mutation.

The builder executes context, architecture, implementation, quality-gate, validation,
acceptance, and commit work inline from the original specifications. Architecture must
close Production Seam Ownership for every observable effect before mutation; unresolved
or test-only production wiring returns to investigation rather than review. Provider work also requires a closed Provider Transaction Proof and passing tests for its
actual operation/fallback rows. Every HIGH-risk verification row must pass before build
completion. Missing
`FORGE:ARCHITECT:COMPLETE` is never an implicit skip; a legitimate skip uses the explicit
completed skip artifact from `build/architect.md`. The coordinator must not replace a
failed builder with inline implementation.

Before push or PR creation, independently require the returned commit to equal clean
`HEAD`, retain frozen-base ancestry, and have every changed/new path covered by the
latest contract and any required orchestration claim. Re-read the issue and require the architecture
artifact, real validation evidence, and commit-bound `FORGE:BUILDER:COMPLETE`. A missing,
ambiguous, or mismatched result is automated `GATED`, not a reason to improvise or add
`needs-human`.

Do not stop at an intermediate success. Investigation completion, builder completion,
quality-gate pass, commit, PR creation, review completion, and PR merge all require the
next phase unless the original dispatcher identifies a terminal state.

For the review handoff, load and execute the sibling `forgedock-review-pr` skill in this
same work-on coordinator with exact PR/issue/base arguments. Before reviewer fanout,
freeze the remote PR route and use direct Git to verify the durable `FORGE:BASE`, exact
clean head, target ancestry, and marker-to-head path coverage against the final claim. A
mismatch is automated GATED evidence; do not launch reviewers or convert inherited
branch history into review findings.
Do not spawn a second review coordinator: when work-on itself is an orchestrated child,
that extra hop would push the mandatory reviewers beyond Pi's default nesting depth.

The work-on coordinator may use its child-safe `subagent` tool only for the one fresh
`forgedock-builder` handoff, the complete bounded fresh-context reviewer panel selected
by the review skill, and the mandatory read-only research fanout of an Investigation task. Builder and reviewers run sequentially as sibling children; neither
may launch subagents. Join every selected reviewer before synthesis and continuation.
Reviewer operational timeouts for max-thinking models are 3,600,000 ms; parent/join
windows are omitted or at least
3,900,000 ms. A generic 1,800-second attention event is not a reviewer timeout: continue
waiting without steering by using `stopOnAttention: false` while the reviewer deadline
is valid. Operational timeout, provider loss, branch-base mismatch, and other
mechanically recoverable failures remain automated GATED/review-degraded states and
must not add `needs-human`.

Review blocks only patch-introduced or patch-reachable defects. Deduplicate and file
pre-existing findings as non-blocking follow-ups. On `CHANGES REQUESTED`, load
`work-on/remediate.md` explicitly with `--inline-review-blockers --reviewed-head <SHA>
--round <N>` plus the exact PR/issue/base arguments; never enter inline remediation by
inference. Read the authoritative cap from `forge.yaml` key
`review.remediation_max_rounds` (default `3` only when absent), count distinct substantive
reviewed remediation heads in the durable PR markers, and fail closed before a new head
or panel when the next round exceeds that cap.

Reload only blockers bound to the exact current reviewed head. Revalidate any legacy
unbound finding against that head and publish a head-binding marker before it can enter
remediation; unidentifiable findings remain open and cannot be auto-closed. Cluster the
bound blockers by shared invariant and post exactly one `FORGE:REMEDIATION_PLAN` updating
the contract. That plan must contain a blocker closure matrix with one row per blocker
occurrence: reviewer scenario/evidence, shared invariant, affected code boundary, and a
failing-before/passing-after regression command. When a safe deterministic test cannot
reproduce a row, record an equivalent machine-checkable proof and why a test is
unavailable. Apply one cohesive patch and at least one end-to-end test for the shared
invariant rather than patching findings one at a time.

Do not publish a new remediation head or launch its fresh panel until every closure row
passes locally. In non-interactive/headless execution, run verification directly in the
coordinator unless a background mechanism durably persists the same-lifecycle continuation
and automatically wakes it on completed, failed, killed, or cancelled terminal state.
Resource-sensitive packed-package checks must run separately and serially and remain mandatory evidence;
a progress-only response is never terminal verification.

For every irreversible provider action, the closure matrix also proves authority and all
preconditions before the action, exact provider-result binding, idempotent replay after
provider success, and recovery from failure between side effect and durable receipt.
If fresh review proves no active caller, a new authority boundary, a dormant/legacy
implementation approach, or repeated HIGH blockers in the same invariant, stop local
remediation and publish `FORGE:REINVESTIGATE_REQUIRED`; investigation/decomposition alone
may replace the approach.

Same-head edit/test/replan iterations do not consume another round; one substantive new
head submitted to a fresh complete panel does. Close a finding only when the fresh
current-head review no longer returns its occurrence. Never launch another new-head panel
after cap exhaustion.

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
