---
description: Fix current-head blocking review findings cohesively and run scoped re-review
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Work On: Remediate

Run only when the current reviewed head has parent-dispositioned, confirmed patch-caused
blocking findings that are fixable inside the investigation scope. The same issue-specific
work-on parent remains the sole semantic authority and writer for the remediation round. The
same work-on agent remains the sole writer; reviewer children never edit source.

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

A stale, advisory, possible, pre-existing, out-of-scope, or unrelated finding does not enter
remediation. Keep only independently valuable parent-dispositioned follow-ups as non-blocking
follow-ups; do not create blocker issues.

## Finding classification before edits

The parent must classify every confirmed blocker with evidence before selecting a mutation:

| Classification | Evidence | Route |
| --- | --- | --- |
| `IMPLEMENTATION_DEFECT` | The admitted contract and closure row are complete, but the current patch violates the required behavior. | Ordinary bounded cohesive remediation. |
| `VERIFICATION_GAP` | The contract is complete, but the required test, check, or capability evidence is missing, stale, or contradicted. | Ordinary bounded verification remediation; required unavailable proof gates. |
| `CONTRACT_GAP` | The finding demonstrates an omitted reachable caller, invocation mode, transitive dependency, state/input transition, failure/retry/recovery path, cancellation, concurrency interleaving, or outcome from the admitted contract/proof map. | Preserve the current work and enter exactly one `REPLAN_REQUIRED` transition before any edit. |

A reviewer suggestion is not enough: the parent records the exact finding, reviewed head,
contract digest, omitted row or missing capability, causal evidence, and disposition. A
contract gap is never silently downgraded to `IMPLEMENTATION_DEFECT`, escalated as
`needs-human`, or moved to an independent issue merely because the current round is near
its cap. Advisory, pre-existing, out-of-scope, and unrelated findings remain outside this
route.

## Scope reassessment

Before another edit, reassess cohesion if review reveals distinct omitted outcomes, phased
requirements or repeated cross-boundary non-convergence. Scope reassessment may propose
decomposition under `investigate.md`/`decompose.md`; it does not reset the budget. Preserve
partial work and require an approved handoff for an existing PR. If the work remains atomic,
continue only its authorized round/remaining budget. Do not split merely to evade the cap.

A reviewer-discovered caller, invocation mode, transitive dependency, input/state transition,
failure/retry/recovery, cancellation, or concurrency row is `CONTRACT_GAP`. Before any fix,
append a superseding contract and re-plan the complete closure matrix; never patch the reported
line while the omitted row remains unadmitted.

### Bounded `CONTRACT_GAP` → `REPLAN_REQUIRED`

The parent performs this transition once, with the existing issue/PR and writer lease:

1. Freeze and record the exact reviewed PR head/base, worktree/branch, reviewer comments and
   result IDs, current contract digest, and original remediation usage. The partial work is
   preserved; a target-branch move alone does not create a new round.
2. Admit one lane-scoped `REPLAN_REQUIRED` token only if the configured cap and prior token
   usage permit it. Persist the token with issue/run, reviewed head, blocker ID, old digest,
   and an allowance bound. A resume, renamed round, new receipt, or retry cannot mint a
   second token or increase the cap.
3. Run the superseding investigation and architecture pass against that exact reviewed head.
   Expand the closure matrix for the omitted row and every reachable sibling, retain all
   original criterion IDs, and publish a new contract with a new digest before editing.
4. Treat the old approval as stale. The revised contract requires one cohesive fix and a
   fresh complete exact-head panel; old reviewer evidence is context and cannot authorize
   merge. The re-plan itself does not count as a code-remediation round, but the subsequent
   fix plus re-review does.
5. If the token is unavailable, the cap is exhausted, or identity/authority is incomplete,
   publish `FORGE:GATED` naming the exact wake condition and preserved head/worktree. Do not
   close the issue, create a blocker issue, or block unrelated lanes.

A completed re-plan cannot loop back into another re-plan for the same issue/run. Only
explicit new authority can supply a new allowance; it must be recorded as a superseding
policy input rather than inferred from a resume.

## Cohesive fix

1. Reproduce or verify every blocker against the current head, recording trigger,
   expected, observed, and fail-before/pass-after evidence (or a justified inspection-only
   exception carried from investigation).
2. Do not fix only the reported line. Identify the required behavior behind the blocker,
   check its related paths once, and include every reachable occurrence in the same
   remediation. If Behavior Coverage was incomplete, append a superseding scope record
   before editing; preserve the prior decision.
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
   when new required scope is proven. A closure-gap revision is required before that edit.
7. Run affected verification once, inspect the final diff, commit, and push one new head.

Do not create blocker issues, closure matrices, progress comments, checkpoints, Gists,
dossiers, or speculative provider-recovery paperwork.

## Completed remediation receipt

Publish at most one receipt for the new head:

```markdown
<!-- FORGE:REMEDIATION -->
<!-- FORGE:RECORD {"v":1,"source_head":"<new implementation commit>","inputs":["<prior review permalink>","<current plan/contract permalink>"],"supersedes":null} -->
## Remediation Complete

**Prior reviewed head**: `<full SHA>`
**New head**: `<full SHA>`
**Remediation round**: `<used>/<configured limit>`
**Inputs / Supersedes**: <actual links matching metadata, or none>

### Blockers addressed
- `<finding>` — <fix and regression evidence>

### Verification
- PASS — <affected checks>
```

## Scoped fresh re-review

Invoke the same parent-owned review route with the new exact head. Use one correctness/general role
(count an existing blocker-producing correctness role), the blocker-producing specialists, and
security for executable changes. Every fresh reviewer must publish its own bound comment.
Provide prior findings, parent dispositions, remediated hunks, and executable regression evidence;
keep the full current diff available. Add another specialist only when remediation materially
changed that specialist's risk surface.

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
- Remaining in-scope `CONTRACT_GAP` after the bounded re-plan: read-only reassessment, then
  GATED with the preserved identity and exact wake condition; no automatic extra re-plan.
- Remaining blocker after the last authorized re-review: read-only reassessment, then GATED;
  no automatic extra round. A new name, head, resume, or receipt cannot reset usage.
- Explicit prerequisite: `GATED` with wake condition.
- Genuine external authority: `needs-human` with the exact decision required.
- Mechanical/provider interruption: preserve current work and valid reviewer roles for
  resume; do not create a competing writer.
