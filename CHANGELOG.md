# Changelog

## Unreleased — Prompt-routed reset

- Replaced controller-backed workflow command registration with a lexical Pi skill router.
- Added prompt and skill entrypoints for orchestrate, work-on, review-pr, staging review, and quality gate.
- Added a packaged, depth-bounded work-on coordinator agent that can launch the mandatory fresh reviewer panel without enabling recursive issue orchestration.
- Explicitly allowlisted the child-safe `subagent` tool for that coordinator so pi-subagents 0.59 preserves it through the profile's strict tool filter.
- Packaged the original ForgeDock command/helper corpus with a SHA-256 integrity manifest.
- Packaged deterministic helpers referenced by the original specifications: `specs/original/bin/engine/admission.mjs`, `specs/original/bin/engine/resolve.mjs`, `specs/original/bin/engine/orchestrate-canary.mjs`, `specs/original/bin/engine/invariants.mjs`, and `specs/original/bin/labels.json`.
- Restored `forge.yaml` as workflow configuration authority.
- Documented the visible-coordinator, GitHub-state closed-loop architecture.

## 0.1.0 — Experimental

- Initial standalone Pi extension package.
- Added typed run state, event journal, leases, policy, review gate, and DAG primitives.
- Added GitHub state/projection/workflow adapters and isolated Git worktree management.
- Added `pi-subagents` work-on and nested reviewer integration.
- Added canonical ForgeDock issue/PR audit artifacts and workflow labels.
- Added single-issue E2E harness and synthetic live validation receipt.

Known limitations are documented in `README.md`, `DESIGN.md`, and `SECURITY.md`.
