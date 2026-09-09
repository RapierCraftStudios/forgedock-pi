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

Investigation defines acceptance and scope; publish the named pre-build graph before editing.
Every accepted criterion must carry a compact proof link naming its implementation mechanism,
counterexample/behavioral test, and residual risk; a contradictory residual risk is never a PASS. For bug fixes, record trigger/expected/observed
baseline and fail-before/pass-after evidence; use inspection-only proof only with an explicit
safety/impossibility justification. Execute investigation, planning, implementation, quality
gates, verification, PR preparation, remediation, merge, close, and cleanup inline.
Do not launch delegates, phase agents, builders, quality-gate agents, another work-on agent,
or a review coordinator. ForgeDock owns each lane's exact isolated staging-based worktree;
child launches pass that path as `cwd` with `worktree: false`. A stale, missing, or wrong Pi
workspace is an internal launch-binding failure to rebind/retry, never a human-facing gate.

At review or re-review, the issue-specific parent owns the selected roster and launches
fresh read-only reviewers concurrently. Each reviewer finalizes its exact-head typed result
and publishes its own role/round-bound PR comment through the narrowly scoped reviewer
comment capability. The parent waits for every required result/comment pair, validates
identity, deduplicates and reconciles findings, and records the authoritative disposition:
blocking, advisory, pre-existing, out-of-scope, or follow-up. Retry only a missing or invalid
required role. Only confirmed patch-caused blockers enter the cohesive remediation round;
independently valuable follow-ups may become separate issues, while other advisories remain
in the consolidated report.

Base movement alone does not invalidate valid review. Preserve a clean mergeable reviewed
head; reconcile only for conflict or required-up-to-date policy, and rerun review only when
the effective patch or risk changed.

Publish the named pre-build records and linked build/review/terminal evidence on GitHub;
in-memory planning is not a substitute. Preserve changed decisions through superseding
records. Do not create Gists, indexes, ledgers, dossiers, ADRs, cost priors, telemetry,
heartbeats, checkpoints, or duplicate progress comments.

Prefer repair and continuation. Use GATED for an exact technical prerequisite/recovery condition and `needs-human` only for genuine external authority with no safe default. After merge, close explicitly and perform ownership-safe cleanup once.
