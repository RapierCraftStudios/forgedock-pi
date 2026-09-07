---
name: forgedock-work-on
description: Run or resume one issue inline through investigation, implementation, review, merge, closure, and cleanup.
---

# ForgeDock Work On

The visible session is the sole work-on agent and writer for one issue. GitHub issue/PR
state and the compact receipts in `../../specs/original/commands/work-on.md` are durable
engineering memory, not only resume position. Retrieve relevant history, validate its
applicability, and preserve material decisions for the next cold-start agent.

## Load

1. Parse the arguments.
2. Read `../../specs/pi-adapter.md` once for Pi mechanics.
3. Read `../../specs/original/commands/work-on.md` once for route and invariants.
4. Read `../../specs/github-memory.md`, `../../specs/knowledge-records.md` and
   `../../specs/verification.md` and `../../specs/mechanical-execution.md` once for bound policy,
   knowledge publication and selective checks;
   reuse them across phases.
5. Load only the current phase file under `../../specs/original/commands/work-on/`.

## Execute

Load the authoritative prepared lane policy, verify GitHub access and fetch issue/PR state.
Standalone work prepares policy from canonical forge.yaml before moving to its worktree. Retain values and refresh only after relevant writes,
review completion, target movement, resume, or a missing field.

Continue without stopping at intermediate success:
`resolve → investigate → [decompose | build → PR → review → [remediate → re-review] → merge → close → cleanup]`
Investigation derives closure, acceptance and scope from current code and relevant GitHub
history; issue criteria remain hypotheses. It compiles the existing `FORGE:CONTRACT` into one
concise builder-ready brief covering live path/callers, invariants, historical constraints,
implementation route, acceptance and explicit limits; supporting records cannot hide
requirements. Publish the named pre-build graph before editing.
For bug fixes, record trigger/expected/observed
baseline and fail-before/pass-after evidence; use inspection-only proof only with an explicit
safety/impossibility justification. Execute investigation, planning, implementation,
verification, PR preparation, remediation, merge, close, and cleanup inline.
Do not launch delegates, phase agents, builders, quality-gate agents, another work-on agent,
or a review coordinator before review or outside review/re-review.

At review or re-review only, launch the complete risk-selected panel as fresh ordinary
`delegate` agents with full normal tools through one concurrent workflow. Every task carries
the contract, relevant history, test scope and bounded diff/context; roles must confirm
reachable evidence. Classify material discoveries as `PATCH_DEFECT` when the contract
already required the behavior, or `CONTRACT_GAP` when current code/history reveals a missing
or contradictory requirement. Join every role, retain valid same-head roles, and retry only
missing/invalid roles. Remediate only in-contract patch defects; contract gaps return to
investigation and never become quality-based GATED results. Never reset the counter.

Base movement alone does not invalidate valid review. Preserve a clean mergeable reviewed
head; reconcile only for conflict or required-up-to-date policy, and rerun review only when
the effective patch or risk changed.

Publish the named pre-build records and linked build/review/terminal evidence on GitHub;
in-memory planning is not a substitute. Preserve changed decisions through superseding
records. Do not create Gists, indexes, ledgers, dossiers, ADRs, cost priors, telemetry,
heartbeats, checkpoints, or duplicate progress comments.

Prefer repair and continuation. Keep investigation active until its closure route is understood; use GATED only for an exact external prerequisite/recovery condition and `needs-human` only for
external authority. A missing/contradictory requirement returns to investigation with a
superseding contract, never a quality wake condition. After merge, close and clean up once.
