---
name: forgedock-orchestrate
description: Resolve and orchestrate a confirmed set of GitHub issues by dispatching one complete ForgeDock work-on skill per issue with safe dependency ordering and bounded concurrency.
---

# ForgeDock Orchestrate

The visible session is a dispatcher, never a builder.

## Required loading

1. Parse the arguments appended to this skill invocation.
2. Read `../../specs/pi-adapter.md` completely.
3. Read `../../specs/original/commands/orchestrate/config.md` first.
4. Read `../../specs/original/commands/orchestrate.md` completely.
5. Load the phase files under `../../specs/original/commands/orchestrate/` only as each
   phase becomes current.

## Execution contract

Use direct Bash with `gh` and `git` commands for all orchestration operations; verify
`gh` authentication and repository access first. The original specification and its
phase files are authoritative for resolution, triage, dependency analysis, execution,
cleanup, and reporting.

Dispatch through the canonical recipe in `specs/pi-adapter.md` (§ Orchestrate dispatch
mechanics). For a supported compact plan — a literal issue list with unambiguous
eligibility, no cycles, and a standard fast-lane wave — the recipe is the primary
execution path: do not read the full `phase-4-execution.md` corpus or the pi-subagents
reference corpus; consult the original phase files only when a decision is genuinely
ambiguous (non-literal inputs such as `milestone`/`all`/`next <N>` queries, deep-plan
features, recovery beyond the recipe's documented shapes). Consolidate the mechanical
resolution, triage, and dependency steps (issue fetch, dependency markers, affected
files via the packaged helpers, lane classification, DAG, claims board, lease) into
single script blocks instead of one turn per query.

Resolve and filter the requested issue set, show the concrete plan, and obtain the
original mandatory confirmation before launching any child unless `--auto` or
`--confirm` was explicitly supplied.

Build the minimum safe dependency graph from explicit dependencies, declared file
overlap, database/migration serialization, and configured global files. Detect cycles
and gate them visibly. Do not inspect or implement product code and never adjudicate
issue validity or duplicates.

Launch one fresh `forgedock-work-on-coordinator` per issue with task text exactly
`<issue> --under-orchestration`. Use one async workflow promise graph: roots start
together, and each dependent starts as soon as its own predecessor promises succeed —
never after a whole sibling wave. Use bounded `orchestration.max_concurrent` and isolated
issue worktrees. Give every work-on child Pi's maximum supported runtime as a practical
no-deadline value; omission silently restores Pi's 30-minute default. Before workflow
launch, create one clean detached base per configured PR target and set each issue item's
`cwd` to that base before `worktree: true`; children verify/fast-forward before editing.
The packaged coordinator is an explicit, depth-bounded fanout child: it may launch only
the fresh read-only reviewers required by its review phase. Do not use the builtin
`worker` for a complete work-on lane, and do not give the coordinator a blanket "never
run subagents" instruction; forbid nested issue/work-on orchestration while preserving
its mandatory reviewer fanout. All dispatch — wave, successor, and recovery relaunch —
follows the canonical recipe in `specs/pi-adapter.md` (§ Orchestrate dispatch
mechanics): child task text is always exactly `<issue> --under-orchestration`, globals
appear only on workflowScript calls, and recovery relaunches verify GitHub state first
and reuse the identical first-dispatch shape. Never compose improvised prose task
texts for coordinators.
Classify GitHub state as DONE, GATED, FAILED, or IN_PROGRESS. GATED is not FAILED.
Mechanical child failure is resumable: replace stale labels with `workflow:engine-error`, record
the run/handoff, and resume only non-terminal work. Wrong ancestry is technical remediation,
never a human gate. Do not poll or abandon work. After drain,
clean only handoff-recorded batch identities. Do not invoke the Claude-only `/audit-agents`; use Pi child metadata or known
`_meta.json` artifact paths, never `~/.claude`. Return one compact terminal table with totals.
