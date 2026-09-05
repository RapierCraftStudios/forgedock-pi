---
description: Fix current-head blocking review findings cohesively and run scoped re-review
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Work On: Remediate

Run only when the current reviewed head has confirmed patch-caused blocking findings that
are fixable inside the investigation scope. The same work-on agent remains the sole writer.

## Preconditions

- PR, issue, target, reviewed head, and blocking findings are exact and current.
- Each blocker is CONFIRMED HIGH/CRITICAL with a concrete production scenario.
- The fix does not require product, policy, legal, destructive, credential, or external
  authority.
- Recover used/allowed rounds and any unfinished authorized round from retained work and
  reviewed-head/receipt evidence. Count the next round before its first blocker-driven edit.
  A round includes the cohesive fix plus its complete scoped re-review. Complete or resume
  that round at the limit, including bounded missing-role retries, without charging it twice.
- After the last authorized re-review still finds blockers, the cap allows no further new
  round of edits/panels. Return to investigation once for read-only reassessment, then GATED
  with the unresolved contract and wake condition. Reassessment never resets the budget.

A stale, advisory, possible, low/medium, pre-existing, or unrelated finding does not enter
remediation. Keep valuable independent findings as non-blocking follow-ups.

## Cohesive fix

1. Reproduce or verify every blocker against the current head, recording trigger,
   expected, observed, and fail-before/pass-after evidence (or a justified inspection-only
   exception carried from investigation).
2. Do not fix only the reported line. Identify the required behavior behind the blocker,
   check its related paths once, and include every reachable occurrence in the same
   remediation. If Behavior Coverage was incomplete, update it before editing.
3. Group findings by shared behavior and affected boundary.
4. Plan one cohesive patch covering all reachable occurrences; do not create one head or
   issue per finding. Reinvestigate repeated same-cause gaps together, within the bounded
   remediation cap, rather than applying serial line-level patches.
5. For a repeated cause in executable behavior, establish an executable local fixture before
   patching again when safe local execution is feasible; otherwise retain the justified
   investigation exception and mark that behavior unverified. Exercise the invariant across
   relevant callers, retries, failure paths, and existing state. Add failing-before/passing-after
   evidence where executable. Changing a string assertion to match
   the new implementation is not regression proof.
6. Edit only investigation-authorized paths, expanding the investigation receipt first
   when new required scope is proven.
7. Run affected verification once, inspect the final diff, commit, and push one new head.

Do not create blocker issues, closure matrices, progress comments, checkpoints, Gists,
dossiers, or speculative provider-recovery paperwork.

## Completed remediation receipt

Publish at most one receipt for the new head:

```markdown
<!-- FORGE:REMEDIATION -->
## Remediation Complete

**Prior reviewed head**: `<full SHA>`
**New head**: `<full SHA>`
**Remediation round**: `<used>/<configured limit>`

### Blockers addressed
- `<finding>` — <fix and regression evidence>

### Verification
- PASS — <affected checks>
```

## Scoped fresh re-review

Invoke `forgedock-review-pr` with the new exact head. Use one correctness/general role
(count an existing blocker-producing correctness role), the blocker-producing specialists,
and security for executable changes. Provide prior findings, dispositions, remediated
hunks, and executable regression evidence; keep the full current diff available. Add another
specialist only when remediation materially changed that specialist's risk surface.

Retain valid same-head roles and retry only missing/invalid roles. Re-review passes when no
confirmed patch-caused blocker remains. Non-blocking follow-ups do not trigger another
remediation round.

Base movement follows `work-on/review.md`: an unchanged clean effective patch retains its
review. Never rebase and restart re-review merely because unrelated target commits landed.

## Exit

- Clean exact-head re-review: continue to guarded merge.
- Remaining in-scope blocker with rounds available: one further cohesive pass.
- Unfinished authorized round at the cap: finish/resume its scoped re-review, including
  bounded missing-role retries; do not start another fix after its completed verdict.
- Remaining blocker after the last authorized re-review: read-only reassessment, then GATED;
  no automatic extra round. A new name, head, resume, or receipt cannot reset usage.
- Explicit prerequisite: `GATED` with wake condition.
- Genuine external authority: `needs-human` with the exact decision required.
- Mechanical/provider interruption: preserve current work and valid reviewer roles for
  resume; do not create a competing writer.
