## Problem

The work-on coordinator can transition from investigation directly into implementation without loading the authoritative build-phase specifications. In the issue #317 canary, it began editing before reading `work-on/build.md`, never loaded the context, architect, implement, validate, or quality-gate specifications, and manually published build/acceptance completion. This caused a preventable remediation cycle after review found missing active-path wiring and lifecycle coverage.

## Root Cause

The current Pi topology assigns investigation, building, and lifecycle coordination to one long-lived writer context. The compact work-on contract tells that coordinator to load the current phase specification, but there is no focused build handoff: after publishing `FORGE:INVESTIGATOR` and `FORGE:CONTRACT`, the same context can improvise implementation from the issue and repository reads. `specs/original/commands/work-on/build/implement.md` also permits an absent architect artifact as an implicit skip, while investigation acceptance compilation does not mechanically preserve one check per issue criterion or require E2E checks to execute the active production seam.

## Affected Files

Candidate investigation starting points (not mutation authority):

1. `agents/forgedock-work-on-coordinator.md` — narrow the coordinator to pre-build orchestration, one fresh builder handoff, review, merge, and closure.
2. `agents/forgedock-builder.md` — add one fresh-context, mutation-capable package agent that uses the existing issue worktree and executes the authoritative build specifications without spawning writers or reviewers.
3. `skills/forgedock-work-on/SKILL.md` — define the GitHub-backed handoff, one-writer ownership, validated build-result read-back, and restart behavior.
4. `specs/pi-adapter.md` — map the build phase to the fresh builder while retaining direct prompt/spec execution and no hidden workflow state.
5. `specs/original/commands/work-on/investigate.md` — preserve acceptance-criterion cardinality, ordinal, and behavioral test type.
6. `specs/original/commands/work-on/build.md` — require the build spec and architecture/acceptance prerequisites before mutation and completion.
7. `specs/original/commands/work-on/build/implement.md` — reject a missing architect artifact unless an explicit completed skip marker exists, and enforce contract path coverage before staging.
8. `specs/original/SHA256SUMS` — update checksums for original-spec changes.
9. `test/smoke/package-launch-contract.test.ts` and `test/smoke/spec-package.test.ts` — prove agent packaging, topology, phase loading, handoff authority, scope checks, and acceptance fidelity.

## Expected Behavior

After investigation publishes the durable Builder Contract and affected-file claim, the work-on coordinator launches exactly one fresh `forgedock-builder` in the same already-isolated issue worktree. The builder reads the issue, completed investigation, latest contract/claim/base from GitHub, loads `work-on/build.md` before mutation, executes the required context/architecture/implementation/validation specifications inline, and returns a validated commit identity. The coordinator performs exact read-back before push/PR/review. Review remains a separate fresh read-only sibling panel. No workflow engine, extra worktree, scoring system, admission gate, or hidden lifecycle state is introduced.

## Acceptance Criteria

- [ ] A packaged `forgedock-builder` agent runs with fresh context, mutation tools, no nested subagents, and the coordinator's existing issue worktree rather than another worktree. [type:e2e]
- [ ] The coordinator launches exactly one builder only after completed investigation, Builder Contract, claim, and frozen base evidence, then waits without mutating the worktree concurrently. [type:e2e]
- [ ] The builder must load `work-on/build.md` before its first edit and must execute the required architect, implement, validate, and quality-gate specifications; missing required phase evidence is automated GATED rather than an implicit skip. [type:e2e]
- [ ] The builder rehydrates its primary context from the exact GitHub issue, latest completed investigation, latest contract/claim/base, and named repository files instead of inheriting the coordinator transcript. [type:integration]
- [ ] Investigation emits exactly one acceptance check per issue acceptance criterion with matching ordinals; an `[type:e2e]` criterion requires a command/behavior check through the active production seam, not prose matching, a leaf-helper import, or a broad suite alone. [type:unit]
- [ ] Before staging, actual changed paths are covered by the latest Builder Contract and claim; newly required paths force a durable revision before mutation. [type:e2e]
- [ ] Only validated build completion can produce `FORGE:BUILDER:COMPLETE`; the coordinator cannot substitute manually authored completion or acceptance markers for the build/validate sequence. [type:e2e]
- [ ] The builder returns exact commit SHA, changed files, tests, and validation evidence; the coordinator independently verifies clean status, scope, ancestry, and commit identity before PR creation. [type:e2e]
- [ ] Existing bounded orchestration concurrency, frozen-base initialization, non-force push, exact-head review, remediation cap, staging targeting, closure, and cleanup tests remain green. [type:unit]
- [ ] A fresh post-install orchestration canary reaches durable issue closure with no remediation; monitoring aborts the lane immediately if implementation mutation begins without the required build-spec and architect evidence. [type:e2e]

### Evidence

The exact #317 transcript shows the first edit at 23:25:20Z, the first partial read of `build.md` at 23:30:52Z, and no reads of `build/context.md`, `build/architect.md`, `build/implement.md`, `build/validate.md`, or `quality-gate.md` before PR head `911b488c`. Independent audits are stored in the originating Pi session artifacts.

### Non-goals

Do not add a workflow runtime, builder scoring, issue admission, another Git worktree, recursive writer fanout, or additional review round. The builder and reviewer agents are sequential siblings under the existing coordinator.

<!-- FORGE:BODY-INTEGRITY:fresh-builder_355_872855 -->
