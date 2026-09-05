# Changelog

## Unreleased — Prompt-router simplification

- Define the first-pass happy path: complete acceptance/prerequisite evidence before edits,
  feasible failing tests first, and criterion-level proof before one concurrent review panel.
- Default to one remediation fallback when unconfigured; preserve explicit limits and count
  reviewed-head fixes across resumes/renamed rounds. Remove the coordinator's conflicting
  instruction to continue fixing beyond the lifecycle cap.
- Report honest request-to-close timing and first-pass outcomes against a sub-30-minute
  target; no deadline can weaken checks or turn a gate/decomposition into code delivery.
- Resolve prerequisite/ownership evidence before batch confirmation and avoid archived
  orchestration routing discovery.

- Require executable local evidence for runtime behavior; source-string/syntax checks
  remain valid for structural contracts, not permission, retry, durability, or recovery proof.
- Remove conflicting extra-general-reviewer instructions and focus re-review on the
  remediation delta while retaining full-diff access and executable-change security review.

- Added concrete bug baselines, regression-proof review, and tested-tree identity checks.
- Made bounded dependency recovery preserve native failed-child metadata, explicitly use
  the configured model on every fresh lane, and distinguish closure from dependency delivery.
- Added opt-in installed Pi workflow-executor checks with controlled child results (not
  live model or production proof); clarified async review ownership and resource preflight.

- Restored explicit phase-label transitions without adding checkpoints or comments.
- Removed the arbitrary per-run reviewer spawn cap; remediation and exact-head re-review
  now use normal session capacity, with healthy panel attention thresholds and bounded
  runtime progress updates.
- Added concise conditional pre-commit checks for persisted-state migration and
  trust/cache/browser/concurrency identity boundaries to improve first-pass quality.
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
