---
description: Run one GitHub issue through investigation, implementation, review, merge, closure, and cleanup
argument-hint: "[issue number | URL | next | PR --remediate --issue N]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ForgeDock Work On

One work-on agent owns one issue and one worktree from resolution to a terminal result.
GitHub issue/PR state and the small receipt set below are durable state. The agent reasons
and executes every phase inline; only fresh review and re-review panels may be children.

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

## Durable artifact budget

Normal successful work creates only:

1. one `FORGE:INVESTIGATOR` issue receipt;
2. one completed `FORGE:BUILDER` issue receipt;
3. the PR's reviewer evidence and official review verdict;
4. one `FORGE:TRAJECTORY` terminal issue receipt.

A decomposed issue creates child issues and one decomposition receipt. A remediated PR may
add one completed remediation receipt per new reviewed head. Do not create Gists, memory
indexes, ledgers, dossiers, ADRs, cost priors, heartbeats, progress comments, checkpoints,
review-start comments, context comments, architecture comments, or partial builder
comments.

## One-time preflight

In one bounded shell block:

1. Parse `forge.yaml` once and retain repository, target branches, worktree paths,
   verification commands, reviewer model, concurrency, and remediation round cap
   (`review.remediation_max_rounds`, default `3` when absent).
2. Verify `gh auth status --active`, repository access, and `gh auth setup-git`.
3. Resolve the issue selector to exactly one issue.
4. Fetch issue state, labels, body, relevant ForgeDock receipts, linked PRs, and parent
   relation once.
5. Resolve the PR target and fetch its exact remote SHA. Under orchestration, require the
   exact target passed by the parent. Standalone milestone issues use the configured
   `branches.feature_pattern` branch when it exists; ordinary no-milestone issues use
   `branches.staging`. A protected/default deployment target is selected only by the
   explicit staging/deployment route, never inferred for ordinary work-on.
6. Retain the repository root and packaged ForgeDock root; never search for either again.

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
after all GitHub writes and readbacks.

## Resume resolver

Derive exactly one next action from live state:

| State | Action |
| --- | --- |
| issue closed with merged/invalid/decomposed receipt | report terminal; no-op |
| merged PR but issue open | close |
| open PR with current blockers and remediation rounds available | remediate |
| open PR with blockers after remediation cap | reinvestigate once, then GATED if no safe path exists |
| issue has durable GATED prerequisite/recovery | verify its exact wake condition; resume only when satisfied |
| open PR awaiting current-head review | review |
| committed build with no PR | prepare PR |
| completed investigation requiring build | build |
| completed investigation requiring decomposition | decompose |
| no completed investigation | investigate |

A completed phase is never repeated. Old checkpoints and legacy comments may be read as
compatibility evidence but are never written and never outrank live issue/PR/git state.

## Lifecycle

### 1. Investigate

Load `work-on/investigate.md` once. Confirm or invalidate the claim, identify root cause,
trace relevant same-behavior paths, define the minimal mutation scope and non-goals, and
select trusted acceptance checks. Publish one investigation receipt.

Use two independent fields:

- `Verdict: CONFIRMED | INVALID`
- `Route: BUILD | DECOMPOSE | TERMINAL`

`INVALID` closes the issue with `workflow:invalid`. `DECOMPOSE` is not an investigation
verdict; it is the route selected after a confirmed investigation.

### 2. Decompose when required

Load `work-on/decompose.md` only for `Route: DECOMPOSE`. Create only independently
executable children, update a real parent tracker when present, mark the parent
`workflow:decomposed`, and stop. Otherwise skip this phase entirely.

### 3. Build and verify

Load `work-on/build.md` once. Treat the completed investigation receipt as mutation
scope and the implementation checklist; do not publish separate contract, context, or
architecture comments.

Inspect the relevant production path, implement one cohesive change, add focused
regression evidence, run applicable configured verification once per commit SHA, inspect
the final diff, commit, push, and publish one immutable completed build receipt. Fix
code, formatting, tests, or safe environment problems inline instead of creating a gate
loop. A newly discovered required mutation path must be added to the investigation
receipt before editing.

### 4. Prepare PR and review

Load `work-on/review.md` once. Reuse or create exactly one PR targeting the configured
branch. Freeze full head/base SHAs and invoke `forgedock-review-pr` in this same agent.
The review skill launches the complete fresh risk-selected panel. No partial panel may
produce a verdict or authorize merge.

### 5. Remediate when required

Load `work-on/remediate.md` only for confirmed patch-caused blocking findings. The same
work-on agent applies one cohesive fix covering all blockers on the current head, adds
focused regression evidence, reruns affected verification, pushes one new head, and
launches the scoped fresh re-review required by `forgedock-review-pr`.

Do not create recursive blocker issues. Independent pre-existing or advisory findings may
be grouped into explicitly valuable follow-up issues, but never delay the active PR.

### 6. Merge

Merge only when:

- the live head equals the accepted reviewed head, or retained evidence proves its
  effective patch is equivalent after required target reconciliation;
- the base equals the configured target;
- required checks and panel are complete;
- no blocking finding remains;
- ancestry and mergeability are current; and
- merge authorization permits the action.

Read back merged state and merge commit. Base movement alone does not invalidate valid review.
If the PR remains clean and mergeable with the reviewed head unchanged, merge without
rewriting the branch. Reconcile only when branch policy requires an up-to-date head or the
PR conflicts. After any rewrite, compare the effective patch before and after: reuse the
valid review when the patch is identical and target changes do not overlap its files;
rerun affected checks and fresh review only when behavior or risk actually changed. Never
create a competing writer or a review loop.

### 7. Close

Load `work-on/close.md` once. Verify the merge, explicitly close and label the issue,
update an actual parent tracker when present, publish one terminal receipt, and finish
cleanup according to ownership.

## Failure behavior

Prefer repair and continuation over terminal gates:

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

Return one compact result containing issue, PR, target, reviewed head, merge commit,
terminal state, changed files, verification summary, reviewer roles, remediation count,
residual risks, and cleanup ownership. End with exactly one machine-readable line:

`FORGE_WORK_ON_RESULT status=DONE|GATED|FAILED issue=<N> pr=<N|none>`

Only `status=DONE` satisfies a hard predecessor. Do not produce extended analytics or
memory artifacts unless the user explicitly requests a separate audit.
