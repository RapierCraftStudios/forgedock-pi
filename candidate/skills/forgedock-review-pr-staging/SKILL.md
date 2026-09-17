---
name: forgedock-review-pr-staging
description: Run a non-merging integration-to-protected promotion gate with evidence and no repair
---

# ForgeDock staging review

Use this route only for an explicit integration-to-protected promotion or bundle. Resolve the
actual promotion PR/configuration and freeze exact integration/protected head/base identities.
The standard review route hands off here only after the prepared policy identifies the actual
protected base; issue text, comments, branch names, and the word `staging` do not select this
route.
Determine included work from same-repository commit reachability, not issue numbers, branch
names, or commit-message guesses. An ordinary issue PR targeting integration uses standard
review.

Run only configured checks relevant to the frozen bundle and reuse exact-head evidence when
inputs are unchanged. Keep the exact promotion checkout as `sourceRoot` and the canonical
checkout containing `forge.yaml` as `configRoot` when they differ. Collect the actual protected-PR policy and check association with
`inspect-pr`/the supported GitHub interfaces before deciding requiredness. A missing, pending,
failed, or unscheduled required check is reported by name; an optional or feature-PR check is
not promoted into this gate. Missing required runtime/integration/configuration authority is a
precise FAIL prerequisite, not permission to claim PASS. Structural checks do not substitute
for a required runtime boundary.

Select at most three reviewer roles. `forge_prepare_review.roles` accepts only
`correctness`, `security`, and `specialist`; never pass target-domain names such as `infra`,
`database`, or `concurrency`. Combine distinct questions into one `specialist` assignment or
omit `roles` and let the bounded helper derive the roster. Select correctness plus only concrete
risk-justified specialists. Use the `forge_prepare_review` tool to create the validated frozen request and its read-only repository/PR policy facts, launch
fresh `forgedock-reviewer` reviewers through that generated native request, and wait for every
role; their source tools are read-only and their only mutation capability is the report publisher.
Use `forge_run_check` for configured local checks only when the prepared configuration declares
them; each real local check needs its receipt, and an empty local-check set is valid only when
the collected current GitHub required-check evidence is complete and passing. Use
`forge_publish_record` for the consolidated
gate, passing the existing review root and artifact key so it loads the policy artifact bound
by `forge_prepare_review` (do not echo the policy object), with `kind: STAGING_GATE`, the frozen
PR/head/protected-base identity, and `gate: PASS` or `FAIL`; feed
`configPath`, `configSha256`, `reviewRoot`, `artifactKey`, `sourceRoot`, and `head` from the
prepared review details to each `forge_run_check`; do not use bash/edit/write in this route.
Each reviewer publishes its own exact-head report, including a substantive clean report. For
an explicitly user-invoked review, preparation and reviewer publication use `publish: true`. No
reviewer edits source, creates issues, merges, deploys, closes issues, or starts repair.

If preparation or a configured check returns a deterministic validation error, stop after
one unchanged attempt and report its exact bounded operation/error. Do not retry it unchanged or
read helper source, sibling/old worktrees, or broad historical artifacts; full diagnostics stay
in the external artifact path supplied by the tool.

Read back reports and publish one consolidated `FORGE:STAGING_GATE:PASS` only when every required
check and role is complete with no immediate repair or mechanical gate. Otherwise publish
`FORGE:STAGING_GATE:FAIL` with the exact finding, missing proof, or wake condition. A staging
pass is integration evidence, not production authorization.
