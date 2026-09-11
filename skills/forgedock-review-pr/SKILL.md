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
evidence standard.

For remediation, use one correctness/general role and the blocker-producing specialists;
an existing blocker-producing correctness role satisfies general coverage, not an extra
seat. Every new executable-code head also receives security review even when security did
not produce the original blocker. Add another specialist only when remediation changed its
risk surface. Start from prior findings, their dispositions, the remediation delta, and
regression evidence; keep the full current diff and relevant callers available for fresh
review. Do not blindly relaunch the previous panel.

## Run one panel

The issue-specific work-on parent owns the selected roster and launches every role in fresh
read-only context as ordinary generic `delegate` agents. The task gives each reviewer the
original acceptance, accepted contract, active path, relevant history, frozen head/base,
diff and proof. Reviewers return one structured result to the parent: a substantive summary,
verified `path:line` behaviors, residual limits, and findings with trigger, consequence,
scope/causality, confidence, severity, and block-view rationale. They do not edit source,
post comments, create issues, edit labels, merge, or request a publication capability that
this route does not provide.

The parent waits for the complete result set, validates exact-head identity, deduplicates by
causal mechanism, reconciles disagreement against source and acceptance, and records the
single authoritative disposition for every substantive concern. A disposition requires concise
evidence of the trigger, reachable affected path or loaded specification, violated original
acceptance/invariant, consequence, and patch causality or an explicit acceptance gap. Severity
is separate from the blocking decision; a severity label alone never admits remediation.

The route owner then publishes one SHA-bound `FORGE:REVIEW-PANEL` record containing the panel
evidence, dispositions, follow-up links, and official verdict. This is the only reviewer publication model: no per-reviewer PR comments or second semantic coordinator is required.
If one role is missing or invalid, launch one additional workflow containing only that role;
retry no other role. A partial panel cannot produce a verdict. Use the native helper only for
identity, request preparation, record transport, readback, and mechanical merge/safety checks. Do not use `runs.host` to transfer diffs or invent reviewer
capability ceilings. Formatting variance alone never restarts a valid role.

## Finding admission and decide

Classify each confirmed substantive concern as one of:

- `IMMEDIATE REPAIR`: evidence shows an original acceptance criterion is unmet regardless of
  severity, a reachable consequential regression is patch-caused or newly reachable, or a material security,
  safety, or data-integrity failure is patch-caused. Severity and confidence inform the
  evidence; neither substitutes for it.
- `NON-BLOCKING FOLLOW-UP`: an independently valuable, actionable defect is confirmed but
  policy permits it to be deferred. Deduplicate it and create one valuable independent follow-up
  issue under existing authorization; it does not enter the current batch or hold an otherwise
  acceptable PR.
- `REJECTED/NOT APPLICABLE`: the observation is disproven, unsupported, stale, or unrelated;
  retain the concise reason and create nothing.
- `EVIDENCE/AUTHORITY PREREQUISITE`: required proof, permission, or environment is unavailable;
  preserve the exact wake condition and do not send it through a code-remediation loop.

Mechanical missing-role, stale-identity, required-check, mergeability, and authority failures
remain real gates but are not semantic code findings. The parent must not dismiss a valid
blocker to meet a round target or merge from repeated unsupported claims.

- Any confirmed `IMMEDIATE REPAIR`: `CHANGES_REQUESTED` and one cohesive remediation round.
- No immediate repairs and one or more authorized `NON-BLOCKING FOLLOW-UP` dispositions:
  `APPROVE_WITH_FOLLOW_UP`.
- Rejected, advisory, pre-existing, and out-of-scope context does not block.
- Missing/invalid required role after its bounded retry: `review-degraded`, no verdict.

Only parent-dispositioned follow-ups reach issue creation. Current-issue blockers remain on the
existing PR/source issue and enter the cohesive remediation loop; never create recursive blocker
issues or one issue per duplicate observation.

Merge only when explicitly authorized, the current head equals the accepted reviewed head
or a proven equivalent patch, required checks pass, the PR is mergeable, and no blocker
remains. Review never closes the linked issue or cleans its worktree.

Use the staging review strategy only for an explicit integration-to-protected deployment
or bundle review. An ordinary issue PR targeting the configured integration branch keeps
this standard approving review even when that integration branch is also the repository
default. Staging review remains a non-merging deployment gate.
