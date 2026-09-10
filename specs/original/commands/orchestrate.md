---
description: Dispatch a confirmed issue set through isolated prompt-routed work-on lanes
argument-hint: "[issue set or selector] [--auto|--confirm]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ForgeDock Orchestrate

The packaged `forgedock-orchestrate` skill is the active dispatcher contract. This compatibility
spec records the same boundaries for direct specification resolution; it does not define a second
workflow engine.

## Ownership

The visible parent is a dispatcher, never a builder. It resolves the confirmed issue set and
configured targets, reads each issue's acceptance criteria and declared mutation paths, prepares
one fresh digest-bound contract per lane, and computes only real hard dependency edges:

- explicit issue dependencies;
- exact shared declared mutation files;
- database migration ordering; and
- exact configured global/high-fan-in files.

Domain keywords, directory proximity, cost, co-change guesses, missing paths, and uncertainty do
not create edges. Ambiguous scope is visible and defaults to isolated parallel work. A predecessor
is satisfied only by its verified `DONE` result with `dependency=SATISFIED`; invalid, decomposed,
gated, failed, or merely dispatched lanes do not unblock dependents.

## Native dispatch

Use the installed `specs/helpers/dispatch.mjs batch` preparation output unchanged. It binds the
repository, issue, target, model, remediation limit, issue contract, verification catalog,
prepared worktree, packaged control-plane root, and exact launch identity. Launch the generated
request with the native `subagent` workflow and the approved active-owner limit; do not reconstruct
its promise graph or search sibling worktrees for configuration. Each owner uses its exact prepared
`cwd` with `worktree: false`; a stale or wrong workspace is an internal binding/recovery failure,
not a product gate.

The dispatcher admits ready lanes up to the configured capacity, preserves one writer per lane,
resumes one retained technical failure when the native result is explicitly resumable, and keeps
unrelated lanes moving. It does not create claims boards, leases, scoring passes, progress
heartbeats, hidden journals, or automatically executed improvement backlog.

## Completion

Reconcile each lane from its exact native result and authoritative GitHub state as `DONE`, `GATED`,
`FAILED`, or `IN_PROGRESS`. Work-on owns investigation, implementation, review, remediation,
merge, issue closure, and its terminal records. The parent owns dependency unblocking and
ownership-safe cleanup of only its detached prepared bases. Report wall time, usage, model,
first-pass acceptance, review/remediation rounds, waits, follow-ups, and residual limits without
counting gates or decomposition as delivery.
