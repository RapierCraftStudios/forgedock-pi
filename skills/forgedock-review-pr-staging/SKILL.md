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

Fetch unresolved review-finding issues for included PRs once. A current confirmed blocker
fails the gate; unrelated, closed, duplicate, possible, advisory, or pre-existing findings
remain report context.

## Run deployment checks

Run only configured checks applicable to the frozen bundle:

- protected-target build and required CI;
- migration/schema and dependency safety when changed;
- environment/configuration completeness;
- runtime/regression smoke gates configured for staging promotion;
- `forgedock-test-gate` when required, preserving its PASS/BLOCK/SKIP result.

Reuse valid exact-SHA evidence and do not rerun identical deterministic checks. Missing
required configured evidence fails the gate with the exact missing check; it does not
become a generic human escalation.

## Fresh review

Select only roles justified by the aggregate bundle risk. Launch them as fresh ordinary
`delegate` agents with full normal tools in one concurrent workflow. Require complete
structured evidence with summaries, verified behaviors, residual risks, and findings.
Retain valid roles and retry only a missing/invalid role.

Cluster corroborating findings by shared root cause and behavioral invariant. Create at
most one `forgedock-issue` per novel actionable causal defect. Preserve every confirmed
patch-caused HIGH/CRITICAL blocker; keep lower-confidence or independent observations in
the consolidated report.

## Terminal gate

Recheck the exact frozen head and required checks, then publish exactly one SHA-bound
consolidated gate comment:

- `FORGE:STAGING_GATE:PASS` when every required check and reviewer passes with no blocker;
- `FORGE:STAGING_GATE:FAIL` with precise failed checks/findings otherwise.

Read back that exact comment ID. Never merge, approve, deploy, close source issues, mutate
issue branches, create per-reviewer comments, or clean work-on-owned trees.
