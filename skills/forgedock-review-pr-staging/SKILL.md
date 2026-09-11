---
name: forgedock-review-pr-staging
description: Run one non-merging integration-to-protected deployment gate.
---

# ForgeDock Staging Review

This route is only for an explicit integration-to-protected deployment or bundle PR. It
never replaces standard review for an ordinary issue PR, even when the integration branch
is also the repository default.

Read the staging mechanics in `../../specs/pi-adapter.md`, parse `forge.yaml` once, verify
active GitHub/repository access, and freeze the exact PR head/base and merge base.

## Resolve the bundle

Using same-repository PR metadata and commit reachability, identify only PRs whose reviewed
or merge commits are reachable from the frozen integration head and not the protected base.
Reject ambiguous identities and repeated metadata. Do not infer bundle membership from
issue numbers or commit-message text.

Fetch unresolved review-finding records for included PRs once. A current parent-dispositioned
`IMMEDIATE REPAIR`, degraded panel, stale identity, unresolved required proof, conflict, or
required-check failure fails the gate. `NON-BLOCKING FOLLOW-UP`, rejected, duplicate,
possible, advisory, and pre-existing findings remain report context and do not block by label
or severity alone.

## Run deployment checks

Run only configured checks applicable to the frozen bundle:

- protected-target build and required CI;
- migration/schema and dependency safety when changed;
- environment/configuration completeness;
- runtime/regression smoke gates configured for staging promotion;
- `forgedock-test-gate` when required, preserving its PASS/BLOCK/SKIP result.

Reuse valid exact-SHA evidence and do not rerun identical deterministic checks. Missing
required configured evidence fails the gate with the exact capability and wake condition; an
irrelevant unavailable service does not gate a bundle that does not require it. Structural
checks cannot substitute for a required runtime, integration, browser, database, queue, or
credential boundary.

## Fresh review

Select only roles justified by the aggregate bundle risk. Launch them as fresh ordinary
`delegate` agents with full normal tools in one concurrent workflow. Give them the original
acceptance, active paths, prior decisions, exact frozen head/base, bundle diff, and proof.
Require complete structured evidence with summaries, verified behaviors, residual risks, and
findings. Reviewers return results to the staging owner; they do not post per-reviewer comments,
create issues, edit labels, merge, or deploy. Retain valid roles and retry only a missing or
invalid role.

Cluster corroborating findings by shared root cause and behavioral invariant. The owner assigns
one of `IMMEDIATE REPAIR`, `NON-BLOCKING FOLLOW-UP`, `REJECTED/NOT APPLICABLE`, or
`EVIDENCE/AUTHORITY PREREQUISITE` to every substantive concern. A disposition requires trigger,
reachable path, violated acceptance/invariant, consequence, and patch causality or an explicit
gap; severity and reviewer confidence are separate axes. Create at most one `forgedock-issue`
for a novel, independently valuable authorized follow-up. Keep current immediate repairs and
required-proof failures in the gate record.

## Terminal gate

Recheck the exact frozen head and required checks, then publish exactly one owner-authored,
SHA-bound consolidated gate record:

- `FORGE:STAGING_GATE:PASS` when every required check and reviewer result is complete with no
  immediate repair or mechanical gate;
- `FORGE:STAGING_GATE:FAIL` with precise failed checks, findings, missing proof, or wake
  conditions otherwise.

Read back that exact comment ID. Never merge, approve, deploy, close source issues, mutate
issue branches, create per-reviewer comments, or clean work-on-owned trees.
