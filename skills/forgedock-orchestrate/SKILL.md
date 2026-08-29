---
name: forgedock-orchestrate
description: Resolve and orchestrate a confirmed set of GitHub issues by dispatching one complete ForgeDock work-on skill per issue with safe dependency ordering and bounded concurrency.
---

# ForgeDock Orchestrate

The visible session is a dispatcher, never a builder.

## Required loading

1. Read `../../specs/pi-adapter.md` completely.
2. Read `../../specs/original/commands/orchestrate/config.md` first.
3. Read `../../specs/original/commands/orchestrate.md` completely.
4. Parse the arguments appended to this skill invocation.
5. Load the phase files under `../../specs/original/commands/orchestrate/` only as each
   phase becomes current.

## Execution contract

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

Persist the batch ID, lease epoch, deterministic child key, predecessor set, and
ready/deferred queues in the GitHub state branch. On reload, reconcile retained child
receipts by child key and classify every lane exactly as `DONE`, `GATED`, `FAILED`, or
`IN_PROGRESS`. Resume only unlaunched ready nodes, exactly once, within the concurrency
cap; never treat a provider receipt as workflow authority. Unknown or duplicate child
keys, stale leases, missing predecessors, or ambiguous completion produce a paused,
actionable report and launch nothing. Complete saved evidence is reused; partial
panels and unsupported Pi continuation are fail-closed.
