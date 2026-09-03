# Changelog

## Unreleased — Prompt-router simplification

- Prevented generic-review retries caused by unavailable `runs.host` bundle transfer or
  harmless JSON shape differences; owners now bind identity from launch metadata and
  normalize substantive delegate evidence.
- Restored executable packaging for the affected-file extraction helper.
- Replaced the duplicated 8,902-line work-on corpus with one compact route and six slim
  phase procedures; collapsed context, architecture, implementation, and validation into
  one inline build procedure.
- Removed active Gist/index/ledger/dossier/ADR/cost-prior, heartbeat, checkpoint,
  cache-TTL-fork, alternate-runtime, and duplicate phase-artifact machinery.
- Simplified orchestration to hard dependency edges only: explicit prerequisites, exact
  shared mutation files, migrations, and configured global files. Domain, directory,
  co-change, cost, and low-confidence guesses no longer serialize lanes.
- Expanded affected-file extraction to Markdown lists/tables and plain `path:line` forms.
- Prevented review starvation from unrelated target movement: clean mergeable unchanged
  patches retain valid review; only material effective-diff/risk changes trigger re-review.
- Removed the specialized `forgedock-reviewer` profile and reviewer tool ceilings. Review
  roles now use fresh ordinary `delegate` agents with full normal tools; the owner publishes
  one consolidated panel result and retries only missing/invalid roles.
- Clarified that orchestrate launches one sole-writer work-on agent per ready issue; the
  historical `forgedock-work-on-coordinator` profile name does not add another workflow
  layer.
- Restricted nested subagents inside a work-on lane to the fresh review and re-review
  panels. Investigation, planning, build, quality gates, verification, remediation,
  merge, close, and cleanup now remain inline in the same per-issue agent.
- Restored the three lifecycle commands (orchestrate, work-on, review-pr, plus the
  staging strategy) as thin prompt routers over the packaged original specifications.
- Resynced `specs/original/**` byte-for-byte with the tested upstream ForgeDock command
  corpus and regenerated the SHA-256 manifest.
- Removed the port-layer gate machinery that had accreted over the skills, coordinator
  profile, and Pi adapter: work-on ownership gating of standalone reviews,
  `FORGE:BASE`/`FORGE:BASE_REFRESH` refresh transactions, reviewer receipt/recovery
  contracts, remediation closure matrices, and the separate qualitative-review-protocol
  spec. Mechanical failures remain visible `GATED` evidence per the adapter.
- Dropped the packaged `forgedock-builder` hop; the work-on coordinator executes build
  phases inline from the original phase files, as the tested upstream commands do.
- Slimmed the work-on coordinator profile and reviewer profile to short runtime
  contracts; reviewer deadlines stay runtime plumbing with `stopOnAttention: false`.
- Rewrote the smoke specs to pin the router shape (thin skills, standalone-review
  invocability, manifest integrity, read-only reviewer profiles) instead of gate text.

## Unreleased — Prompt-routed reset

- Replaced controller-backed workflow command registration with a lexical Pi skill router.
- Added prompt and skill entrypoints for orchestrate, work-on, review-pr, staging review, and quality gate.
- Added a packaged, depth-bounded work-on coordinator agent that can launch the mandatory fresh reviewer panel without enabling recursive issue orchestration.
- Explicitly allowlisted the child-safe `subagent` tool for that coordinator so pi-subagents 0.59 preserves it through the profile's strict tool filter.
- Packaged the original ForgeDock command/helper corpus with a SHA-256 integrity manifest.
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
