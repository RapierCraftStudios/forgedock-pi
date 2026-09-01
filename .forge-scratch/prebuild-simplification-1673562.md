## Problem

The last two global work-on hardening rounds duplicated provider and HIGH-risk proof across investigation, Builder Contract, architecture, implementation, and smoke checks. A fresh confirmed issue now spends tens of minutes generating and rereading proof prose before mutation, while the checks still accept syntactically complete tables whose named tests do not cover the real failure scenario.

## Root Cause

1. `specs/original/commands/work-on/investigate.md` requires a full Provider Transaction Proof before build.
2. `specs/original/commands/work-on/build.md` reproduces and validates the same matrix in the coordinator-owned Builder Contract.
3. `skills/forgedock-work-on/SKILL.md` requires provider and HIGH-risk architecture closure before fresh builder launch, moving builder-owned architecture back into the coordinator and serializing duplicate planning.
4. `specs/original/commands/work-on/build/architect.md` adds a second HIGH-Risk Verification table beside Provider Transaction Proof and Risk Assessment.
5. `build.md`, `build/implement.md`, and `test/smoke/spec-package.test.ts` validate row count, markers, placeholders, and wording—not that an exact executable scenario exists, runs, or covers the operation/replay risk.

## Affected Files

Candidate investigation starting points (not mutation authority):

1. `skills/forgedock-work-on/SKILL.md` — restore the coordinator/fresh-builder boundary and remove pre-launch architecture duplication.
2. `agents/forgedock-builder.md` — state one compact builder-owned proof rule.
3. `specs/original/commands/work-on/investigate.md` — retain only side-effect classification and actual operation/fallback discovery.
4. `specs/original/commands/work-on/build.md` — make Builder Contract reference investigation facts instead of reproducing proof matrices; remove syntactic HIGH-risk validators.
5. `specs/original/commands/work-on/build/architect.md` — own one architecture proof surface and one risk table with scenario-specific executable commands.
6. `specs/original/commands/work-on/build/implement.md` — run and report exact architecture commands without row-count ceremony.
7. `test/smoke/spec-package.test.ts` — replace wording/row-count assertions with compact topology and command-evidence contract tests.
8. `specs/original/SHA256SUMS` — update packaged integrity for changed original specifications.

## Expected Behavior

The coordinator verifies current production ownership, classifies whether provider side effects exist, lists actual operations/fallbacks once, freezes scope/base, and launches the fresh builder. The fresh builder alone performs architecture before mutation. Architecture has one non-duplicated provider proof table when needed and one Risk Assessment table; every HIGH risk or provider replay/fallback scenario names an exact executable command. The builder runs those commands and records command plus outcome. No separate HIGH-risk matrix, scoring system, runtime service, or repository-specific scenario vocabulary is added. Confirmed canonical issues skip broad history archaeology once current production-seam evidence agrees with intake.

## Acceptance Criteria

- [ ] Coordinator-owned investigation and Builder Contract do not reproduce a full Provider Transaction Proof; they carry side-effect classification and actual operation/fallback identities once. [type:unit]
- [ ] Fresh builder launches before architecture/proof generation and remains the sole owner of architecture and initial mutation. [type:e2e]
- [ ] Architecture uses one provider proof table only when provider effects exist and one Risk Assessment table; no separate HIGH-Risk Verification table remains. [type:unit]
- [ ] Every provider fallback/replay scenario and every HIGH risk names an exact executable command, and builder completion records that command and its passing result. [type:e2e]
- [ ] Static validation no longer treats row counts, CLOSED markers, regex wording, or non-placeholder prose as behavioral proof. [type:unit]
- [ ] Confirmed canonical issues stop broad history/recall work after current code and production-seam evidence confirm the stated root cause; investigation output is bounded and concise. [type:e2e]
- [ ] The contract is provider- and repository-agnostic: no GitHub-specific operation, fixed row count, issue-specific SHA field, or review-state example is embedded globally. [type:unit]
- [ ] Production-seam ownership, frozen-base identity, fresh builder isolation, exact provider authority/readback/recovery, configured verification, acceptance, and fresh exact-head review remain fail closed. [type:e2e]

<!-- FORGE:BODY-INTEGRITY:prebuild_simplification_1673562 -->
