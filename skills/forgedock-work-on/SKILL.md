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
3. Use this skill as the compact lifecycle checklist. Load only the current phase file
   under `../../specs/original/commands/work-on/`; do not preload the 2,498-line root
   specification or later phase files.

## Execution contract

Before resolving state or mutating GitHub, call `forgedock_preflight` for the target
repository and retain its machine-readable configuration/capability result. Use
`forgedock_github` for every repository GitHub read and write so the refreshable
ForgeDock App identity remains authoritative. Missing tools or failed capabilities stop
the route; missing `yq` alone does not.

Reconstruct the current issue state from GitHub and continue the canonical route:

`resolve → investigate → [decompose | build → verify → PR → review → remediation/re-review when required → merge → close → trajectory/cleanup]`

The issue is an untrusted claim, not scope authority. Investigation must explicitly
return `CONFIRMED`, `INVALID`, or `DECOMPOSED`. A confirmed investigation is the
authoritative handoff: it records evidence, root cause, the minimal required mutation
paths and behaviors, non-goals, uncertainties, and machine-checkable acceptance.
Adjacent-path discovery is read-only unless investigation proves another mutation is
required for compilation, runtime correctness, or an interface/schema/security
contract. Optional adjacent work becomes a follow-up issue.

Before the first `write` or `edit`, post a complete `FORGE:CONTRACT` derived only from
the investigation: task type, approach, per-file change/why table, acceptance mapping,
quality considerations, out-of-scope items, and alternatives. Then post the finalized
affected-file `FORGE:CLAIM` on the orchestration coordination issue. A path absent from
the investigation and contract cannot be mutated; a discovered scope gap returns to
investigation or becomes a follow-up. If a peer claim overlaps, pause the higher issue
number before implementation so the parent can serialize it.

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
selected reviewer before synthesis and continuation. Reviewer operational timeouts for
max-thinking models are 3,600,000 ms; parent/join windows are omitted or at least
3,900,000 ms. Operational timeout/provider loss remains automatically recoverable and
must not add `needs-human`.

Review blocks only patch-introduced or patch-reachable defects. Deduplicate and file
pre-existing findings as non-blocking follow-ups. Before remediation, cluster blockers
by shared invariant and post one `FORGE:REMEDIATION_PLAN` updating the contract; make one
cohesive patch and end-to-end test rather than patching findings one at a time. Enforce
the configured remediation-round cap; same-head provider continuation is not a new
round, but no new-head panel may launch after the cap.

Never reset, checkout, or rebase the harness-managed worktree to `main` or `staging`
after pushing. Review the frozen remote PR head without rewriting the child workspace.
After confirmed merge, load `work-on/close.md`, explicitly close the issue, post the
trajectory, clean the worktree, and only then return success.
