---
name: forgedock-orchestrate
description: Resolve and orchestrate a confirmed set of GitHub issues by dispatching one complete ForgeDock work-on skill per issue with safe dependency ordering and bounded concurrency.
---

# ForgeDock Orchestrate

The visible session is a dispatcher, never a builder.

## Required loading

1. Parse the arguments appended to this skill invocation.
2. Read `../../specs/pi-adapter.md` and
   `../../specs/original/commands/orchestrate/config.md` for runtime rules and defaults.
3. Use this skill as the compact execution checklist. Consult the original orchestrate
   specification only when a current decision is ambiguous; do not preload the root
   specification, phase files, or generic subagent reference corpus before dispatch.

## Execution contract

Before resolution, use direct Bash to read `forge.yaml`, verify `gh` authentication and
repository access, and configure `gh auth setup-git` for noninteractive Git transport.
Use direct `gh` and `git` commands for all workflow operations; do not use custom runtime
tools.

## Authoritative work-order route

When the original expression contains explicit `--work-order <slug>`, preserve that
slug separately from the resolved issue set. Before dispatch, freeze the exact deployed
`main` SHA (never `staging`), derive the normalized `wo-<slug>` identity and
`work-order/wo-<slug>-<slug>` branch, and create/reuse that remote ref with a guarded
no-force exact-SHA operation. A matching descendant may be reused; an unrelated or
ambiguous ref is an automated GATED stop. Persist one complete `FORGE:WORK_ORDER_LANE`
record on the coordination issue containing repository, stable ID, normalized slug,
branch, frozen base branch/SHA, and every member issue before launching any child.
The record is the authoritative binding; issue text and provider output are not.

For a work-order dispatch, each child receives the coordination issue and stable lane
identity in its task context. The child must read back the complete binding and refuse
to fall back to staging, milestone routing, or a different repository/branch/base.
Direct fast-lane and milestone expressions continue through their existing route.

Resolve and filter the requested issue set, show the concrete plan, and obtain the
original mandatory confirmation before launching any child unless `--auto` or
`--confirm` was explicitly supplied.

Build the minimum safe dependency graph from explicit dependencies, declared file
overlap, database/migration serialization, and configured global files. Detect cycles
and gate them visibly. Do not inspect or implement product code and never adjudicate
issue validity or duplicates.

For every ready issue, launch exactly one fresh `forgedock-work-on-coordinator` agent
with the `forgedock-work-on` skill and `<issue> --under-orchestration`. For a
work-order lane, include the coordination issue, stable lane ID, branch, repository,
and frozen base in the task context; the child must read back `FORGE:WORK_ORDER_LANE`
before implementation. Use bounded concurrency and isolated issue worktrees. Each child owns the complete issue lifecycle;
orchestrate must not invent a second implementation/review path.

The managed child worktree is the child's only repository root. In every child task,
state that its current working directory is authoritative and that any parent checkout
path is identity-only. Do not instruct a child to use the visible session's absolute
repository path, and do not pass that path as `repositoryRoot`; the child must use
relative paths and default ForgeDock runtime-tool roots from its assigned cwd. Treat an
anchor checkout that becomes dirty as a safety-critical batch stop.

Before dispatching each issue, resolve its authoritative PR target through the original
lane rules and freeze the exact remote target SHA. Persist that ref/SHA in the
coordination issue and child task. A Pi-managed worktree inherits the launch checkout's
HEAD; its generated branch is not evidence that it is based on the lane target. Require
the child to initialize and verify the clean unpushed branch with direct Git commands
and publish `FORGE:BASE` before any implementation mutation. A missing or mismatched base marker gates the
lane before contract/claim acceptance, push, PR creation, or reviewer fanout.

The packaged coordinator is an explicit, depth-bounded fanout child: it may launch only
the fresh read-only reviewers required by its review phase. Do not use the builtin
`worker` for a complete work-on lane, and do not give the coordinator a blanket "never
run subagents" instruction; forbid nested issue/work-on orchestration while preserving
its mandatory reviewer fanout.

Launch exactly one top-level orchestration `workflowScript` with `async: true` and
`control.needsAttentionAfterMs: 3900000` or greater. Capture the exact returned workflow
run ID. Because `/orchestrate` is run-to-completion, immediately wait on that exact run:

`subagent_wait({ id: "<workflow-run-id>", timeoutMs: 7200000, stopOnAttention: false })`

Do not end a headless parent turn and rely on Pi-subagents' fixed 1,800,000 ms agent-end
auto-drain. The explicit two-hour wait covers builder, valid one-hour review, merge,
issue closure, coordination cleanup, and terminal reconciliation while child lanes retain
bounded concurrency. A wait timeout, failed run, or unresolved work remains visible
GATED/FAILED evidence and cannot be reported as successful orchestration. Pi's generic
attention signal is observational, not permission to steer, resume, replace, or relaunch
the coordinator. Only the configured reviewer deadline or an explicit supervisor request
may interrupt the exact-run wait.

After each investigation and before implementation, read finalized `FORGE:CLAIM`
markers from the coordination issue. If active claims overlap, serialize before either
writer mutates shared paths: the lower issue number proceeds and the other remains
deferred until the predecessor reaches terminal success and refreshes its base.

Classify GitHub state as DONE, GATED, FAILED, or IN_PROGRESS. GATED is not FAILED.
Durable GitHub artifacts override a missing/malformed provider envelope. Dispatch
successors immediately after successful predecessors complete. Do not poll. After the
queue drains or reaches a documented paused state, execute mandatory cleanup and
publish the consolidated report.

## Reload and recovery contract

Before dispatch, create one coordination issue and record the batch ID, lease epoch,
deterministic child keys, predecessor set, and ready/deferred queues in machine-readable
`FORGE:` markers in its body or comments. This issue is the durable batch state; do not
create or require a GitHub state branch. On reload, read the coordination issue and
reconcile retained child receipts by key. Resume only unlaunched ready nodes exactly
once within the concurrency cap. Unknown or duplicate keys, stale leases, missing
predecessors, or ambiguous completion produce a paused report and launch nothing. Close
the coordination issue after terminal cleanup.

## Moving staging target

The dispatch-time target SHA is immutable launch attribution, not a promise that the
integration ref cannot advance. When a verified sibling merge advances `staging` while
a lane is building, validating, reviewing, or awaiting merge, keep the lane and route it
through a controlled refresh. Read the new target SHA from the authoritative ref, prove
that the movement is a verified sibling merge and an allowed descendant of the prior
base, then publish `FORGE:BASE_REFRESH` with the immutable launch SHA, old/new base
SHAs, target ref, sibling merge SHA, and refresh attempt before any lane mutation.

The coordinator must preserve the owned branch and PR, use a guarded non-destructive
synchronization with the expected remote lease, and gate conflicts, ambiguous movement,
non-fast-forward movement, or lease mismatch. The child reruns every affected
verification and acceptance check, freezes a new exact base/head/merge-base tuple, and
runs a fresh complete qualitative review. Older verification, approvals, and reviewer
receipts cannot authorize the refreshed head. Do not reset or overwrite another lane,
weaken protected-branch rules, or classify a mechanical refresh failure as
`needs-human`; emit automated `GATED` evidence instead. See
`specs/qualitative-review-protocol.md` for the shared identity and evidence contract.
