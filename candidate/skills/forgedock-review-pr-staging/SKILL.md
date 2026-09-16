---
name: forgedock-review-pr-staging
description: Run a non-merging integration-to-protected promotion gate with evidence and no repair
---

# ForgeDock staging review

Use this route only for an explicit integration-to-protected promotion or bundle. Resolve the
actual promotion PR/configuration and freeze exact integration/protected head/base identities.
Determine included work from same-repository commit reachability, not issue numbers, branch
names, or commit-message guesses. An ordinary issue PR targeting integration uses standard
review.

Run only configured checks relevant to the frozen bundle and reuse exact-head evidence when
inputs are unchanged. Missing required runtime/integration/configuration authority is a precise
FAIL prerequisite, not permission to claim PASS. Structural checks do not substitute for a
required runtime boundary.

Select correctness plus only concrete risk-justified specialists. Launch fresh ordinary
read-only `delegate` reviewers through the generated native request and wait for every role.
Each reviewer publishes its own exact-head report, including a substantive clean report. No
reviewer edits source, creates issues, merges, deploys, closes issues, or starts repair.

Read back reports and publish one consolidated `FORGE:STAGING_GATE:PASS` only when every required
check and role is complete with no immediate repair or mechanical gate. Otherwise publish
`FORGE:STAGING_GATE:FAIL` with the exact finding, missing proof, or wake condition. A staging
pass is integration evidence, not production authorization.
