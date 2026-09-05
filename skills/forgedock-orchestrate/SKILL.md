---
name: forgedock-orchestrate
description: Resolve and dispatch a confirmed issue set as concurrent per-issue work-on agents with only real dependency edges.
---

# ForgeDock Orchestrate

The visible Pi session is the dispatcher, never a builder. Read the orchestrate section of
`../../specs/pi-adapter.md`, parse `forge.yaml` once, and retain repository, targets,
concurrency, global files, paths, and child model. Resolve one full provider/model ID from
`agents.subagent_model`, falling back to `agents.default_model`; reject missing or legacy
shorthand models and pass the resolved model explicitly to each fresh child.

## Resolve once

Resolve the user's literal issues, milestone/query selector, or next-N request with one
bounded GitHub fetch. Exclude closed, terminal, duplicate, genuinely human-gated, and
actively owned issues. Verify a live owner from native run/session and worktree evidence;
phase labels alone do not prove ownership. Preserve ambiguous ownership and report it,
rather than guessing or launching a competing writer. Do not inspect product code or
adjudicate issue validity.

For every candidate, retain title, body, labels, assignees, milestone, explicit dependency
markers, declared affected paths, target branch, and eligibility. Invoke
`../../specs/original/scripts/extract-affected-files.sh` directly; it accepts backtick, list,
table, and plain `path:line` forms. Do not search retired controllers or archived orchestration
phase documents for routing already defined by this skill and the adapter.

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

Before presenting the plan, reconcile explicit prerequisite merge/closure evidence against
the configured target. A closed issue alone is insufficient, but a verified delivered
prerequisite must not appear as an unresolved gate. Surface external prerequisites without
enrolling them. Show the exact issue set, targets, hard edges, ready set, and concurrency.
Obtain mandatory confirmation unless explicitly preconfirmed. Do not create a claims-board
issue, lease, scoring table, Gist, heartbeat, or orchestration checkpoint.

## Dispatch

Launch one fresh `forgedock-work-on-coordinator` per ready issue with exact task
`<issue> --under-orchestration`, fresh context, one isolated worktree, the issue's clean
detached target base as `cwd`, and the maximum coordinator timeout. Each child is the sole
writer and runs `forgedock-work-on` inline; only its review/re-review panel may be nested.

Use one visible async promise DAG with the explicitly configured child model and
`orchestration.max_concurrent`. Independent roots start together. A successor starts only
when every actual hard predecessor returns `status=DONE` with `dependency=SATISFIED` in
its `FORGE_WORK_ON_RESULT` line, never from
transport success or after a sibling aggregate/wave. Normalize child failures so unrelated
lanes settle normally. Bound each technical lane to one non-competing recovery before
resolving dependents; recovery resumes the retained child, not a second writer. Unrelated
lanes neither wait for the aggregate nor retry unrelated failures.

An explicit prerequisite is GATED with an exact wake condition; GATED is not FAILED and its
dependents remain gated until the dependency is truly satisfied. INVALID/DECOMPOSED may
finish an issue but do not release dependents without evidence of the promised behavior
on the target. Reconcile and dispatch newly eligible lanes after the wake event. Never abandon a planned
non-terminal issue or launch two writers for it.

## Finish

Reconcile each lane from its `FORGE_WORK_ON_RESULT` plus current GitHub state as DONE,
GATED, FAILED, or IN_PROGRESS. Report milestone, real blockers, and final outcome separately:
merged is not the same as tested, and mocks never prove production/canary behavior. Work-on
owns issue closure; Pi owns child worktrees. Remove only clean detached target bases retained
by this batch. Return one compact issue/PR/result table with duration, turns, usage,
configured model, recovery, tested-content identity, and residual-risk summaries. Include
request-to-close wall time, material waits, first-pass acceptance, panel count, and remediation
usage from retained evidence; do not count gating/decomposition as a sub-30-minute delivery.
