---
description: Review one frozen pull request with a fresh evidence panel and guarded verdict
argument-hint: "[PR number or URL] [--auto-merge --issue N]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ForgeDock Pull Request Review

This is the Pi-native review contract loaded by `forgedock-review-pr`. It is behavioral
specification, not a second runtime. The visible owner selects the panel, joins its results,
adjudicates findings, publishes the consolidated record, and retains merge/closure authority.

## Route and freeze

- If the PR is an explicit integration-to-protected deployment or bundle review, load
  `Skill("review-pr-staging", ...)` and stop this route. An ordinary issue PR targeting the
  configured integration branch remains a standard review.
- Resolve the configured repository, active identity, merge authority, linked issue, PR state,
  base/head SHAs, merge base, changed files, checks, and relevant existing exact-head records
  once. Use the exact frozen head/base in every reviewer task and publication.
- A target branch advance alone does not invalidate an unchanged clean, mergeable reviewed head.
  Reconcile only for a real conflict or required-up-to-date policy. If the effective patch or
  risk changes, rerun affected verification and a fresh review; do not create a starvation loop.

## Context-aware independent review

The owner gives each fresh reviewer the original acceptance criteria, accepted Builder Contract,
active execution path, relevant prior decisions and non-goals, exact head/base identity, frozen
diff, verification evidence, and known limitations. History is evidence, not immunity: a reviewer
challenging a deliberate decision names that decision and supplies new current evidence. A reviewer
must not reinvent the architecture from unfamiliarity or treat a missing rationale as a defect.

Review the diff first, then the relevant callers and producer/consumer boundaries. For each
changed protocol, state, external call, or persisted boundary, check the applicable valid/invalid
inputs, fresh/existing state, failure/retry/recovery, cancellation, concurrency, serialization,
and namespace/type obligations. A source-string assertion, green aggregate row, or historical
approval is not runtime proof. Missing required evidence remains an explicit gate.

## Panel

The owner selects correctness for every panel, security for executable or trust-boundary changes,
and only specialists justified by the actual risk surface. Remediation keeps one correctness/general
role, the specialists that produced or are affected by the blocker, and security for executable
changes. Thinking settings are configured policy; they never lower the blocking standard.

Launch all selected roles as fresh ordinary generic `delegate` agents in one joined workflow per
panel attempt. Pass the frozen diff/context and evidence requirements. Delegates return structured
results with a substantive summary, verified `path:line` behaviors, residual limits, and findings.
A finding includes its trigger, reachable path, violated acceptance/invariant, consequence,
confidence/severity, scope and causality, and the reviewer's block rationale. Delegates are
read-only reviewers: they do not edit source, post PR comments, create issues, edit labels, merge,
or request a publication capability that they were not given.

The owner joins every required result before synthesis. Retain valid same-head roles and retry
only a missing, failed, or malformed role. Harmless JSON/list/identity formatting differences do
not restart a role. A partial panel cannot produce a verdict. The final publication model is one
owner-authored, SHA-bound `FORGE:REVIEW-PANEL` record plus one official verdict; there are no
per-reviewer comments on this route.

## Parent disposition

Deduplicate findings by causal mechanism and affected behavioral boundary. Corroborating reviewers
are evidence for one concern, not multiple defects. For every substantive concern, preserve the
source reviewer(s), exact location, evidence, decision considered, and parent rationale. Use these
dispositions:

- **IMMEDIATE REPAIR** — current evidence demonstrates that the change misses an original
  acceptance criterion (regardless of severity), introduces or materially worsens a reachable
  consequential regression, or introduces a confirmed material security, safety, or data-integrity
  failure. A pre-existing behavior newly made reachable by the patch is patch-caused when the
  causal path is shown.
- **NON-BLOCKING FOLLOW-UP** — a confirmed, actionable, independently valuable defect or
  hardening item that policy permits to follow later. Deduplicate it and create at most one issue
  under existing authorization. It does not enter the current batch or hold an otherwise acceptable
  PR hostage.
- **REJECTED/NOT APPLICABLE** — disproven, stale, unsupported, stylistic, or unrelated concern;
  retain the reason and create no speculative issue.
- **EVIDENCE/AUTHORITY PREREQUISITE** — required proof, permission, or environment is unavailable;
  preserve the exact missing capability and wake condition. Do not send it through repeated code
  remediation.

A disposition is not valid without concise evidence of the trigger, reachable path or loaded
specification, violated original acceptance/invariant, consequence, and patch causality or an
explicit acceptance gap. Severity, domain risk, reviewer confidence, and whether the PR must
change are separate axes. Mechanical stale identity, incomplete panel, required-check, conflict,
mergeability, and authority failures remain real gates but are not semantic code findings.

For an immediate-repair finding, the parent records one bounded classification before editing:
`IMPLEMENTATION_DEFECT` when the admitted contract is complete but the patch violates it;
`VERIFICATION_GAP` when required proof is missing, stale, or contradicted; or `CONTRACT_GAP`
when a reachable caller, invocation mode, transitive dependency, state/input transition,
failure/retry/recovery path, cancellation, concurrency interleaving, or outcome was omitted
from the admitted contract/proof map. A `CONTRACT_GAP` preserves the current head/worktree and
enters exactly one bounded `REPLAN_REQUIRED` transition. The parent supersedes the relevant
contract/plan, makes one cohesive repair, runs affected verification, and then requires a fresh
exact-head review of the new head before merge. It never reviews the known-broken head as a
pre-edit remediation step, silently becomes a blocker issue, or resets the remediation cap.

## Verdict and merge handoff

- Any parent-dispositioned `IMMEDIATE REPAIR` yields `CHANGES_REQUESTED` and keeps the blocker on
  the current PR/source issue for one cohesive remediation round. Never create a recursive blocker
  issue.
- No immediate repair and one or more authorized follow-ups yields `APPROVE_WITH_FOLLOW_UP`.
- No immediate repair or follow-up yields `APPROVE`.
- An incomplete panel, stale review identity, missing required proof, or unresolved authority
  prerequisite yields `review-degraded`/`GATED` with the exact wake condition and no verdict that
  implies merge readiness.

The owner publishes the consolidated panel with the original acceptance, active path, decisions,
proof, finding dispositions, follow-up links, residual risks, exact head/base, and official verdict.
Read back the exact record identity. Merge only when explicitly authorized, the reviewed head (or
proven equivalent patch) is current, required checks pass, the PR is clean/mergeable, and no
immediate repair remains. Review never closes the issue or removes a worktree.

Use `Skill("issue", ...)` only for parent-dispositioned follow-ups that are novel,
actionable, deduplicated, and authorized. Preserve rejected and advisory context in the panel;
do not manufacture backlog for knowledge alone.
