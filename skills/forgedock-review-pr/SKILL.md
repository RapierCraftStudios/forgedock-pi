---
name: forgedock-review-pr
description: Review one frozen PR with a risk-selected fresh panel, one verdict, and guarded merge.
---

# ForgeDock Review PR

Read the reviewer section of `../../specs/pi-adapter.md`. Resolve `forge.yaml`, active
GitHub identity, repository, PR, and merge authorization once. A standalone PR and a
work-on-owned PR use the same review standard.

## Freeze

Fetch one snapshot containing PR number/title/body/state, full head/base SHAs, merge base,
changed files, diff, checks, existing exact-head verdict, and linked issue. Stop only for
closed/merged state, invalid route, or unavailable required authority.

Base movement does not invalidate an unchanged clean reviewed head. Reconcile only for an
actual conflict or required-up-to-date policy. Re-review after reconciliation only when
the effective patch or risk changed.

## Verify

Reuse trusted builder checks bound to the same head. Run only missing, stale, review-
specific, or independently security-relevant checks. Do not rerun identical deterministic
commands against an unchanged SHA.

## Select reviewers

Always cover correctness. Add security for executable code or trust boundaries. Add only
specialists justified by actual changed behavior: auth, data/migrations, concurrency,
API/integration, frontend/accessibility, infrastructure/reliability, scraping/browser, or
test quality. File count and domain keywords alone do not add reviewers.

Use medium thinking for documentation/templates/metadata and high for executable,
security, auth, data, concurrency, or cross-file behavior. Thinking level never lowers the
blocking standard.

For remediation, select blocker-producing roles plus one general reviewer. Every new
executable-code head also receives security review even when security did not produce the
original blocker. Add another specialist only when remediation changed that specialist's
risk surface.

## Run one panel

Prepare the full diff once and deterministic role bundles. Embed the relevant diff in each
task or give the delegate one stable readable file path; never use `runs.host` to transfer
it. Launch all selected roles as fresh ordinary `delegate` agents with full normal tool
availability through the adapter's single `runs.all` workflow. Prompts assign review focus
without creating specialized agent profiles or capability ceilings. Each task carries the
acceptance invariants, test evidence/scope, and bounded ordinary diff/context (start with
normal diff context, then read relevant callers). Deduplicate roles; a correctness/general
blocker-producing role already counts as the required general re-review. Correctness must
check whether the regression catches the original defect, not just that it passes. If a role runs longer than three minutes, its task asks for at most one
`contact_supervisor` progress update naming the role, head, and current evidence step; this
is runtime visibility, never a GitHub artifact. Join every role and retain valid same-head
roles. If one role is missing or invalid, launch one additional workflow containing only that role; never restart the whole panel.

Bind repository, PR, head/base, attempt, and role from the launch key and task rather than
requiring the delegate to echo them perfectly. Accept JSON or clearly structured Markdown
when it contains a verdict, substantive summary, verified `path:line` behaviors, residual
risks, and findings. A blocker identifies a reachable trigger, the patch-caused causal
chain, existing mitigations checked, and concrete production impact; speculation or
independent pre-existing debt is not a blocker. Normalize harmless key casing, number/string, and list-shape differences in the
owning agent. Retry only when the child failed or no substantive review can be recovered;
formatting variance alone never restarts a role or panel. Blocking findings still require
the confirmed HIGH/CRITICAL production-incident standard.

After complete validation, the owning agent publishes one SHA-bound consolidated panel comment
containing every role's summary, acceptance invariants, test evidence/scope,
verified behaviors, residual risks, and findings, then one official review verdict. Read
back the exact IDs. Use quoted, file-backed bodies. When the active identity authored the
PR, record the official verdict with `gh pr review --comment --body-file`; do not attempt
self-approval or invent `gh pr reviews`. This never replaces a branch-required independent
approval. No per-role POST/readback choreography, shell-regex grammar, body-integrity tokens,
or review-start/checkpoint comments are required.

## Decide

- Any confirmed patch-caused blocking finding: `CHANGES_REQUESTED`.
- No blockers and one or more follow-ups: `APPROVE_WITH_FOLLOW_UP`.
- No findings: `APPROVE`.
- Missing/invalid role after its bounded retry: `review-degraded`, no verdict.

Keep work-on blockers on the existing PR/source issue for cohesive remediation. Create at
most one valuable independent follow-up issue per causal concern; advisories may remain in
the consolidated report.

Merge only when explicitly authorized, the current head equals the accepted reviewed head
or a proven equivalent patch, required checks pass, the PR is mergeable, and no blocker
remains. Review never closes the linked issue or cleans its worktree.

Use the staging review strategy only for an explicit integration-to-protected deployment
or bundle review. An ordinary issue PR targeting the configured integration branch keeps
this standard approving review even when that integration branch is also the repository
default. Staging review remains a non-merging deployment gate.
