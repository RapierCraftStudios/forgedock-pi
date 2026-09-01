## Problem

The #318 production-seam canary reached a real production implementation, but first-head review found two HIGH provider-transaction defects: fallback classification covered non-APPROVE operations, and actor-equals-owner was incorrectly required before ordinary APPROVE publication. A third readback completeness gap was also found. These scenarios were not required before implementation even though equivalent authority/order/readback discipline already exists for remediation.

## Root Cause

Initial investigation, Builder Contract, and architecture require production seam ownership but do not require a bounded transaction proof for irreversible provider actions. The builder can therefore wire the correct production files without explicitly binding authority, failure handling, result/readback, and recovery to each actual provider operation. Remediation has equivalent proof, but it is absent from the first build where it would prevent remediation.

## Affected Files

Candidate investigation starting points (not mutation authority):

1. `specs/original/commands/work-on/investigate.md` — require a provider transaction matrix whenever expected behavior performs an external mutation or irreversible side effect.
2. `specs/original/commands/work-on/build.md` — carry the matrix into the Builder Contract and block incomplete operation/fallback/readback scenarios.
3. `specs/original/commands/work-on/build/architect.md` — close authority, operation-bound failure classification, result binding, idempotency, and recovery before architecture completion.
4. `specs/original/commands/work-on/build/implement.md` — require failing-before/passing-after tests for every transaction row before source mutation/staging.
5. `agents/forgedock-builder.md` and `skills/forgedock-work-on/SKILL.md` — expose the same provider-side-effect precondition in compact Pi contracts.
6. `specs/original/SHA256SUMS` and `test/smoke/spec-package.test.ts` — preserve packaged integrity and regressions.

## Expected Behavior

When a build adds or changes an external provider mutation, investigation and architecture produce one bounded proof row per actual mutation or fallback. Each row names authority/preconditions, exact call and failure scope, required result/readback, replay/recovery, and a deterministic transaction-specific test. Implementation cannot start until the proof is closed. A fallback is authorized only by failure of its named operation.

## Acceptance Criteria

- [ ] Provider/irreversible side-effect work automatically requires a bounded transaction proof before mutation. [type:e2e]
- [ ] Each actual provider mutation or fallback has one substantive row naming authority, exact call/failure scope, required result/readback, replay/recovery, and a deterministic test. [type:e2e]
- [ ] A fallback is authorized only by failure of its named operation. [type:e2e]
- [ ] Provider success and durable receipt/replay behavior are explicit. [type:e2e]
- [ ] Placeholder or open proof rows cannot authorize implementation or resume. [type:unit]
- [ ] Tests are derived from the current transaction rather than a hardcoded global scenario list. [type:unit]
- [ ] Non-provider builds incur no additional proof ceremony. [type:unit]

<!-- FORGE:BODY-INTEGRITY:provider-matrix_380_872855 -->
