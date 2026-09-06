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

## Knowledge-aware independent review

Fresh means independent judgment, not historically blind review. The owner supplies the
linked investigation, classification, contract, context and plan plus concise relevant
constraints. Read the records needed to understand intended behavior, material alternatives
and prior decisions; follow a specific historical gap instead of guessing that unfamiliar
code is wrong or repeating the entire graph search in every role. For standalone/legacy
PRs, use available issue/PR/source history and state missing context; do not fabricate
pre-build records or replay engineering merely to retrofit the new format.

For each substantive concern distinguish regression/unmet acceptance, a currently valid
deliberate trade-off, superseded/stale concern, independent debt, or unresolved evidence.
Cite the decision considered and explain why current evidence preserves or overturns it.
A past approval is not a waiver of a newly demonstrated failure. Missing rationale is not
itself proof of a code defect; obtain the relevant evidence without hiding real blockers.

Bind conclusions to the exact head and material graph inputs. New evidence that changes an
acceptance/risk judgment requires only the affected reassessment; unchanged facts or record
formatting do not restart review. Preserve root-cause/prevention lessons and dispositions
in the consolidated PR record for later reviewers, using `../../specs/knowledge-records.md`.

## Verify

Reuse trusted builder checks bound to the same head. Run only missing, stale, review-
specific, or independently security-relevant checks. Do not rerun identical deterministic
commands against an unchanged SHA. Use `../../specs/verification.md`; preserve valid
input-bound evidence instead of repeating heavy builds. Review the historical constraints
and rationale supplied by the owner against current code; do not blindly trust old comments
or repeat the entire historical search in every role.

## Select reviewers

Always cover correctness. Add security for executable code or trust boundaries. Add only
specialists justified by actual changed behavior: auth, data/migrations, concurrency,
API/integration, frontend/accessibility, infrastructure/reliability, scraping/browser, or
test quality. File count and domain keywords alone do not add reviewers.

Use medium thinking for documentation/templates/metadata and high for executable,
security, auth, data, concurrency, or cross-file behavior. Thinking level never lowers the
blocking standard.

For remediation, use one correctness/general role and the blocker-producing specialists;
an existing blocker-producing correctness role satisfies general coverage, not an extra
seat. Every new executable-code head also receives security review even when security did
not produce the original blocker. Add another specialist only when remediation changed its
risk surface. Start from prior findings, their dispositions, the remediation delta, and
regression evidence; keep the full current diff and relevant callers available for fresh
review. Do not blindly relaunch the previous panel.

## Run one panel

Prepare the full diff once and deterministic role bundles. Embed the relevant diff in each
task or give the delegate one stable readable file path; never use `runs.host` to transfer
it. Launch all selected roles as fresh ordinary `delegate` agents with full normal tool
availability through the adapter's single `runs.all` workflow. Prompts assign review focus
without creating specialized agent profiles or capability ceilings. Each task carries the
acceptance invariants, relevant historical constraints/source links, test evidence/scope,
and bounded ordinary diff/context (start with
normal diff context, then read relevant callers). Correctness must check whether tests
exercise the claimed behavior and catch the original defect; source-string assertions do
not establish runtime correctness. Reproduce disputed blockers when safely feasible and
resolve conflicting severity claims against the production-impact standard before assigning
remediation. If a role runs longer than three minutes, its task asks for at most one
`contact_supervisor` progress update naming the role, head, and current evidence step; this
is runtime visibility, never a GitHub artifact. Join every role and retain valid same-head
roles. If one role is missing or invalid, launch one additional workflow containing only that role; never restart the whole panel.

Bind repository, PR, head/base, attempt, and role from the launch key and task rather than
requiring the delegate to echo them perfectly. Accept JSON or clearly structured Markdown
when it contains a verdict, substantive summary, verified `path:line` behaviors, residual
risks, and findings. A blocker identifies a reachable trigger, the patch-caused causal
chain, existing mitigations checked, and concrete production impact. Preserve a supported
root-cause/prevention lesson in that same finding, not a new knowledge-only issue; speculation or
independent pre-existing debt is not a blocker. Normalize harmless key casing, number/string, and list-shape differences in the
owning agent. Retry only when the child failed or no substantive review can be recovered;
formatting variance alone never restarts a role or panel. Blocking findings still require
the confirmed HIGH/CRITICAL production-incident standard.

After complete validation, the owner publishes one SHA-bound `FORGE:REVIEW-PANEL` comment
with the knowledge-records metadata envelope and visible graph-input links. Include each
role's summary, relevant decisions considered, finding dispositions, acceptance/test evidence,
verified behaviors and residual risks, then one official review verdict. Read
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
most one valuable independent follow-up issue per causal concern when separate action is
needed and authorized. Advisories and reusable lessons remain in the consolidated report
by default; do not expand the backlog merely to make knowledge searchable.

Merge only when explicitly authorized, the current head equals the accepted reviewed head
or a proven equivalent patch, required checks pass, the PR is mergeable, and no blocker
remains. Review never closes the linked issue or cleans its worktree.

Use the staging review strategy only for an explicit integration-to-protected deployment
or bundle review. An ordinary issue PR targeting the configured integration branch keeps
this standard approving review even when that integration branch is also the repository
default. Staging review remains a non-merging deployment gate.
