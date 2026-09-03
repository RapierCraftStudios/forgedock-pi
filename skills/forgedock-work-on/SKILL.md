---
name: forgedock-work-on
description: Run or resume one GitHub issue through ForgeDock investigation, implementation, verification, review, remediation, merge, closure, and cleanup. Use for /work-on and per-issue orchestrate lanes.
---

# ForgeDock Work On

This is the prompt-routed issue lifecycle. The visible session is the sole work-on agent
and writer for its issue; GitHub is its durable memory.

## Required loading

1. Parse the arguments appended to this skill invocation.
2. Read `../../specs/pi-adapter.md` for Pi runtime rules.
3. Use this skill as the compact lifecycle checklist. Read
   `../../specs/original/commands/work-on.md` in bounded chunks to resolve the current
   phase, then load only the required phase file under
   `../../specs/original/commands/work-on/`; do not preload later phase files.

## Execution contract

Before resolving state, use one Bash block to parse `forge.yaml`, retain the resolved
repository/branches/paths/child model, verify the active `gh` identity and repository
access, and run `gh auth setup-git`. Reuse those values throughout; do not rerun equivalent
`yq` snippets or refetch unchanged issue/history state. Missing required configuration,
authentication, or repository access stops the route.

Reconstruct the current issue state from GitHub and continue the canonical route:

`resolve → investigate → [decompose | build → verify → PR → review → remediation/re-review when required → merge → close → trajectory/cleanup]`

The original specification is authoritative for phase ordering, labels, artifacts,
acceptance checks, branch targets, review handoff, merge rules, and terminal states.
The Pi adapter translates runtime mechanics. Execute each phase in this work-on agent by
loading only its current phase file once. When arguments contain `--under-orchestration`,
Pi already owns the isolated checkout and local branch. Use `$PWD` for both paths. Before
the first source edit, require a clean linked worktree and `pi-parallel-*` branch, fetch
the configured PR target, fast-forward to exact `origin/<target>`, and verify ancestry;
never reset a checkout. Push `HEAD` to the desired remote issue branch and skip original
`.claude`/`.opencode`/`.codex` worktree logic. Standalone work-on is unchanged.

The issue is an untrusted claim, not scope authority. Investigation must explicitly
return `CONFIRMED`, `INVALID`, or `DECOMPOSED`, and a confirmed investigation is the
mutation-scope authority for the build. Execute investigation, contract, planning,
implementation, quality gates, verification, and PR preparation inline in this same
work-on agent. Do not launch delegates, phase agents, quality-gate agents, builders, or
other helper children before review.

Do not stop at an intermediate success. Code-fixable review blockers and target-branch
movement/conflicts continue in this work-on agent through cohesive remediation and scoped
re-review. An explicit unmerged prerequisite is automated waiting: add `blocked`, remove
`needs-human` and stale active labels, post `FORGE:GATED` with the exact prerequisite and
merge/event resume condition, return GATED, and resume after it lands. Never enter
remediation or ask a supervisor whether to wait; reserve `needs-human` for genuine
authority. Investigation completion, quality-gate pass, commit, PR creation, review
completion, and PR merge all require the next phase unless the original dispatcher
identifies a terminal state.

For the review handoff, load and execute the sibling `forgedock-review-pr` skill in this
same work-on agent with exact PR/issue/base arguments. Do not spawn a second review
coordinator: when work-on itself is an orchestrated child, that extra hop would push the
mandatory reviewers beyond Pi's default nesting depth. The work-on agent may use its
child-safe `subagent` tool only for the complete bounded fresh-context reviewer panel
selected by the review skill. Launch that panel through the adapter's single concurrent
workflow, then join and validate the full panel before synthesis. Apply cohesive
code-fixable remediation in this same work-on agent, then launch only the scoped fresh
re-review required by the review skill. After confirmed merge, load `work-on/close.md`
and use the compact Pi closeout: verify terminal state, close/label the issue, post the
trajectory and decision record, clean owned state once, skip optional enrichment, and return.
