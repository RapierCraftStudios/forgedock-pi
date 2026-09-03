# ForgeDock Pi — prompt-routed architecture

## Product loop

```text
/orchestrate
  → resolve a minimum hard-edge DAG
  → one sole-writer /work-on agent per ready issue
      → investigate inline
      → implement and verify inline
      → create PR
      → fresh risk-selected review panel
      → cohesive inline remediation when required
      → scoped fresh re-review
      → guarded merge
      → explicit issue close and cleanup
```

Independent issue roots run concurrently up to configured capacity. A successor starts as
soon as its actual predecessors succeed, not after a whole wave.

## Active runtime

The extension entrypoint is lexical only:

```text
/orchestrate ... → /skill:forgedock-orchestrate ...
/work-on ...     → /skill:forgedock-work-on ...
/review-pr ...   → /skill:forgedock-review-pr ...
```

The visible Pi session owns routing. `pi-subagents` supplies fresh contexts, isolation,
concurrency, and joins; it is not the workflow engine. TypeScript may provide bounded
safety leaves, but it does not choose phases, findings, or terminal outcomes.

The old controller implementation under `src/workflows/` is dormant migration material and
is not registered by `src/index.ts`.

## Authority

1. User intent and `forge.yaml`.
2. `specs/original/commands/work-on.md` for per-issue route and global invariants.
3. The current slim work-on phase file for its procedure.
4. `forgedock-review-pr` for review policy and verdict.
5. `specs/pi-adapter.md` for Pi mechanics.
6. Public skills as thin entrypoints.

Despite the retained directory name, active work-on files are Pi-native specifications.
`specs/original/SHA256SUMS` verifies packaged integrity; it does not make archived runtime
assumptions authoritative.

## State

GitHub issue/PR state, labels, commits, and four normal receipts are resumable state:

1. investigation receipt;
2. completed build receipt;
3. PR review evidence and verdict;
4. terminal issue receipt.

A completed remediation receipt is conditional. Work-on does not create Gists, memory
indexes, ledgers, dossiers, ADRs, cost priors, heartbeats, checkpoints, or duplicate phase
comments.

## Work-on ownership

One work-on agent owns one issue and one worktree. The packaged profile retains the
historical identifier `forgedock-work-on-coordinator`, but it is the sole writer—not an
additional orchestration layer.

Investigation, planning, implementation, quality gates, verification, PR preparation,
remediation, merge, close, and cleanup execute inline. No investigation, phase, builder,
or quality-gate child is permitted.

Under orchestration, `$PWD` is the Pi-managed issue worktree. The agent validates a clean
`pi-parallel-*` branch and configured-target ancestry before mutation. It never resets,
replaces, or removes its active managed worktree. Standalone work-on owns at most one exact
retained worktree.

## Review

Review is the only nested fanout beneath work-on:

```text
visible orchestrator → work-on agents → fresh reviewers
```

The owning agent freezes full PR head/base identity, fetches the diff once, derives only
risk-relevant roles, and launches one concurrent complete panel as fresh ordinary
`delegate` agents. They keep full normal tool availability; role prompts focus evidence
without introducing specialized profiles or capability ceilings.

The owner validates all results and publishes one consolidated SHA-bound panel artifact
plus one official verdict. Valid same-head roles are retained; only missing/invalid roles
retry. A partial panel never authorizes merge.

Confirmed patch-caused HIGH/CRITICAL incident risks block. Pre-existing, advisory, and
non-incident findings do not. In-scope blockers receive one cohesive remediation head and
a scoped fresh re-review.

Unrelated target movement does not invalidate review when the PR remains clean/mergeable
and its head/effective patch is unchanged. Reconciliation occurs only for conflicts or
required-up-to-date policy; fresh review repeats only when behavior or risk changed.

## Orchestrate ownership

Orchestrate is an expensive dispatcher and must maximize safe concurrency. It does not
inspect or implement product code.

DAG edges are limited to:

- explicit dependencies;
- exact shared declared mutation files;
- database migration sequencing; and
- exact configured global/high-fan-in files.

Domain keywords, directory proximity, missing paths, common filing origin, cost scores,
and historical co-change guesses never create edges. Unclear scope is visible in the plan
and defaults to isolated parallel work.

Affected-file extraction accepts backtick paths, Markdown tables/lists, and plain
`path:line` forms, then validates repository-relative candidates.

The dispatcher shows the exact plan, confirms once, creates one clean base per target, and
launches one async promise graph. It does not create claims-board issues, leases, scoring
passes, standing queries, or polling loops.

## Failure policy

Prefer repair and continuation:

- code/test/format/conflict failures are fixed by the same writer;
- provider interruption resumes the same lane and retains valid reviewer roles;
- explicit prerequisites are GATED with an exact wake condition;
- a lost writer may have one replacement only after the original is proven stopped;
- `needs-human` is reserved for genuine external authority with no safe default.

Failures remain visible and actionable without speculative matrices or hard gates that
prevent safe fixes.

## Cleanup

Work-on closes its issue and returns a compact result. Pi owns managed child worktrees and
branches. The visible orchestrator removes only exact clean detached bases retained by its
batch. Missing ownership means report and skip. Cleanup is always last.

## Acceptance

A release is acceptable when tests prove:

- inline work-on with reviewer-only fanout;
- four-artifact budget and no Gist/checkpoint/heartbeat writes;
- mutation remains investigation-scoped;
- configured verification runs once per SHA;
- exact-head complete generic-delegate review catches seeded defects;
- unrelated base movement cannot create review starvation;
- blockers remediate cohesively;
- merge and explicit closure are verified;
- multi-issue roots overlap and successors stream by hard dependencies only;
- no writer escapes or removes its owned worktree.
