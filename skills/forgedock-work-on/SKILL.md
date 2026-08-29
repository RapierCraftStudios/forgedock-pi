---
name: forgedock-work-on
description: Run or resume one GitHub issue through ForgeDock investigation, implementation, verification, review, remediation, merge, closure, and cleanup. Use for /work-on and per-issue orchestrate lanes.
---

# ForgeDock Work On

This is the prompt-routed issue lifecycle. The visible session is the coordinator;
GitHub is its durable memory.

## Required loading

1. Read `../../specs/pi-adapter.md` completely.
2. Read `../../specs/original/commands/work-on.md` completely in bounded chunks.
3. Parse the arguments appended to this skill invocation.
4. Load only the next required phase file under
   `../../specs/original/commands/work-on/`, then execute that phase.

## Execution contract

Reconstruct the current issue state from GitHub and continue the canonical route:

`resolve → investigate → [decompose | build → verify → PR → review → remediation/re-review when required → merge → close → trajectory/cleanup]`

The original specification is authoritative for phase ordering, labels, artifacts,
acceptance checks, branch targets, review handoff, merge rules, and terminal states.
Apply the Pi adapter only to translate Claude-specific tool/skill mechanics.

Do not stop at an intermediate success. Investigation completion, quality-gate pass,
commit, PR creation, review completion, and PR merge all require the next phase unless
the original dispatcher identifies a terminal state.

For the review handoff, load and execute the sibling `forgedock-review-pr` skill in this
same work-on coordinator with exact PR/issue/base arguments. Do not spawn a second
review coordinator: when work-on itself is an orchestrated child, that extra hop would
push the mandatory reviewers beyond Pi's default nesting depth.

The work-on coordinator may use its child-safe `subagent` tool only to launch the
complete bounded fresh-context reviewer panel selected by the review skill. Join every
selected reviewer before synthesis and continuation. After confirmed merge, load
`work-on/close.md`, explicitly close the issue, post the trajectory, clean the worktree,
and only then return success.
