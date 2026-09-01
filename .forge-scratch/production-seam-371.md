## Problem

The fresh-builder canary for issue #318 completed investigation, architecture, implementation, validation, and acceptance, but exact-head review proved the requested behavior existed only in a test-local fixture. Investigation and architecture both discovered the real production coordinator/adapter seam yet allowed those files to remain read-only, so the build passed before production behavior was wired.

## Root Cause

The current active-path rules require an execution-path description but do not require every executable owner of the observable behavior to be included in mutation scope. A Builder Contract can name a conceptual path through specifications while an architect lists the actual production caller as merely related/read-only. Test-local helpers are then able to satisfy acceptance commands without exercising the production seam.

## Affected Files

Candidate investigation starting points (not mutation authority):

1. `specs/original/commands/work-on/investigate.md` — require production caller/adapter ownership evidence before acceptance and affected-file scope are finalized.
2. `specs/original/commands/work-on/build.md` — reject contracts whose execution path contains an executable owner outside deliverables.
3. `specs/original/commands/work-on/build/architect.md` — require production behavior owners discovered during caller tracing to enter affected paths or carry concrete proof that no mutation is needed.
4. `specs/original/commands/work-on/build/implement.md` — reject test-only implementations and unresolved production-seam omissions before mutation/staging.
5. `agents/forgedock-builder.md` and `skills/forgedock-work-on/SKILL.md` — expose the same fail-closed active-production-seam rule in the compact Pi contracts.
6. `specs/original/SHA256SUMS` and `test/smoke/spec-package.test.ts` — preserve packaged integrity and regression coverage.

## Expected Behavior

When expected behavior changes a runtime, provider, persistence, API, CLI, or other observable production effect, investigation identifies the concrete production entrypoint, caller, and adapter. Those executable owners must be included in the affected mutation paths unless evidence proves the existing implementation already performs the requested behavior. Architecture must reject a plan that keeps the owning production seam read-only while implementing only prose or a test-local fixture. Build returns to investigation before source mutation.

## Acceptance Criteria

- [ ] Investigation must name the concrete production entrypoint/caller/adapter for every observable behavior and include its executable owner in affected paths unless no-mutation evidence is recorded. [type:e2e]
- [ ] Builder Contracts cannot use a conceptual Markdown/spec path as a substitute for the actual executable production seam. [type:unit]
- [ ] Architecture fails closed when a related production path owns the requested effect but is marked read-only or omitted from deliverables. [type:e2e]
- [ ] Test-local helpers and fixtures cannot satisfy active-path acceptance unless the public production caller invokes the same implementation. [type:e2e]
- [ ] A scope omission returns to investigation before the first source edit rather than entering review or remediation. [type:e2e]
- [ ] Prompt/spec-only projects remain valid when investigation proves the specification itself is the active production execution surface. [type:unit]
- [ ] Add the #318/#369 regression: production `ReviewPrCoordinator` and GitHub adapter were discovered but omitted while a test-local fallback passed. [type:e2e]

<!-- FORGE:BODY-INTEGRITY:production-seam_371_872855 -->
