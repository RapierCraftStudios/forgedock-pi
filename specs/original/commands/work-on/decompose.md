---
description: Split one confirmed issue into independently executable child issues
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Work On: Decompose

Run only when the completed investigation has `Verdict: CONFIRMED` and
`Route: DECOMPOSE`. Execute inline; do not launch children or implement source changes.

## Preconditions

- The investigation identifies more than one independently mergeable concern.
- Each child can be stated with its own observable behavior, root cause, mutation scope,
  non-goals, and acceptance checks.
- Slices are independently safe and testable at their target. File overlap is allowed only
  with explicit dependencies that serialize it; an atomic shared invariant stays one issue.
- Every remaining acceptance criterion is mapped to the children; do not delete requirements
  or turn each reviewer finding into an issue.
- Reuse matching open issues; create only genuinely missing independently safe units.

## Existing PR or partial implementation

A scope reassessment may propose DECOMPOSE after build/review. Preserve the PR, exact head,
commits, uncommitted-work evidence and owned worktree; do not close the PR or discard work
as part of deciding. Record the rationale and acceptance-to-slice mapping in the existing
investigation record, linking prior decisions rather than erasing them.

Require an explicitly approved handoff and PR disposition bound to the preserved head and
remaining criteria before executing this split: which work is reused and how the partial
PR is retained/superseded. Revalidate the decision if that head or scope changes. Until that approval, return GATED with the concrete proposal; create no
child issues and close neither parent nor PR. After approval, apply only that disposition
and the procedure below. Never reset remediation usage or claim the split delivered code.

## Procedure

1. Reuse the retained investigation receipt; do not reload unrelated history.
2. Define the smallest cohesive child set and explicit dependencies between children.
3. Search open issues once for duplicates using title, affected paths, and behavior.
4. Create only missing children through `forgedock-issue` with canonical sections:
   Problem, Root Cause, Affected Files, Expected Behavior, Acceptance Criteria, Context,
   and Dependencies.
5. Link each child to the parent and record explicit ordering only when real dependency
   or exact mutation overlap requires it.
6. Update an actual parent project/tracker when configured; otherwise skip it.
7. Publish one parent receipt listing created/reused children, dependencies, acceptance
   coverage, and any approved partial-PR handoff.
8. Add `workflow:decomposed`, remove active workflow labels, close the parent, and read
   back the terminal state.

Do not create Gists, indexes, planning dossiers, checkpoints, cost estimates, heartbeats,
or child orchestration runs. Do not automatically dispatch an unconfirmed child set; the
outer orchestrator may enroll the created issues only under its selector/confirmation rules.

## Receipt

```markdown
<!-- FORGE:DECOMPOSED -->
## Decomposition Complete

| Child | Scope | Depends on |
| --- | --- | --- |
| #N | <cohesive behavior> | — |

**Partial work / PR disposition**: <none, or approved disposition with retained head/links>
**Acceptance coverage**: <remaining parent criteria mapped to created/reused children>
**Parent result**: DECOMPOSED
```

Return the parent issue, created/reused children, explicit edges, and read-back terminal
state.
