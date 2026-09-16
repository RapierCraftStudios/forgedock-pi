---
name: forgedock-review-pr-staging
description: Run one non-merging integration-to-protected deployment gate.
---

# ForgeDock Staging Review

This route is only for an explicit integration-to-protected deployment or bundle PR. It
never replaces standard review for an ordinary issue PR, even when the integration branch
is also the repository default.

Read the staging mechanics in `../../specs/pi-adapter.md`, parse the target repository's
canonical `forge.yaml` once, verify active GitHub/repository access, and freeze the exact PR
head/base and merge base. Standalone staging preparation uses
`dispatch.mjs standalone-review` with exact PR/head/base/mode/roles and no fabricated issue;
model, timing, wave concurrency, collection margin, panel deadline, and bounded launch/recovery
allowance come from the canonical config. Missing or conflicting configuration fails before
reviewer admission.

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
Each reviewer writes and retains a complete report, then publishes its own exact-head
`FORGE:REVIEWER_REPORT` comment through the installed file-backed `record.mjs reviewer` helper
before returning. The report includes role, PR/head/base, scope and decisions, substantive
evidence/findings or evidence-backed no findings, limitations, and recommendation. Reviewers
never create issues, edit source or labels, initiate remediation, merge, or deploy.

The staging owner retains successful same-head reports, reads back every required comment, and
links all report references from the final gate. Use route `mode: "staging"` in each explicit
review authorization and consolidated panel draft so a protected-base move cannot be treated as
an ordinary transport retry. If a role stalls or publication/result delivery fails, establish the
old native child/workflow terminal state first, then recover only that role
with the same authorization and saved report bytes. Use supported retained resume when the
native status marks it resumable; otherwise use a fresh same-role workflow with a new key. A wait timeout
must not start a second live reviewer; a partial panel cannot pass the gate. Standalone
preparation bounds this recovery with `review.launch_allowance` (default: two launches per
selected role), and retains the original authorization/report bytes.

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

Read back that exact gate comment ID. Never edit code, dispatch repair agents, invoke
work-on/remediation, create repair commits, merge, approve, deploy, close source issues,
mutate issue branches, or clean work-on-owned trees. Reviewer/transport recovery remains
non-remediating; a valid blocker produces FAIL and ends this invocation.
