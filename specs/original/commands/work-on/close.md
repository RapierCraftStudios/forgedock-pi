---
description: Close one merged or otherwise terminal issue and release owned state
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Work On: Close

Close exactly once after a verified terminal result. This is a short terminal procedure,
not another analysis phase.

## Snapshot

Fetch issue, linked PR, current labels, relevant ForgeDock receipts, and parent relation
once. Reuse the retained reviewed head, target, merge commit, changed files, verification,
and reviewer results.

## Merged issue

Require:

- PR state is `MERGED`;
- merge commit exists;
- merged PR head equals the accepted reviewed head or retained equivalent-patch review;
- PR base equals the configured target;
- no blocking finding remains.

Then:

1. Update acceptance checkboxes only when retained evidence proves them.
2. Add `workflow:merged` and remove stale active workflow labels.
3. Publish the one terminal receipt below.
4. Explicitly close the issue without an additional comment.
5. Read back closed state, terminal label, PR, merge commit, and receipt.
6. Update an actual parent tracker when configured; otherwise skip it.

## Other terminal routes

- `INVALID`: require investigation evidence, add `workflow:invalid`, close, read back.
- `DECOMPOSED`: require linked child issues and decomposition receipt, add
  `workflow:decomposed`, close, read back.
- `GATED`: do not close; retain the exact prerequisite or recovery condition.
- `needs-human`: do not close; name the exact external authority decision.

## Terminal receipt

```markdown
<!-- FORGE:TRAJECTORY -->
## Work-On Complete

**Result**: MERGED | INVALID | DECOMPOSED
**PR**: #N or none
**Target**: `<branch>`
**Reviewed head**: `<full SHA or none>`
**Merge commit**: `<full SHA or none>`

### Changed Files
- `path`

### Verification and Review
- <checks and reviewer roles>

### Residual Risks
- <limitations or none>
```

Do not create Gists, knowledge indexes, ledgers, dossiers, ADRs, cost priors, calibration
records, decision-record duplicates, checkpoints, heartbeats, or post-merge source commits.

## Cleanup

Cleanup is last.

- An orchestrated child must not remove or unregister its active Pi-managed `$PWD`; return
  cleanup-ready and let Pi own that worktree/branch.
- Standalone work-on may remove only the exact retained owned worktree and branch after
  verifying clean state and successful GitHub readbacks.
- Never enumerate or delete unrelated worktrees, branches, claims boards, or scratch
  state.
- Cleanup failure is reported with the exact owned path; it does not alter a verified
  merge or issue closure.

## Result

Return one compact terminal result: issue, PR, state, target, reviewed head, merge commit,
changed files, checks, reviewers, remediation count, residual risks, and cleanup owner.
