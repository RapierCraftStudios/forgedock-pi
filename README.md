<div align="center">

# ForgeDock Pi

**Pi-native GitHub issue orchestration with durable state, nested subagent review, and an auditable knowledge graph.**

[![CI](https://github.com/RapierCraftStudios/forgedock-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/RapierCraftStudios/forgedock-pi/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Pi Package](https://img.shields.io/badge/Pi-package-7c3aed)](https://github.com/badlogic/pi-mono)

</div>

> [!WARNING]
> **Experimental development release.** The single-issue pipeline has completed a live synthetic E2E run, but production hardening remains in progress. Start with auto-merge disabled and a non-production integration branch.

ForgeDock Pi is a from-scratch rewrite of ForgeDock's core issue lifecycle for the [Pi coding agent](https://github.com/badlogic/pi-mono). Execution is native to Pi and [`pi-subagents`](https://github.com/nicobailon/pi-subagents); GitHub comments preserve ForgeDock's durable phase-result protocol so every run becomes inspectable institutional memory.

## What it does

```text
Issue
  → investigate
  → contract + context + architecture
  → isolated implementation
  → controlled verification
  → push + PR
  → nested fresh correctness/security review
  → audit-gated integration merge
  → close + cleanup + trajectory
```

- **Typed execution authority:** hash-chained events and snapshots on a dedicated GitHub state branch.
- **Machine-visible memory:** canonical `FORGE:*` comments on issues and PRs.
- **Nested review hierarchy:** one work-on writer launches fresh, read-only reviewer subagents.
- **Fail-closed merge policy:** stale SHAs, failed checks, incomplete reviewers, missing audit artifacts, conflicts, protected branches, and invalid leases block merge.
- **Isolated Git worktrees:** one issue, one branch, one writer.
- **Exact workflow labels:** `investigating → ready-to-build → building → in-review → merged`.
- **Idempotent side effects:** event IDs, idempotency keys, read-back verification, and optimistic non-force state updates.

## Status

### Implemented

- `/forge:init`
- `/forge:work-on <issue>`
- `/forge:status`
- Durable GitHub state journal and repository lease
- Canonical issue phase reports
- PR-before-review ordering
- Nested correctness and security reviewers
- Verification and audit merge gates
- Integration-branch merge, issue closure, branch/worktree cleanup
- Trajectory, card, review summary, and decision record

### Not production-complete

- Multi-issue `/forge:orchestrate`
- Full legacy Forge history recall and relevance ranking
- Live cross-machine takeover validation
- Container/OS sandboxing for repository test execution
- Staging-to-production deployment review

See [`DESIGN.md`](DESIGN.md) for architecture, trust boundaries, validation contracts, and known limitations.

## Installation

ForgeDock Pi requires Node.js 22+, Pi, Git, GitHub CLI, and `pi-subagents`.

```bash
pi install npm:pi-subagents
pi install git:github.com/RapierCraftStudios/forgedock-pi
```

For local development:

```bash
pi install /absolute/path/to/forgedock-pi
```

Restart Pi or run `/reload` after installation.

## Quick start

From a trusted GitHub repository:

```text
/forge:init
```

This creates `.forge/config.json` and reconciles canonical workflow labels. Review and commit that policy before running work.

For an initial production pilot, set:

```json
{
  "branches": {
    "integration": ["staging"],
    "protected": ["main"],
    "autoMergeIntegration": false
  }
}
```

Then run:

```text
/forge:work-on 123
/forge:status
```

### Verification policy

Each approved local verification command may set a repository-relative `cwd` so a monorepo can run a package script without a root wrapper:

```json
{
  "verification": {
    "commands": {
      "test": {
        "argv": ["npm", "test"],
        "cwd": "web",
        "required": true,
        "timeoutMs": 600000
      }
    }
  }
}
```

`/forge:init` selects the root package or one unambiguous nested package only when it defines `scripts.test`. If no package can be selected, it leaves local commands empty for explicit GitHub-CI-only verification. Before a writer starts, ForgeDock checks required command executables, canonical directories, package manifests, and recognized npm scripts using metadata only; it does not run repository code during this preflight.

## Commands

| Command | Purpose |
|---|---|
| `/forge:about` | Show extension, schema, and `pi-subagents` availability |
| `/forge:init` | Create tracked policy and canonical labels |
| `/forge:work-on <issue>` | Launch one issue through work-on and nested review |
| `/forge:status` | Show ForgeDock runs linked to the Pi session |

## GitHub audit trail

Issue artifacts include:

- `FORGE:INVESTIGATOR`
- `FORGE:FAST_PATH`
- `FORGE:CONTRACT`
- `FORGE:CONTEXT`
- `FORGE:ARCHITECT`
- `FORGE:BUILDER`
- `FORGE:ACCEPTANCE_GATE`
- `FORGE:REVIEW_STARTED`
- `FORGE:CHECKPOINT`
- `FORGE:TRAJECTORY`
- `FORGE:CARD`

PR artifacts include:

- `FORGE:REVIEW_ROUTE`
- `FORGE:REVIEW-AGENT:<domain>`
- `REVIEW-FINDINGS`
- `FORGE:REVIEW_SUMMARY`
- `FORGE:DECISION_RECORD`

Missing required current-run artifacts block merge.

## Live E2E receipt

The synthetic acceptance run completed implementation, verification, nested review, integration merge, issue closure, audit projection, and worktree cleanup:

- [Issue #9](https://github.com/RapierCraft/fdpi/issues/9)
- [PR #10](https://github.com/RapierCraft/fdpi/pull/10)

## Development

```bash
npm install
npm run check
```

The check suite runs strict TypeScript validation and unit/integration tests.

To run the disposable GitHub E2E harness:

```bash
node scripts/e2e-rpc.mjs /path/to/sandbox-repo <issue-number>
```

Do not target a production repository with the E2E harness.

## Security

Extensions execute with the user's operating-system permissions. Review [`SECURITY.md`](SECURITY.md) and the repository policy before enabling writes or auto-merge.

## License

ForgeDock Pi is licensed under [AGPL-3.0-or-later](LICENSE).
