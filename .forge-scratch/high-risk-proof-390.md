## Problem

The #318 canary reached the correct production seam and provider transaction, but first-head review found two HIGH regressions despite green tests: merge-base was silently replaced by base SHA, and applying findings deleted durable reviewer receipts. Architecture named exact identity and replay safety as HIGH risks, but build completion did not require discriminating tests for those risks.

## Root Cause

The architect emits consistency checks and HIGH risk mitigations, but the builder is not required to map each HIGH risk to a concrete failure scenario and executable regression. Tests can therefore use degenerate identity values where fields are equal, or skip intermediate durable-state transitions that clear evidence, while still appearing to cover the feature.

## Affected Files

Candidate investigation starting points (not mutation authority):

1. `specs/original/commands/work-on/build.md` — carry HIGH-risk verification closure in the Builder Contract/build gate.
2. `specs/original/commands/work-on/build/architect.md` — require failure scenario, discriminating inputs/full transition sequence, and named test for every HIGH risk.
3. `specs/original/commands/work-on/build/implement.md` — require failing-before/passing-after execution for each HIGH-risk verification row before staging.
4. `agents/forgedock-builder.md` and `skills/forgedock-work-on/SKILL.md` — expose the same conditional requirement in compact Pi contracts.
5. `specs/original/SHA256SUMS` and `test/smoke/spec-package.test.ts` — preserve packaged integrity and regression coverage.

## Expected Behavior

For non-trivial work, every architecture risk rated HIGH has a bounded verification row: concrete failure scenario, distinguishing inputs or complete state transition sequence, named test, and before/after result. Identity fields that must not be conflated use different sentinel values. Durable-state changes exercise every relevant transition that writes, clears, or replays the evidence. Implementation and validation cannot complete until each HIGH-risk row passes. Work without HIGH risks has no additional ceremony.

## Acceptance Criteria

- [ ] Every HIGH architecture risk maps to one concrete failure scenario and named executable test. [type:e2e]
- [ ] Identity-bound tests use distinct values for fields that must not be conflated. [type:unit]
- [ ] Durable-state tests exercise the full relevant write/apply/clear/replay sequence. [type:e2e]
- [ ] Builder records failing-before evidence when safe and passing-after evidence for every HIGH-risk row. [type:unit]
- [ ] Missing or placeholder HIGH-risk verification rows gate implementation before staging. [type:e2e]
- [ ] Builds with no HIGH architecture risks incur no additional verification table. [type:unit]
- [ ] Add the #384 regressions: base differs from merge-base, and reviewer receipts survive findings application. [type:e2e]

<!-- FORGE:BODY-INTEGRITY:high-risk-proof_390_872855 -->
