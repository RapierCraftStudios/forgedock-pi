---
name: forgedock-orchestrate
description: Resolve and dispatch a confirmed issue set as concurrent per-issue work-on agents with only real dependency edges.
---

# ForgeDock Orchestrate

The visible Pi session is the dispatcher, never a builder. Read the orchestrate section of
`../../specs/pi-adapter.md`, parse `forge.yaml` once, and retain repository, targets,
concurrency, global files, paths, and child model.

## Resolve once

Resolve the user's literal issues, milestone/query selector, or next-N request with one
bounded GitHub fetch. Exclude closed, terminal, duplicate, genuinely human-gated, and
actively owned issues. Do not inspect product code or adjudicate issue validity.

For every candidate, retain title, body, labels, assignees, milestone, explicit dependency
markers, declared affected paths, target branch, and eligibility. Use the packaged affected-
file extractor, which accepts backtick, list, table, and plain `path:line` forms and validates
paths against the repository.

## Build the minimum safe DAG

Add edges only for:

1. explicit `Depends on`, `Blocked by`, or required parent/child ordering;
2. exact shared declared mutation files;
3. database migration sequencing; or
4. exact configured global/high-fan-in files.

Domain tags influence priority and reviewer selection, never dependency edges. Do not add
edges from broad directory proximity, missing paths, shared keywords, common filing origin,
cost scores, historical co-change guesses, or general uncertainty. When scope is unclear,
show the uncertainty in the plan and prefer isolated parallel work; let the work-on agent's
investigation establish mutation scope. Detect and report real cycles.

Show the exact issue set, targets, hard edges with reasons, initial ready set, and concurrency.
Obtain mandatory confirmation unless explicitly preconfirmed. Do not create a claims-board
issue, lease, scoring table, Gist, heartbeat, or orchestration checkpoint.

## Dispatch

Launch one fresh `forgedock-work-on-coordinator` per ready issue with exact task
`<issue> --under-orchestration`, fresh context, one isolated worktree, the issue's clean
detached target base as `cwd`, and the maximum coordinator timeout. Each child is the sole
writer and runs `forgedock-work-on` inline; only its review/re-review panel may be nested.

Use one async promise graph with `orchestration.max_concurrent`. Independent roots start
together. A successor starts only when every actual hard predecessor returns
`FORGE_WORK_ON_RESULT status=DONE`, never from transport success or after a sibling wave.
Normalize child failures so unrelated lanes settle normally.

A technical lane failure preserves its handoff and receives one non-competing recovery.
An explicit prerequisite is GATED with a wake condition; GATED is not FAILED. Never abandon
a planned non-terminal issue or launch two writers for it.

## Finish

Reconcile each lane from its `FORGE_WORK_ON_RESULT` plus current GitHub state as DONE,
GATED, FAILED, or IN_PROGRESS. Work-on owns issue closure; Pi owns child worktrees. Remove only
clean detached target bases retained by this batch. Return one compact issue/PR/result table
with available duration, turns, usage, recovery, and residual-risk summaries.
