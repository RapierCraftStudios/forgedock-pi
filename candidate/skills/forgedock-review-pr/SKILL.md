---
name: forgedock-review-pr
description: Independently review one frozen issue pull request and publish an evidence-bound decision
---

# ForgeDock review-pr

This route is a read/review owner, not a builder. Resolve the actual repository, PR, base/head,
linked issue, and route identity once. A branch name in prose is not route identity. If the PR
is an explicit integration-to-protected promotion, hand off to `forgedock-review-pr-staging`;
an ordinary issue PR targeting integration remains standard review.

Freeze the exact source head and base. Review the patch first, then relevant consumers and
producer/consumer boundaries. Reuse deterministic build evidence bound to the same head; run
only missing or stale relevant checks. A target-branch move alone does not invalidate an
unchanged clean standard-review head: its panel record retains the original base SHA while
revalidating the live base ref, exact source head, retargeting, and conflict state. Protected
promotion (`mode: staging`) still requires the exact frozen base SHA. Do not rebuild the entire
repository map or rerun/rebase a completed review merely to publish its existing parent evidence;
retain the parent's applicability decision about the advanced integration target.

Select one correctness/integration reviewer by default. Add security only for a material
changed trust, privilege, or security boundary. Add another specialist only for a concrete
question not covered by the assignments, with a short rationale in the review request. File
count, labels, domains, and keywords do not allocate seats.

Use `forge-candidate prepare-review` to produce one native `workflowScriptPath`, then invoke it
with `subagent` and wait for every selected fresh `forgedock-reviewer`. This profile has only
read tools plus the publication-only report tool. Give each reviewer the original acceptance,
concise plan/history, exact frozen identity, relevant evidence/limits, and specific risk
boundary. Each reviewer must publish its own substantive exact-head
`FORGE:REVIEWER_REPORT` using the candidate record helper, including clean/no-findings reports.
Reviewers do not edit source, create issues, merge, deploy, or initiate repair. If publication
fails after analysis, retain the saved report and recover publication without rerunning review.

The parent validates identity/report readback, deduplicates by causal mechanism, and publishes
one `REVIEW-PANEL` PR record through the candidate record helper. The panel body carries the
authoritative disposition: `IMMEDIATE REPAIR`, `NON-BLOCKING FOLLOW-UP`,
`REJECTED/NOT APPLICABLE`, or `EVIDENCE/AUTHORITY PREREQUISITE`; its generated header links every
actual individual report. Severity labels do not decide blocking. A consequential
acceptance/patch defect blocks; a confirmed permitted follow-up does not hold the PR hostage.
Missing required evidence or role is gated, never approval. Re-review is scoped to a genuine
repair and affected conclusions; a second same-mechanism failure gets a concrete diagnosis and
respects the configured limit.

Merge only if explicitly authorized, the accepted reviewed head is current, required checks
pass, and the PR is mergeable. Review never closes issues or deploys.
