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
not promoted into this gate. A policy-accepted `SKIPPED` or `NEUTRAL` conclusion satisfies the
merge-status requirement without claiming that the job executed. Do not gate on `required +
skipped` alone: it becomes an `EVIDENCE/AUTHORITY PREREQUISITE` only when an identified
acceptance/policy source or a concrete demonstrated defect requires executed proof; record that
source in the adjudication. Missing required
runtime/integration/configuration authority is a precise FAIL prerequisite, not permission to
claim PASS. Structural checks do not substitute for a required runtime boundary.

Select at most three reviewer roles. `forge_prepare_review.roles` accepts only
`correctness`, `security`, and `specialist`; never pass target-domain names such as `infra`,
`database`, or `concurrency`. Combine distinct questions into one `specialist` assignment or
omit `roles` and let the bounded helper derive the roster. Select correctness plus only concrete
risk-justified specialists. Use the `forge_prepare_review` tool to create the validated frozen request and its read-only repository/PR policy facts, launch
fresh `forgedock-reviewer` reviewers through that generated native request, and wait for every
role; their source tools are read-only and their only mutation capability is the report publisher.
Use `forge_run_check` for configured local checks only when the prepared configuration declares
them; each real local check needs its receipt, and an empty local-check set is valid only when
the collected current GitHub required-check evidence is complete and passing. Use `forge_discover_review_records` once with the prepared `reviewRoot` and `artifactKey`.
It returns a compact bounded index plus readable `bodyPath` files for selected full records; read
those paths before carrying a historical concern. Do not use truncated tail JSON as evidence.
Current reviewers must inspect primary workflow/source evidence rather than independently repeating
supplied reviewer prose. Then use `forge_publish_adjudication` after every selected report is read back. The parent must map every
structured observation ID to one explicit disposition, preserve duplicates/resolutions, and state
whether a prerequisite applies to this promotion stage. Every accepted `IMMEDIATE REPAIR`
needs verified existing/source tracking, one authorized deduplicated issue, or a saved actionable
pending draft; rejected findings and clean reviews use no tracking. Historical applicable concerns
must enter this same decision/tracking path with their original report/attempt reference; do not
inherit their authority from age or same-head identity. For a non-blocking follow-up, use
`forge_resolve_review_tracking` first; reuse a verified existing issue or provide one actionable
draft. Set `allowIssueWrites` only when explicitly authorized. The parent tool is the only issue
publication capability and records pending drafts on permission/transport failure.

The adjudication tool writes one shared decision artifact. Pass its `decisionPath` as
`adjudicationPath` to `forge_publish_record`; the gate tool renders the `REVIEW-PANEL` section,
report links, dispositions, tracking results, check conclusions, and next action from that same
artifact. Do not write a second independently authored gate body. Use `forge_publish_record` with
`kind: STAGING_GATE`, the frozen PR/head/protected-base identity, and `gate: PASS` or `FAIL`; feed
`configPath`, `configSha256`, `reviewRoot`, `artifactKey`, `sourceRoot`, and `head` from the
prepared review details to each `forge_run_check`; do not use bash/edit/write in this route.
Each reviewer publishes its own exact-head report, including a substantive clean report. For
an explicitly user-invoked review, preparation and reviewer publication use `publish: true`. No
reviewer edits source, creates issues, merges, deploys, closes issues, or starts repair.

If preparation or a configured check returns a deterministic validation error, stop after
one unchanged attempt and report its exact bounded operation/error. Do not retry it unchanged or
read helper source, sibling/old worktrees, or broad historical artifacts; full diagnostics stay
in the external artifact path supplied by the tool.

If the PR already has a published `STAGING_GATE` record for this same exact head, pass its
permalink as `supersedes` when publishing a changed or refreshed result; preserve the earlier
record rather than attempting an overwrite.

Read back reports and publish one consolidated `FORGE:STAGING_GATE:PASS` only when every required
check and role is complete with no immediate repair or mechanical gate. Otherwise publish
`FORGE:STAGING_GATE:FAIL` with the exact finding, missing proof, or wake condition. A staging
pass is integration evidence, not production authorization.
