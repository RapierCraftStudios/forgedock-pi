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
- `/forge:audit [focus]`
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

### ForgeDock bot authentication

Workflow state, issue, and pull-request API traffic requires the ForgeDock GitHub App by default. Place the App private key at `~/.config/forgedock/app.pem` with mode `0600`, or point ForgeDock Pi at another secure location before launching Pi:

```bash
export FORGEDOCK_APP_PEM=/secure/path/to/rapiercraft-forgedock.pem
```

The first-party defaults target App `4051319` and the RapierCraftStudios installation. Other installations must also set `FORGEDOCK_GITHUB_APP_ID` and `FORGEDOCK_GITHUB_INSTALLATION_ID`. A managed installation token can be supplied as `FORGEDOCK_BOT_TOKEN`; it expires and must be rotated externally. Installation tokens are minted in memory, cached until shortly before expiry, and never replace the active `gh` login.

Operator `gh` authentication is retained for interactive setup and `/forge:audit`. Set `FORGEDOCK_ALLOW_OPERATOR_GH=1` only to explicitly opt into legacy workflow writes through that identity.

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

## Commands

| Command | Purpose |
| --- | --- |
| `/forge:about` | Show extension, schema, and `pi-subagents` availability |
| `/forge:init` | Create tracked policy and canonical labels |
| `/forge:work-on <issue>` | Launch one issue through work-on and nested review |
| `/forge:audit [focus]` | Analyze ForgeDock-owned workflow evidence and prepare a sanitized upstream issue |
| `/forge:status` | Show ForgeDock runs linked to the Pi session |

### Reporting workflow defects

Run `/forge:audit` when ForgeDock itself behaves incorrectly in another project. The command performs a read-only analysis, searches for likely upstream duplicates, and prepares a structured report for `RapierCraftStudios/forgedock-pi`. Before submission, an editor shows the exact public title and body and a separate confirmation gate is required. Submission uses the authenticated GitHub CLI identity.

Only sanitized metadata is included by default: ForgeDock, Node.js, and platform versions plus workflow statuses and redacted evidence. Source-repository identity, absolute paths, source code, issue or PR contents, customer data, full logs, and credentials must not be included. Report suspected vulnerabilities through the repository's private GitHub Security Advisory flow instead of `/forge:audit`.

An optional focus narrows the investigation:

```text
/forge:audit merge gate remained blocked after successful checks
```

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
