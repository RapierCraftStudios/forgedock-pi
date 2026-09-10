---
description: Run one GitHub issue through investigation, implementation, review, merge, closure, and cleanup
argument-hint: "[issue number | URL | next | PR --remediate --issue N]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# ForgeDock Work On
One work-on agent owns one issue and one worktree from resolution to a terminal result.
GitHub is canonical engineering memory as well as durable state. Follow `../../github-memory.md`
to retrieve, apply and preserve relevant decisions in the existing receipts. Execute every
phase inline; only fresh review and re-review panels may be children.
## Authority
Precedence is:

1. The user's current request and `forge.yaml`.
2. This file for route order, terminal states, and cross-phase invariants.
3. The current phase file for that phase's procedure.
4. `forgedock-review-pr` for reviewer selection, panel execution, findings, and verdict.
5. `specs/pi-adapter.md` for Pi tool, path, model, worktree, and concurrency mechanics.

A lower layer may not redefine topology, mutation authority, terminal state, worktree
ownership, review requirements, or merge authority.

## Topology

- The work-on agent is the sole writer for its issue.
- Investigation, decomposition decisions, planning, build, verification, PR preparation,
  remediation, merge, close, and cleanup execute in this agent.
- The `subagent` tool is forbidden before review and outside review/re-review.
- Reviewers are fresh, read-only, risk-selected, concurrent, and fully joined.
- Do not launch investigation helpers, phase agents, builders, quality-gate agents,
  another work-on agent, or a review coordinator.

## First-pass delivery target

For a bounded, ready issue, aim for verified merge and closure in under 30 minutes:
resolve/prerequisites 2m, investigation 5m, implementation/verification 12m, concurrent
review 7m, merge/close 3m. These are planning targets, never permission to weaken evidence,
skip checks, or merge with blockers. Remediation is an exceptional fallback, not a phase
needed to complete the initial implementation. One complete initial panel is the happy path.

Retain the execution-request start time and existing native run timestamps. Report total
wall time including queue, CI, external, and user waits; distinguish those waits from
active work. Do not silently reset the clock on resume or decomposition. GATED, INVALID,
and DECOMPOSED are not successful code deliveries, even when they terminate the issue.
Oversized or unready work must be identified before editing, not hidden by the time target.

## Durable knowledge contract

Follow `../../knowledge-records.md`; normal code delivery publishes linked named records:
1. one `FORGE:INVESTIGATOR` issue receipt;
2. `FORGE:CLASSIFICATION` — task/risk/cohesion decision;
3. `FORGE:CONTEXT` — validated historical understanding;
4. `FORGE:CONTRACT` — deterministic builder brief: observable outcome, exact behavior/files, non-goals and smallest proof;
5. `FORGE:ARCHITECT` — chosen approach, ordered plan and material alternatives;
6. one completed `FORGE:BUILDER` issue receipt;
7. the PR's reviewer evidence and official review verdict;
8. one `FORGE:TRAJECTORY` terminal issue receipt.

Classification/context/contract/plan precede repository edits. Material revisions append
superseding records; the old decision remains auditable. Decomposition/remediation keep
their conditional receipts. Do not create Gists, memory indexes, ledgers, dossiers, ADRs,
cost priors, heartbeats, checkpoints, duplicate progress reports or partial builder comments.

## One-time preflight

In one bounded shell block:

1. Load the authoritative lane policy via `../../mechanical-execution.md`; standalone work
   prepares it once from the canonical root. Bind repository, target, model and round cap
   (`review.remediation_max_rounds`, default `1` when absent; explicit configuration wins).
2. Verify `gh auth status --active`, repository access, and `gh auth setup-git`.
3. Use the bound issue identity; never infer it from a local child index or neighbouring config.
4. Fetch issue state, labels, body, relevant ForgeDock receipts, linked PRs, and parent
   relation once.
5. Resolve the PR target and fetch its exact remote SHA. Under orchestration, require the
   exact target passed by the parent. Standalone milestone issues use the configured
   `branches.feature_pattern` branch when it exists; ordinary no-milestone issues use
   `branches.staging`. A protected/default deployment target is selected only by the
   explicit staging/deployment route, never inferred for ordinary work-on.
6. Retain the repository root and packaged ForgeDock root; never search for either again.
7. Use `../../verification.md` for learned repository checks and selective execution. Under
   orchestration use the bound catalog/canonical config reference; never search or update sibling cwds.

Refresh retained state only after this agent writes GitHub state, receives reviewer
completion, observes target movement, resumes after interruption, or lacks a required
field. Do not refetch unchanged state between phases.

## Worktree ownership

Under `--under-orchestration`, `$PWD` is the Pi-managed issue worktree. Require:

- a linked worktree;
- a clean `pi-parallel-*` branch before mutation;
- exact configured-target ancestry after `git fetch` and fast-forward;
- no reset, replacement worktree, or access to another checkout.

Standalone work-on creates at most one isolated owned worktree. Retain its exact path.
Never remove the current working directory. An orchestrated child returns cleanup-ready;
Pi removes its managed worktree. Standalone cleanup removes only its retained owned path,
after all GitHub writes and readbacks. ForgeDock child launches use the exact prepared path as `cwd` with `worktree: false`; stale, missing, or wrong Pi workspaces are internal rebind/retry failures, never `GATED`/`needs-human`.

## Resume resolver

Derive exactly one next action from live state:

| State | Action |
| --- | --- |
| issue closed with merged/invalid/decomposed receipt | report terminal; no-op |
| merged PR but issue open | close |
| decomposition reassessment with an open PR | preserve the PR/work; require approved handoff/disposition before splitting, otherwise GATED |
| authorized remediation round unfinished | resume its cohesive fix/scoped re-review; do not charge another round |
| open PR with current blockers and remediation rounds available | remediate |
| blockers remain after last authorized re-review | read-only reassessment once, then GATED with unresolved evidence; no automatic extra round |
| issue has durable GATED prerequisite/recovery | verify its exact wake condition; resume only when satisfied |
| open PR has a parent-dispositioned contract-invalidating blocker | enter or resume the one bounded `CONTRACT_GAP` → `REPLAN_REQUIRED` transition; preserve the reviewed work and original usage |
| issue has completed `REPLAN_REQUIRED` transition but no superseding contract | remain GATED until the exact re-plan identity and authority are present |
| open PR awaiting current-head review | review |
| committed build with no PR | prepare PR |
| completed investigation requiring build | build |
| completed investigation requiring decomposition | decompose |
| no completed investigation | investigate |

Completed phases are never repeated; legacy evidence never outranks live state. Recover
usage from reviewed-head transitions and receipts. A round includes one cohesive fix plus its complete scoped re-review; Complete or resume it at the limit without double-charging. Never reset
usage on resume, reinvestigation, a new head, or names such as `final`, `last`, or `closure`;
post-review code fixes consume a round; bounded missing-role retries never charge twice. Only explicit new authority can extend an exhausted
budget.

### Contract-gap transition

`CONTRACT_GAP` is a parent-dispositioned blocker when review proves the admitted
investigation, architecture, Builder Contract, or proof map omitted a reachable behavior.
Implementation defects and verification gaps remain ordinary bounded remediation; stale,
advisory, pre-existing, out-of-scope, and unrelated findings never open this route.

Record exact PR head/base, worktree/branch, reviewer evidence, finding, contract digest, and
original usage. Preserve the partial work and writer. Admit at most one lane-scoped
`REPLAN_REQUIRED` token for a superseding investigation/architecture/contract; resume, new
head, renamed receipt, or target movement cannot mint another token or raise the cap.
Before editing, retain every bound criterion ID, explain the omitted row, and publish a new
contract digest. That digest invalidates old approval and requires a fresh exact-head panel.
If the token, identity, or allowance is unavailable, publish `FORGE:GATED` with the exact
wake condition without closing the issue or blocking unrelated lanes. A contract gap cannot
silently become `needs-human`, a follow-up, or a second remediation round.

## Lifecycle

### 1. Investigate

Load `work-on/investigate.md` once. Confirm or invalidate the claim, identify root cause,
trace relevant same-behavior paths, define the minimal mutation scope and non-goals, and
select trusted acceptance checks and proactively validate relevant prior knowledge. The
receipt records the complete acceptance contract, prerequisite availability and historical
constraints; do not leave those for reviewers to discover.

Use two independent fields:

- `Verdict: CONFIRMED | INVALID`
- `Route: BUILD | DECOMPOSE | TERMINAL`

`INVALID` closes the issue with `workflow:invalid`. `DECOMPOSE` is not an investigation
verdict; it is the route selected after a confirmed investigation.

### 2. Decompose when required

Load `work-on/decompose.md` for `Route: DECOMPOSE`, including a justified later reassessment.
An existing PR requires its preserved-work/approved-disposition guard first. Create only
independently executable children, retain all parent criteria, update a real tracker when
present, mark `workflow:decomposed`, and stop; a split is not code delivery.

### 3. Build and verify

Load `work-on/build.md` once. Treat the completed investigation's `FORGE:CONTRACT`
Builder Brief as the implementation source of truth and publish the named pre-build records
under `../../knowledge-records.md` before repository edits. Establish feasible executable regressions before production changes and
reconcile every acceptance criterion and decision revision to evidence before review.

Inspect the relevant production path, implement one cohesive change, add focused
regression evidence, run applicable configured verification once per commit SHA, inspect
the final diff, commit, push, and publish one immutable completed build receipt. Fix
code, formatting, tests, or safe environment problems inline instead of creating a gate
loop. A newly discovered required mutation path must be added to the investigation
receipt before editing.

The Builder Contract is the four-part implementation brief described in `work-on/build.md`;
supporting investigation/context/architecture records retain producer/consumer, state,
failure/retry/recovery and lifecycle detail. Each criterion still carries mechanism +
counterexample/behavioral test + residual risk; contradictory residual risk is
`CONTRADICTED`, never `PASS`. The accepted Builder Contract is immutable for the run;
later reviewer/remediation inputs are labeled context and cannot rewrite it.

### 4. Prepare PR and review

Load `work-on/review.md` once. Reuse or create exactly one PR targeting the configured
branch. Freeze full head/base SHAs and invoke `forgedock-review-pr` in this same agent.
The review skill launches the complete fresh risk-selected panel. No partial panel may
produce a verdict or authorize merge.

### 5. Remediate when required

Load `work-on/remediate.md` only for parent-dispositioned confirmed patch-caused blockers.
Classify each blocker before editing: implementation defect, verification gap, or contract
 gap. The first two use ordinary bounded remediation; the last follows the durable
`CONTRACT_GAP` → `REPLAN_REQUIRED` transition and cannot be patched before supersession.
Apply one cohesive fix with focused evidence and a fresh exact-head re-review; no recursive
blocker issues. Independent advisories/pre-existing findings never delay the active PR.

### 6. Merge

Merge only when:

- the live head equals the accepted reviewed head, or retained evidence proves its
  effective patch is equivalent after required target reconciliation;
- the base equals the configured target;
- required checks and panel are complete;
- no blocking finding remains;
- ancestry and mergeability are current; and
- merge authorization permits the action.

Read back merged state and merge commit. Base movement alone does not invalidate valid review;
merge unchanged clean reviewed heads without rewriting. Reconcile only for required ancestry
or conflict, compare effective patches, and rerun checks/review only when behavior or risk
changed. Never create a competing writer or review loop.

### 7. Close

Load `work-on/close.md` once. Verify the merge, explicitly close and label the issue,
update an actual parent tracker when present, publish one terminal receipt, and finish
cleanup according to ownership.
## Failure behavior

Prefer repair and continuation over terminal gates within the remaining remediation budget:

- Code, test, format, lint, type, and safe merge conflicts: fix inline and continue.
- Provider or transport interruption: resume the same lane and reuse valid exact-head
  reviewer roles.
- Explicit unresolved prerequisite: `GATED` with the exact wake condition; resume when it
  lands.
- Mechanical unrecoverable environment or authority mismatch: durable `GATED` evidence
  with the smallest actionable next step.
- `needs-human`: only a genuine product, policy, legal, destructive, credential, or
  external-action decision with no safe automated default.

Never infer human authority from uncertainty, tooling failure, target movement, or a
review blocker that is safely fixable inside scope.

## Terminal output
Return one compact result with issue/PR/target, reviewed and merge heads, state, files,
checks, reviewers, remediation count, risks, cleanup owner, first-pass review panels and remediation evidence,
round limit, elapsed waits, and relevant history. Keep the configured model visible.
End exactly with:

`FORGE_WORK_ON_RESULT status=DONE|GATED|FAILED issue=<N> pr=<N|none> dependency=SATISFIED|UNSATISFIED`

Use SATISFIED only for DONE with merged or verified target evidence; invalidation,
decomposition, GATED, or FAILED use UNSATISFIED. Explain wake/replacement conditions and
avoid analytics or memory artifacts.
