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
- Child scopes do not overlap. If they must change the same invariant together, keep one
  issue instead of decomposing.
- No equivalent open issue already exists.

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
7. Publish one parent receipt listing created/reused children and dependency edges.
8. Add `workflow:decomposed`, remove active workflow labels, close the parent, and read
   back the terminal state.

Do not create Gists, indexes, planning dossiers, checkpoints, cost estimates, heartbeats,
or child orchestration runs. The outer orchestrator may enroll the created issues later.

## Receipt

```markdown
<!-- FORGE:DECOMPOSED -->
## Decomposition Complete

| Child | Scope | Depends on |
| --- | --- | --- |
| #N | <cohesive behavior> | — |

**Parent result**: DECOMPOSED
```

Return the parent issue, created/reused children, explicit edges, and read-back terminal
state.
