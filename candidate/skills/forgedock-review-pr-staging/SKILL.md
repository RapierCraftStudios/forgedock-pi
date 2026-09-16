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

Select correctness plus only concrete risk-justified specialists. Use the `forge_prepare_review`
tool to create the validated frozen request, launch fresh `forgedock-reviewer` reviewers through
that generated native request, and wait for every role; their source tools are read-only and their
only mutation capability is the report publisher. Use `forge_run_check` for configured checks and
`forge_publish_record` for the consolidated gate, passing `kind: STAGING_GATE`, the frozen PR/head/
protected-base identity, and `gate: PASS` or `FAIL`; feed `configPath`, `configSha256`,
`reviewRoot`, `artifactKey`, `sourceRoot`, and `head` from the prepared review details to each
`forge_run_check`; do not use bash/edit/write in this route.
Each reviewer publishes its own exact-head report, including a substantive clean report. No
reviewer edits source, creates issues, merges, deploys, closes issues, or starts repair.

Read back reports and publish one consolidated `FORGE:STAGING_GATE:PASS` only when every required
check and role is complete with no immediate repair or mechanical gate. Otherwise publish
`FORGE:STAGING_GATE:FAIL` with the exact finding, missing proof, or wake condition. A staging
pass is integration evidence, not production authorization.
