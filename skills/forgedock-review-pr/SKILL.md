---
name: forgedock-review-pr
description: Review one frozen PR with a risk-selected fresh panel, one verdict, and guarded merge.
---

# ForgeDock Review PR

Read the reviewer section of `../../specs/pi-adapter.md` and the authoritative
`../../specs/original/commands/review-pr.md`; the latter defines the active proof-map and
boundary-closure obligations. Resolve `forge.yaml`, active GitHub identity, repository, PR, and merge authorization once. A standalone PR and a
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

The issue-specific work-on parent owns the selected roster and launches every role in fresh
read-only context. Reviewers are allowed one bound PR-comment capability only: after
finalizing their typed result, each reviewer must publish its own exact-head, role/round-bound
comment. That capability cannot edit source, create issues, edit labels, merge, or authorize
merge. The parent waits for every required role, validates the result/comment pair, and retries
only a missing or invalid role.

The parent then collates the raw panel: deduplicate equivalent behavior, preserve source
reviewers, require verified `path:line` behaviors, reconcile disagreement against evidence, and classify each concern as blocking,
advisory, pre-existing, out-of-scope, or follow-up. Every finding carries the reviewer's
block view/rationale and scope view/rationale; the parent disposition is authoritative.

The shared typed `ReviewPrCoordinator` remains the mechanical gate for exact identity, panel
completeness, checks, lease/authority, mergeability, and protected-branch safety. It must not
create work-on finding issues or replace the parent disposition. Standalone/staging routes may
retain their own issue-publication policy and may use fresh ordinary `delegate` agents with full normal tool availability. If one role is missing or invalid, launch one additional workflow containing only that role. The parent must never use `runs.host` to transfer diffs or create new reviewer capability ceilings. formatting variance alone never restarts a role or panel. After disposition, the parent publishes one SHA-bound `FORGE:REVIEW-PANEL` comment containing panel evidence and the official verdict. Blocking
findings still require the confirmed HIGH/CRITICAL production-incident standard.

## Decide

- Any confirmed patch-caused parent disposition of `blocking`: `CHANGES_REQUESTED`.
- No blockers and one or more independently valuable `follow-up` dispositions:
  `APPROVE_WITH_FOLLOW_UP`.
- Advisory, pre-existing, and out-of-scope concerns remain in the consolidated report by
  default and do not block.
- Missing/invalid required role or comment after its bounded retry: `review-degraded`, no verdict.

Only parent-dispositioned follow-ups reach issue creation. Create at most one valuable independent follow-up issue per causal concern. Current-issue blockers remain on the existing
PR/source issue and enter the cohesive remediation loop; never create recursive blocker issues
or one issue per duplicate observation.

Merge only when explicitly authorized, the current head equals the accepted reviewed head
or a proven equivalent patch, required checks pass, the PR is mergeable, and no blocker
remains. Review never closes the linked issue or cleans its worktree.

Use the staging review strategy only for an explicit integration-to-protected deployment
or bundle review. An ordinary issue PR targeting the configured integration branch keeps
this standard approving review even when that integration branch is also the repository
default. Staging review remains a non-merging deployment gate.
