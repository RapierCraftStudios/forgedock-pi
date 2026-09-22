<!-- FORGE:REVIEWER_REPORT {"v":1,"kind":"REVIEW","repository":"example/product","pullRequest":7,"head":"4eae364aee63e3bab1244fb6992b563f0af9af7a","baseSha":"e3fc7e99e5f8165b2996ad304a29e4a7d56fa6ac","role":"correctness","reportId":"c2ca5e34-84c9-48e1-9f61-8f42f7ff3138","baseRef":"main"} -->
<!-- FORGE:REVIEW_OBSERVATIONS [{"id":"correctness:F1","kind":"code-defect","summary":"restore drops the input marker","affectedBehavior":"Restored objects no longer preserve the marker field, although payload remains present.","location":"src/restore.mjs:1","evidence":["Frozen diff changes `return { marker: input.marker, payload: input.payload };` to `return { payload: input.payload };`.","For an input such as `{ marker: 'm', payload: 'p' }`, the frozen implementation returns `{ payload: 'p' }`, so `marker` is absent."],"trigger":"Call `restore` with any input containing a marker.","consequence":"Consumers lose the marker during restoration, violating the required marker-and-payload preservation contract.","whyThisChange":"The marker omission is the functional source change in this patch.","stage":"pre-merge correctness review","proposedDisposition":"IMMEDIATE REPAIR"}] -->
## ForgeDock review

**Reviewer role**: `correctness`
**Pull request**: #7
**Reviewed source**: `4eae364aee63e3bab1244fb6992b563f0af9af7a`
**Review base**: `main` at `e3fc7e99e5f8165b2996ad304a29e4a7d56fa6ac`

### Structured findings

- **correctness:F1** (code-defect) restore drops the input marker — evidence: Frozen diff changes `return { marker: input.marker, payload: input.payload };` to `return { payload: input.payload };`.; For an input such as `{ marker: 'm', payload: 'p' }`, the frozen implementation returns `{ payload: 'p' }`, so `marker` is absent.; proposed: IMMEDIATE REPAIR; stage: pre-merge correctness review

## Scope and decisions considered
Reviewed the frozen patch at the specified head against main, focusing on `src/restore.mjs` and the relevant migration-shadow workflow/detector. The conditional shadow job is correctly not treated as an execution prerequisite here: the workflow detector reports `migrations=false`, and the observed result records the job as intentionally skipped under policy.

## Evidence and findings
- **correctness:F1 — code defect:** `src/restore.mjs` changes `restore(input)` from returning `{ marker: input.marker, payload: input.payload }` to `{ payload: input.payload }`. For any input carrying a marker, the restored result therefore drops that marker while preserving only the payload. This violates the required restore contract to preserve both input marker and payload and is directly introduced by this patch. **Immediate repair is required.**

## Verification limitations
No executable test command is configured or present in the reviewed fixture. The workflow is conditionally skipped rather than executed because `.github/workflows/migration-shadow-dryrun.yml` detects no `infra/migrations/` changes (`docs/evidence/detector-result.md`: `migrations=false`); policy evidence accepts that skip and no separate migration-shadow execution obligation applies.

## Recommendation
BLOCK until `restore` preserves `input.marker` as well as `input.payload` (and the behavior is verified).
