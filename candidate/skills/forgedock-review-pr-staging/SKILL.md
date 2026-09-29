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
checkout containing `forge.yaml` as `configRoot` when they differ. Freeze PR identity with one
minimal `gh pr view`, then call `forge_prepare_review` once; it collects the protected-PR policy,
saves complete evidence in `policy.json`, writes `policy-summary.json`, and returns its compact
source-attributed summary. Do not run standalone `inspect-pr` or read the raw policy artifact
wholesale. A missing, pending, failed,
or unscheduled required check is reported by name; an optional or feature-PR check is not
promoted into this gate. A policy-accepted `SKIPPED` or `NEUTRAL` conclusion satisfies merge-status
policy without claiming that the job executed. Inspect the primary workflow condition and detector
at the frozen head before deciding execution is separately required. Do not gate on `required +
skipped` alone: an `EVIDENCE/AUTHORITY PREREQUISITE` needs an identified acceptance/policy source
or concrete demonstrated defect. Record the source and contrary/confirming evidence. Missing
required runtime/integration/configuration authority is a precise FAIL prerequisite, not permission
to claim PASS. Structural checks do not substitute for a required runtime boundary; the gate does
one necessary fresh policy refresh at publication.

Select at most three reviewer roles. `forge_prepare_review.roles` accepts only
`correctness`, `security`, and `specialist`; never pass target-domain names such as `infra`,
`database`, or `concurrency`. Combine distinct questions into one `specialist` assignment or
omit `roles` and let the bounded helper derive the roster. Select correctness plus only concrete
risk-justified specialists. Use `forge_prepare_review` to create the validated frozen request
and read-only repository/PR policy facts. Its returned `request` object is the exact `request.json`
content; retain it unchanged without rereading the file. The staging guard rejects arbitrary child
launches, inline workflows, modified role/timeout/concurrency settings, and writer capabilities.
After preparation, use registered read/check tools only; do not retry blocked Bash calls. Before
launching reviewers, run each relevant configured local check once through `forge_run_check`,
using the frozen details. The native child runtime can create `.pi/subagents` artifacts in its
source checkout after launch, which makes the clean-tree check reject a later local-check rerun;
capture and reuse receipts instead of invoking checks after the roster runs. The staging launch
hook enforces one attempt per configured check and rechecks the exact source head/cleanliness before
claiming the roster; after launch it blocks check reruns. A failed check attempt is not a PASS receipt.
The exact frozen review identity may claim only one prepared roster per Pi session; re-preparing or reusing a workflow for
that same identity after a later input is blocked. Then pass the exact returned request unchanged to
`subagent` and wait for every fresh `forgedock-reviewer`; their source tools are read-only and their
only mutation capability is the report publisher.
Reuse the prepared check receipts at the gate; an empty local-check set is valid only when the
collected current GitHub required-check evidence is complete and passing. Use
`forge_discover_review_records` once with the prepared `reviewRoot` and `artifactKey`.
It returns a compact bounded index plus readable `bodyPath` files for selected full records; read
those paths before carrying a historical concern. Do not use truncated tail JSON as evidence.
Current reviewers must inspect primary workflow/source evidence rather than independently repeating
supplied reviewer prose. The workflow returns compact per-role native terminal results with each
native run ID, status, bounded output/error, artifact references, report path, and recovery-input
path. Read each local report and observations once. `publicationState: unverified` means the
parent has not finalized delivery; it does not override a successful `FORGE_REVIEW_RESULT ...
publication=published` line. `forge_publish_adjudication` is the final exact-content and remote-
comment-readback boundary; it blocks before saving its input if any role is missing, misbound,
altered, or undelivered. Do not call the recovery tool to re-verify a role already reported as
published; use it only when delivery is absent or uncertain. If a genuine `need_decision` or
`interview_request` arrives, answer through `subagent_supervisor` without launching a new reviewer;
ignore routine progress/completion notices and retain material plan-changing discoveries for
adjudication.
`forge_recover_reviewer_publication` may publish only one exact completed role from its saved,
hash-checked author input. A previously claimed/attempted operation re-enters as readback-only;
it never clears a lock or POSTs again. Outer cancellation, interruption, timeout, and non-terminal
children remain distinct from delivery outcome. A transient parent-panel comment GET is retried
once against the same comment identity; if readback remains unresolved, preserve the same revision
and use the reported readback-only reconciliation action, never a new POST. Staging never resumes
or launches another child.
If delivery remains incomplete, `forge_publish_incomplete_review` records the observed state without
claiming an unused attempt was exhausted or cancelling active recovery. Do not GATED-preempt an
available completed-role recovery. An observed parent execution limit may be recorded explicitly
without burning that recovery allowance. If a claimed operation or remote result is unresolved,
GATED records the claim as unresolved and permits readback-only finalization. A later adjudication
supersedes the published incomplete-delivery record. GATED is post-review delivery status, not a
pre-review infrastructure failure, reviewer finding, verdict, or gate PASS/FAIL. Retain completed
reports and call `forge_publish_adjudication` after local report identities/observations match; it
verifies remote delivery before writing. The parent must map every
structured observation ID to one explicit disposition, preserve duplicates/resolutions, and state
whether a prerequisite applies to this promotion stage. `decisions` covers current reviewer
observations only. Put every applicable historical concern in the required
`historicalDecisions` array with its original source reference, explicit disposition, rationale,
evidence, stage, blocking status, and tracking; a rejected allegation still gets an explicit
`REJECTED/NOT APPLICABLE` record. Use `historicalDecisions: []` when none apply, never legacy
`priorConcerns` prose. Every accepted `IMMEDIATE REPAIR`
needs verified existing/source tracking, one authorized deduplicated issue, or a saved actionable
pending draft; rejected findings and clean reviews use no tracking. Historical applicable concerns
must enter this same decision/tracking path with their original report/attempt reference; do not
inherit their authority from age or same-head identity. For a non-blocking follow-up, use
`forge_resolve_review_tracking` first; reuse a verified existing issue or provide one actionable
draft. Set `allowIssueWrites` only when explicitly authorized. The parent tool is the only issue
publication capability and records pending drafts on permission/transport failure.

The adjudication tool writes one shared decision artifact. Use the common `artifactKey` returned
by `forge_prepare_review`, not a child role authorization key. A successful adjudication result
is terminal for that revision; do not repeat unchanged publication, and use only a returned HTTPS
panel permalink (never a record ID) for `supersedes`. Pass its `decisionPath` as
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

After every selected report is read back and parent adjudication completes, publish one
`FORGE:STAGING_GATE:PASS` only when every required check is satisfied with no immediate repair
or mechanical gate. Publish `FORGE:STAGING_GATE:FAIL` only for a completed review with an exact
blocking finding, missing proof, or wake condition. Incomplete report delivery remains a `GATED`
post-review record with no verdict or staging gate. Once `forge_publish_record` returns a verified
published result, include both exact returned permalinks on separate labeled lines (`REVIEW-PANEL`
and `STAGING_GATE`), then finish the operator response immediately; never cite only the gate or a
provisional panel. Do not reread saved adjudication/gate files or begin another inspection. If this route opened a
local todo, mark it completed as the last tool call after verified publication, then return the
response. A staging pass is integration evidence, not production authorization.
