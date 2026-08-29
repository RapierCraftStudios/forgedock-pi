---
name: forgedock-orchestrate
description: Resolve and orchestrate a confirmed set of GitHub issues by dispatching one complete ForgeDock work-on skill per issue with safe dependency ordering and bounded concurrency.
---

# ForgeDock Orchestrate

The visible session is a dispatcher, never a builder.

## Required loading

1. Parse the arguments appended to this skill invocation.
2. Read `../../specs/original/commands/orchestrate/config.md` for filtering defaults.
3. Use this skill as the compact execution checklist. Consult the original orchestrate
   specification only when a current decision is ambiguous; do not preload the root
   specification, phase files, or generic subagent reference corpus before dispatch.

## Execution contract

Before resolution or GitHub access, call `forgedock_preflight` and retain its shared
configuration/capability result. Use `forgedock_github` for all repository GitHub reads
and writes; missing tools or failed capabilities stop before dispatch.

Resolve and filter the requested issue set, show the concrete plan, and obtain the
original mandatory confirmation before launching any child unless `--auto` or
`--confirm` was explicitly supplied.

Build the minimum safe dependency graph from explicit dependencies, declared file
overlap, database/migration serialization, and configured global files. Detect cycles
and gate them visibly. Do not inspect or implement product code and never adjudicate
issue validity or duplicates.

For every ready issue, launch exactly one fresh `forgedock-work-on-coordinator` agent
with the `forgedock-work-on` skill and `<issue> --under-orchestration`. Use bounded
concurrency and isolated issue worktrees. Each child owns the complete issue lifecycle;
orchestrate must not invent a second implementation/review path.

The managed child worktree is the child's only repository root. In every child task,
state that its current working directory is authoritative and that any parent checkout
path is identity-only. Do not instruct a child to use the visible session's absolute
repository path, and do not pass that path as `repositoryRoot`; the child must use
relative paths and default ForgeDock runtime-tool roots from its assigned cwd. Treat an
anchor checkout that becomes dirty as a safety-critical batch stop.

The packaged coordinator is an explicit, depth-bounded fanout child: it may launch only
the fresh read-only reviewers required by its review phase. Do not use the builtin
`worker` for a complete work-on lane, and do not give the coordinator a blanket "never
run subagents" instruction; forbid nested issue/work-on orchestration while preserving
its mandatory reviewer fanout.

Classify GitHub state as DONE, GATED, FAILED, or IN_PROGRESS. GATED is not FAILED.
Dispatch successors immediately after successful predecessors complete. Do not poll.
After the queue drains or reaches a documented paused state, execute mandatory cleanup
and publish the consolidated report.

## Reload and recovery contract

Before dispatch, create one coordination issue and record the batch ID, lease epoch,
deterministic child keys, predecessor set, and ready/deferred queues in machine-readable
`FORGE:` markers in its body or comments. This issue is the durable batch state; do not
create or require a GitHub state branch. On reload, read the coordination issue and
reconcile retained child receipts by key. Resume only unlaunched ready nodes exactly
once within the concurrency cap. Unknown or duplicate keys, stale leases, missing
predecessors, or ambiguous completion produce a paused report and launch nothing. Close
the coordination issue after terminal cleanup.
