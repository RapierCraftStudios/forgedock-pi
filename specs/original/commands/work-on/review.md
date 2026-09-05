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

1. Reuse the retained build head, target, changed files, and verification evidence.
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
- exact-head evidence and comment readback;
- finding classification and official verdict.

Each reviewer task carries acceptance invariants, test evidence/scope, bounded ordinary
diff/context, and unique role ownership. A blocker must be confirmed patch-caused and
reachable in the supplied patch. A valid same-head reviewer role is retained. Retry only a missing, failed, or malformed
role; never restart a valid role or complete panel for publication uncertainty that an
exact-ID readback can resolve.

## Result routing

- `APPROVE`, no blockers: continue to merge checks.
- Confirmed patch-caused HIGH/CRITICAL blocker: continue to one cohesive remediation pass.
- Explicit unresolved prerequisite: return `GATED` with exact wake condition.
- Incomplete panel/provider failure: preserve valid roles, record `review-degraded`, and
  resume only missing roles.
- Independent pre-existing/advisory finding: include as residual risk or one valuable
  follow-up; do not block the active PR.

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
