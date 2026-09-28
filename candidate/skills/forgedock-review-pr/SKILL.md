---
name: forgedock-review-pr
description: Independently review one frozen issue pull request and publish an evidence-bound decision
---

# ForgeDock review-pr

This route is a self-contained read/review owner, not a builder. A bare positive PR number is
resolved from the canonical `forge.yaml` in the current target checkout (`project.owner/repo`);
`/review-pr <N>` does not depend on a prior `/forge-status` or prior session state. Pi accepts one
slash command per input. If multiple ForgeDock commands arrive in one message, the router rejects
them explicitly; do not interpret them as a batch. `/forge-status` is a direct status command, not
workflow setup or an instruction to search for ForgeDock. Ask for clarification only when the
configured repository or PR identity cannot be resolved unambiguously. A branch name in prose is not route identity. If the
prepared policy identifies an integration-to-protected promotion, hand off to
`forgedock-review-pr-staging`; an ordinary issue PR targeting integration remains standard review.

Freeze the PR identity and review context with one minimal `gh pr view` query (head, base
ref/SHA, state, mergeability, title, and body); do not make a separate body query. Then use
`forge_prepare_review` once to resolve the exact clean source worktree,
canonical `configRoot`, route, and full repository policy. That registered operation already runs
`inspect-pr`, preserves complete evidence in `policy.json`, and returns a compact source-attributed
`policy-summary.json`; do not run standalone `inspect-pr` or read the raw policy artifact wholesale.
Use the summary's explicit known/unknown states for setup and reviewer context; read only a
specific policy field if a concrete conclusion requires it. The final gate performs its own
necessary current-policy refresh. Never search `.pi` session transcripts or inventory historical
`.forge` artifacts to determine package/status setup; use the registered status and review tools.
The retired `.forge/config.json` is not workflow authority. Honor active `AGENTS.md` and other
canonical project guidance, reading only the applicable material. Review the frozen patch first,
then relevant consumers and producer/consumer boundaries. Use the exact-head review checkout as
`sourceRoot` and the canonical target checkout containing `forge.yaml` as `configRoot` when those
roots differ; never copy config into the frozen source checkout. Reuse deterministic build evidence
bound to the same head and run only missing/stale relevant checks. If a configured local check must
run, do it while the exact source checkout is clean and before launching reviewer children; native
reviewer artifacts may make a later clean-tree check reject a rerun. Reuse exact-head receipts and do
not weaken clean-tree validation or delete runtime artifacts. Do not infer the protected route
from issue/comment/branch prose. GitHub's evaluated active branch rules, legacy protection,
rulesets, PR-associated checks, route, and repository configuration establish requiredness;
workflow names and empty/nonzero `gh pr checks` output do not. A target-branch move alone does not
invalidate an unchanged clean standard-review head: retain the original base SHA while validating
live base ref, exact source head, retargeting, and conflicts. Protected promotion still requires
the exact frozen base SHA.

Select one correctness/integration reviewer by default. `forge_prepare_review.roles` accepts at
most three values and only `correctness`, `security`, and `specialist`; never pass target-domain
names such as `infra`, `database`, or `concurrency`. Combine distinct questions into one
`specialist` assignment or omit `roles` and let the bounded helper derive the roster. Add security
only for a material changed trust, privilege, or security boundary. File count, labels, domains,
and keywords do not allocate seats.

Use `forge_prepare_review` to produce `reviewRoot`; its returned `request` object is the exact
`request.json` content, so pass it unchanged to `subagent` without rereading the file. The generated
request fixes the selected role roster,
concurrency (at most two), timeouts, and hashed native workflow; do not reconstruct or edit it.
Wait for every selected fresh `forgedock-reviewer`. For a protected promotion, the actual policy
result activates the restricted route. This profile has only read tools plus the publication-only
report tool. Give each reviewer the original acceptance,
concise plan/history, exact frozen identity, relevant evidence/limits, and specific risk
boundary. Each reviewer must publish its own substantive exact-head
`FORGE:REVIEWER_REPORT` using the candidate record helper, including clean/no-findings reports.
For an explicitly user-invoked review, pass `publish: true`; review-only authorization does not
permit merge, issue closure, or deployment, but it does require the evidence publication path.
Reviewers do not edit source, create issues, merge, deploy, or initiate repair. The workflow
returns one compact native result per role (`key`, `runId`, terminal state, exit code, bounded
output/error, artifact references, exact report path, and recovery-input path). The workflow's
`publicationState: unverified` only means the parent has not independently finalized delivery; it
does not override a successful `FORGE_REVIEW_RESULT ... publication=published` line. Read each local
report once, then let adjudication perform the necessary final exact remote readback.

Before parent adjudication, read each selected role's `reportPath` once and verify its
`FORGE:REVIEWER_REPORT` identity and structured observations match the prepared repository, PR,
head, base, and role. A local marker alone is insufficient. The registered adjudication tool
independently validates retained authored body/observations and performs the final exact remote
comment readback before writing the decision. Do not call the recovery tool to re-verify a role
whose workflow result already says publication succeeded; it is for missing or uncertain delivery.

If delivery is absent or uncertain, never rerun/resume the reviewer. Call
`forge_recover_reviewer_publication` with the exact selected role, native `runId`, common review
`artifactKey`, frozen identity, and the native terminal result. A completed role with available
role-bound authored input may use at most one parent publication attempt. Once a claim or attempt
exists, the same tool becomes readback/finalization only: it verifies local canonical report bytes
and the remote stable comment without another POST. Outer cancellation, interruption, timeout, or
an unresolved claim is not mislabeled as publication failure or exhaustion. A missing native
terminal outcome is `nonterminal`, not `failed`; preserve it and do not recover until the exact role
is terminal. Preserve completed roles. Use `forge_publish_incomplete_review` only when delivery remains unverified; it must retain
the observed claim/attempt state and precise next prerequisite. If a completed role has unused
authorized recovery, perform that normal recovery instead of publishing GATED; the explicit
`execution-limit` blocker is reserved for an observed parent execution limit and does not consume a
recovery attempt. This GATED record is not a verdict, code finding, or pre-review infrastructure
failure. If later readback verifies delivery, proceed to adjudication; the tool automatically
supersedes the matching published incomplete-delivery record in the REVIEW-PANEL record.

Before parent publication, call `forge_discover_review_records` once with the prepared
`reviewRoot` and `artifactKey`; use its compact bounded index and read selected `bodyPath` files
for full historical records. An older report is history, not an automatic verdict, and a newer
clean report does not silently resolve it. Reviewers must inspect primary source/workflow evidence
rather than independently repeating supplied claims. Every reviewer report
must have a complete structured observation list (or an explicit empty list). The parent then
calls `forge_publish_adjudication` with one decision for every observation ID, grouping duplicate
causes explicitly and retaining every contributing source ID. `decisions` is only for current
reviewer observations. Historical concerns use the required `historicalDecisions` array as the
single representation: retain the original `sourceReference`, explicit disposition, resolution,
rationale, evidence, stage, blocking status, and applicable tracking. A disproven historical
allegation still needs a `REJECTED/NOT APPLICABLE` record; when no historical concern applies,
pass `historicalDecisions: []`. Do not pass legacy prose such as `priorConcerns`. Each decision must state the
resolution (`confirmed`, `resolved-by-evidence`, `superseded`, `duplicate`, or `unsupported`),
one of `IMMEDIATE REPAIR`, `NON-BLOCKING FOLLOW-UP`, `REJECTED/NOT APPLICABLE`, or
`EVIDENCE/AUTHORITY PREREQUISITE`, the evidence/rationale, required stage, and whether it blocks
this stage. A clean panel is valid: use an empty decision list and state code findings and
unresolved prerequisites are none.

For an accepted non-blocking follow-up, call `forge_resolve_review_tracking` before publication,
including closed plausible matches. Reuse a verified existing issue when it owns the same causal
behavior; otherwise include one actionable draft in the adjudication. Set `allowIssueWrites` only
when the current parent has explicit permission. The bounded parent tool publishes at most one
issue per deduplicated decision, reconciles ambiguous create responses, and records an exact
pending draft when permission or transport is unavailable. Reviewers never receive these tools.

The parent tool publishes the single authoritative `REVIEW-PANEL` record from the same structured
decision used for tracking. Use the common `artifactKey` returned by `forge_prepare_review`, not
any child role authorization key. A successful adjudication result is terminal for that revision;
do not repeat an unchanged publication or use a record ID where a returned HTTPS panel permalink
is required for `supersedes`. If a readback-only parent-panel GET returns a transient transport
error, use the tool's bounded same-revision reconciliation result; never increment the revision or
POST a duplicate. Missing required evidence or role is gated, never approval. Re-review is scoped
to a genuine repair and affected conclusions; a second same-mechanism failure gets a concrete
diagnosis and respects the configured limit.

After successful final publication, use the returned structured panel/gate result for the concise
operator response. Do not reread the completed decision/gate artifacts, start another inspection,
or reopen the review. Finish with the reviewed identity, verdict/gate, report/panel/gate links,
accepted prerequisites/findings, publication limitations, and next authorized action.

If a helper or configuration operation returns a deterministic validation error, stop after
that unchanged attempt and report the exact bounded operation/error. Do not retry the same input,
read helper implementation or sibling/old worktrees, or perform broad repository archaeology;
resume only after a real input, identity, or configuration change. Full diagnostics remain in the
external artifact named by the tool rather than being expanded into model context.

Merge only if explicitly authorized, the accepted reviewed head is current, required checks
pass, and the PR is mergeable. Review never closes issues or deploys.
