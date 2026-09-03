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

Prepare the full diff once and deterministic role bundles. Launch all selected roles as
fresh ordinary `delegate` agents with full normal tool availability through the adapter's
single `runs.all` workflow. Prompts assign review focus without creating specialized agent
profiles or capability ceilings. Join every role and retain valid same-head roles. If one
role is missing or invalid, launch one additional workflow containing only that role;
never restart the whole panel.

Validate each returned JSON result directly:

- exact repository, PR, full head/base, attempt, and role;
- verdict agrees with findings;
- 2–5 sentence summary;
- 2–8 verified `path:line` behaviors;
- residual risks and reviewed files/units;
- blocking findings meet the confirmed HIGH/CRITICAL production-incident standard.

After complete validation, the owning agent publishes one
SHA-bound consolidated panel comment containing every role's summary, verified behaviors,
residual risks, and findings, then one official review verdict. Read back the exact IDs.
No per-role POST/readback choreography, shell-regex grammar, body-integrity tokens, or
review-start/checkpoint comments are required.

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
