---
name: forgedock-work-on
description: Run or resume one issue inline through investigation, implementation, review, merge, closure, and cleanup.
---

# ForgeDock Work On

The visible session is the sole work-on agent and writer for one issue. GitHub issue/PR
state and the compact receipts in `../../specs/original/commands/work-on.md` are durable
memory.

## Load

1. Parse the arguments.
2. Read `../../specs/pi-adapter.md` once for Pi mechanics.
3. Read `../../specs/original/commands/work-on.md` once for route and invariants.
4. Load only the current phase file under `../../specs/original/commands/work-on/`.

## Execute

Parse `forge.yaml`, verify active GitHub access, resolve repository/target/worktree/model,
and fetch initial issue/PR state once. Retain values and refresh only after relevant writes,
review completion, target movement, resume, or a missing field.

Continue without stopping at intermediate success:

`resolve → investigate → [decompose | build → PR → review → remediation/re-review → merge → close → cleanup]`

Investigation defines mutation authority. For bug fixes, record trigger/expected/observed
baseline and fail-before/pass-after evidence; use inspection-only proof only with an explicit
safety/impossibility justification. Execute investigation, planning, implementation, quality
gates, verification, PR preparation, remediation, merge, close, and cleanup inline.
Do not launch delegates, phase agents, builders, quality-gate agents, another work-on agent,
or a review coordinator.

At review or re-review only, launch the complete risk-selected panel as fresh ordinary
`delegate` agents with full normal tools through one concurrent workflow. Every task carries
acceptance invariants, test evidence/scope, and bounded diff/context; roles are unique and
must confirm reachable patch-caused blocker evidence. Join every role, retain valid same-head
roles, and retry only a missing or invalid role. Apply all in-scope blockers cohesively in
this same work-on agent, reinvestigating repeated same-cause gaps within the round cap.

Base movement alone does not invalidate valid review. Preserve a clean mergeable reviewed
head; reconcile only for conflict or required-up-to-date policy, and rerun review only when
the effective patch or risk changed.

Use the four normal durable artifacts only: investigation receipt, completed build receipt,
PR review/verdict, and terminal issue receipt. Never create Gists, indexes, ledgers,
dossiers, ADRs, cost priors, telemetry, heartbeats, checkpoints, or duplicate progress
comments.

Prefer repair and continuation. Use GATED for an exact technical prerequisite/recovery
condition and `needs-human` only for genuine external authority with no safe default. After
merge, close explicitly and perform ownership-safe cleanup once.
