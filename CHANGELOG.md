# Changelog

## Unreleased

- Added `/forge:audit [focus]` for read-only workflow diagnosis and privacy-gated upstream issue filing from external repositories.
- Added deterministic sanitization, editable public-report previews, fixed upstream routing, and explicit operator confirmation.
- Added direct-run lease heartbeats plus confirmed stale direct-run cancellation/release for crash recovery.
- Added state-wide orchestration child discovery so internal launch sentinels cannot orphan durable children during cancellation or takeover.
- Added per-mutation GitHub authority guards and exact PR head/base-branch/base-SHA revalidation immediately before merge.

## 0.1.0 — Experimental

- Initial standalone Pi extension package.
- Added typed run state, event journal, leases, policy, review gate, and DAG primitives.
- Added GitHub state/projection/workflow adapters and isolated Git worktree management.
- Added `pi-subagents` work-on and nested reviewer integration.
- Added canonical ForgeDock issue/PR audit artifacts and workflow labels.
- Added single-issue E2E harness and synthetic live validation receipt.

Known limitations are documented in `README.md`, `DESIGN.md`, and `SECURITY.md`.
