---
description: Review one integration-to-protected deployment bundle without merging
argument-hint: "[PR number | staging]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ForgeDock Staging Review

This route is only an explicit integration-to-protected deployment or bundle gate. It is not
ordinary issue review, never merges, never deploys, never closes source issues, and never cleans
work-on-owned trees. The Pi-facing staging skill is the entrypoint; this file defines its compact
proof and publication contract.

## Freeze the bundle

Resolve `forge.yaml`, the configured integration/protected branches, repository identity, active
read authority, and the exact PR head/base/merge base once. Determine bundle membership from
same-repository commit reachability from the frozen integration head, excluding commits already
reachable from the protected base. Reject ambiguous PR identity and repeated metadata. Do not
infer membership from issue numbers, commit-message text, or branch guesses.

Load current review records for included PRs once. A current parent-dispositioned `IMMEDIATE
REPAIR`, degraded panel, stale identity, unresolved required proof, conflict, or required-check
failure blocks the gate. `NON-BLOCKING FOLLOW-UP`, rejected, pre-existing, advisory, and unrelated
context remains visible but does not become a deployment blocker by label alone.

## Required verification

Run only configured checks applicable to the frozen bundle: protected-target build and CI,
migration/schema and dependency checks when changed, environment/configuration completeness,
runtime/regression smoke gates, and `Skill("test-gate", ...)` when the configuration
requires it. Reuse exact-SHA evidence only when content and relevant environment inputs are
unchanged. Missing required proof is a failure with its exact capability and wake condition; an
irrelevant unavailable service must not gate a bundle that does not require it. Structural tests
cannot stand in for a required runtime, integration, browser, database, queue, or credential
boundary.

## Fresh bundle panel

Select correctness plus only risk-justified specialists. Launch fresh ordinary generic `delegate`
reviewers concurrently with the frozen bundle, acceptance, active paths, prior decisions, exact
head/base, and verification evidence. Reviewers return structured evidence to the staging owner;
they do not edit, post per-reviewer comments, create issues, edit labels, merge, or deploy. The
owner joins every required result, retries only missing/invalid roles, deduplicates by causal
mechanism, and applies the same dispositions as standard review: `IMMEDIATE REPAIR`,
`NON-BLOCKING FOLLOW-UP`, `REJECTED/NOT APPLICABLE`, or `EVIDENCE/AUTHORITY PREREQUISITE`.
Severity alone is not a disposition.

Create at most one authorized issue for each novel, independently valuable non-blocking causal
concern. Preserve current blockers and required proof failures in the gate record instead of
turning them into recursive issue work.

## Terminal gate

Recheck the frozen head and required evidence, then publish exactly one owner-authored,
SHA-bound consolidated gate record and read back its identity:

- `FORGE:STAGING_GATE:PASS` only when every required check and required reviewer result is complete
  and no immediate repair or mechanical gate remains;
- `FORGE:STAGING_GATE:FAIL` with precise failed checks, findings, missing proof, or wake conditions
  otherwise.

A staging pass is integration evidence, not production proof. Never merge, approve, deploy, close
source issues, mutate issue branches, publish per-reviewer comments, or clean work-on trees here.
