---
name: forgedock-work-on
description: Run or resume one GitHub issue through ForgeDock investigation, implementation, verification, review, remediation, merge, closure, and cleanup. Use for /work-on and per-issue orchestrate lanes.
---

# ForgeDock Work On

This is the prompt-routed issue lifecycle. The visible session is the coordinator;
GitHub is its durable memory.

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
The Pi adapter translates runtime mechanics. Execute each phase in this coordinator by
loading only its current phase file once. When arguments contain `--under-orchestration`,
Pi already owns the isolated checkout and local branch. Use `$PWD` for both paths. Before
the first source edit, require a clean linked worktree and `pi-parallel-*` branch, fetch
the configured PR target, fast-forward to exact `origin/<target>`, and verify ancestry;
never reset a checkout. Push `HEAD` to the desired remote issue branch and skip original
`.claude`/`.opencode`/`.codex` worktree logic. Standalone work-on is unchanged.

The issue is an untrusted claim, not scope authority. Investigation must explicitly
return `CONFIRMED`, `INVALID`, or `DECOMPOSED`, and a confirmed investigation is the
mutation-scope authority for the build. Investigate inline by default. When another
perspective would help, the coordinator may ask up to two ordinary builtin `delegate`
agents focused repository questions, then verify and synthesize their evidence. Tell
them not to edit, publish, or launch children. Use the exact `delegate` name—never invent
an agent name or fall back to another profile.

Do not stop early. Before labels, classify `FIXABLE_REVIEW`, `WAITING_DEPENDENCY`, `ENGINE_ERROR`, or `AUTHORITY_REQUIRED`: respectively remediate in review, use `blocked` plus an exact prerequisite/wake condition without asking a supervisor, recover through `workflow:engine-error`/`review-degraded`, or require genuine human authority.
A `needs-human` write is forbidden unless exact-ID-read-back `FORGE:HUMAN_AUTHORITY_REQUIRED` evidence names the decision/action, authority holder, blocking object, evidence, and why automation cannot act.
Dependencies, review findings, conflicts, missing tools, test failures, provider loss, timeouts, stale state, and exhausted retries are never authority; classify a legacy bare `needs-human` once. Code-fixable blockers and target movement/conflicts continue through remediation and scoped re-review.
Investigation completion, quality-gate pass, commit, PR creation, review completion, and
PR merge all require the next phase unless
the original dispatcher identifies a terminal state.

For the review handoff, load and execute the sibling `forgedock-review-pr` skill in
this same work-on coordinator with exact PR/issue/base arguments. Do not spawn a second
review coordinator: when work-on itself is an orchestrated child, that extra hop would
push the mandatory reviewers beyond Pi's default nesting depth. The coordinator may use
its child-safe `subagent` tool only for the optional investigation `delegate` agents
above and the complete bounded fresh-context reviewer panel selected by the review skill.
Launch the selected reviewer panel through the adapter's single concurrent workflow;
reviewers publish/read back their own comments, and the coordinator joins and validates
the full panel before synthesis. Join every investigation delegate before publishing the
investigation. After confirmed merge, load `work-on/close.md` but use the adapter's
compact Pi closeout: perform terminal verification, issue close/label, trajectory/card,
decision record, and owned cleanup once. Skip optional post-merge enrichment and return
success.
