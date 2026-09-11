---
description: Prepare one PR, run exact-head review, and route its result
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Work On: Review

Execute PR preparation and review coordination in the sole work-on agent. At phase entry,
use one label edit to replace `workflow:building` and other stale active-phase labels with
`workflow:in-review`. Do not launch a second review coordinator. Only the risk-selected
fresh reviewer panel may be nested.

## Prepare or reuse the PR

1. Reuse the retained build head, target, changed files, verification and published decision
   chain. Require criterion-to-implementation/test coverage; do not delegate known gaps.
2. Check once for an existing open PR from the owned branch.
3. Create one PR when absent; otherwise update the existing PR body only when required.
4. The PR body states issue, intent, changed behavior, verification, and residual risks.
5. Freeze the full remote head SHA, base ref/SHA, merge base, changed files, and diff once.
6. Verify the live remote head equals the committed build receipt.

Do not post a review-start issue comment, heartbeat, checkpoint, route marker, or duplicate
build summary.

## Run review

Load and execute `forgedock-review-pr` in this work-on agent with exact PR, issue, target,
head, and base arguments. That skill owns:

- risk-derived reviewer selection;
- deterministic diff bundles;
- one concurrent fresh panel;
- complete-panel joining;
- exact-head panel-record evidence and readback;
- finding classification and official verdict.

Each reviewer task carries acceptance invariants, test evidence/scope, bounded diff/context,
linked classification/context/contract/plan and decision revisions, and unique role ownership.
Fresh reviewers validate the history's current applicability rather than review historically blind.
Each reviewer returns one exact-head structured result with a substantive summary, verified
`path:line` behaviors, residual risks, and evidence-backed findings. Generic delegates do not
publish comments, create issues, edit labels, or merge. The parent waits for every required
result, validates identity, retries only a missing, failed, or malformed role, and then publishes
one consolidated SHA-bound panel record and official verdict.

Review consumes the frozen closure matrix criterion by criterion, preserving producer →
consumer identity. Report uncovered caller, invocation-mode, transitive-dependency,
valid/invalid input, fresh/existing state, failure/retry/recovery, cancellation, or
concurrency rows explicitly, and verify each row's concrete counterexample or behavioral test;
report an omitted alternate caller or transitive dependency by name. String-presence checks alone
cannot close runtime rows. A reachable omission is `CONTRACT_GAP`, not an advisory: remediation
must supersede the contract and re-plan before editing. A finding's severity is separate from
its disposition; the parent requires trigger, reachable path, violated acceptance/invariant,
consequence, and patch causality or an explicit acceptance gap.

## Result routing

- `APPROVE`, no blockers: continue to merge checks.
- Confirmed patch-caused parent-dispositioned blocker: consolidate and deduplicate the
  complete panel, then perform scope reassessment and, when warranted, a `DECOMPOSE` proposal
  when the admitted scope is incomplete or non-convergent. Otherwise check remaining remediation budget and perform one cohesive pass.
  At the cap, use the root's `GATED` exit; never launch another panel by calling it final,
  last, or closure.
- Explicit unresolved prerequisite: return `GATED` with exact wake condition.
- Incomplete result roster or provider failure: preserve valid roles, record
  `review-degraded`, and resume only missing required roles.
- Independent follow-up: create only a valuable causal concern that the parent has explicitly
  dispositioned as `follow-up`; advisory, pre-existing, and out-of-scope findings do not block.

## Base movement

The review binds the PR's exact head and effective patch. An unrelated target-branch
advance does not invalidate it when the head is unchanged and GitHub reports the PR clean
and mergeable.

Do not rebase or rerun review solely to make the target an ancestor of the head. Reconcile
only when branch policy requires an up-to-date head or the PR conflicts. If reconciliation
rewrites the head:

1. capture the old effective patch;
2. update from the target without losing the issue change;
3. capture and compare the new effective patch;
4. check whether incoming target changes overlap affected files or behavior;
5. reuse valid review when the patch is identical and no overlap exists;
6. rerun affected verification and fresh review only when behavior or risk changed.

Never allow unrelated target movement to create an unbounded review loop. Target movement
is not a remediation round and does not discard valid role evidence without a material
change.

## Merge handoff

Before merge, require current head, target, checks, mergeability, complete panel, and no
blockers. In the same pre-merge state update, replace `workflow:in-review` with
`workflow:awaiting-merge`; do not add a comment. Return these retained values to the root lifecycle. Review does not independently invoke close or create a second terminal record. Distinguish
merged, tested, and production-proven outcomes; mocked checks or a review verdict are not
production/canary proof.
