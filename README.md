# ForgeDock Pi

**Prompt-routed GitHub issue orchestration for Pi, from issue to reviewed merge and closure.**

[![CI](https://github.com/RapierCraftStudios/forgedock-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/RapierCraftStudios/forgedock-pi/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Pi Package](https://img.shields.io/badge/Pi-package-7c3aed)](https://github.com/earendil-works/pi-mono)

> [!WARNING]
> Keep automatic merge disabled in production until the simplified prompt-routed lifecycle
> and exact-head review path have passed repeated live canaries.

## What it does

```text
/orchestrate
  → one /work-on agent per issue
      → investigate inline
      → contract + implement + verify inline
      → PR
      → context-aware /review-pr
      → bounded remediation + fresh re-review when required
      → merge
      → explicit issue closure + trajectory + cleanup
```

The Pi-native lifecycle specifications are packaged under
[`specs/original/commands`](specs/original/commands); the retained path is compatibility
naming. Pi runtime mechanics live in [`specs/pi-adapter.md`](specs/pi-adapter.md).

## Architecture

- **Skills own behavior.** Slash commands expand native Pi skills and progressively load
  the relevant phase specification.
- **The visible coordinator owns routing.** TypeScript does not choose phases or maintain
  hidden workflow state.
- **GitHub is durable memory.** Issue/PR state and four compact lifecycle receipts determine
  resume position; work-on creates no Gists, checkpoints, heartbeats, or telemetry artifacts.
- **Subagents provide isolation and fan-out.** Orchestrate launches one work-on agent and
  one isolated worktree per ready issue. Each agent runs its lifecycle inline and only
  review or re-review fans out to fresh repository-capable children.
- **Review is load-bearing.** It launches risk-specific prompts on fresh ordinary
  `delegate` agents with full normal tools, publishes one consolidated panel result, and
  never approves from a partial panel or repeats review for unrelated clean base movement.
- **Closure remains explicit.** Review may merge; work-on verifies the merge and closes the
  issue, posts trajectory, and cleans up.

See the repository design document (`DESIGN.md`) for the complete contract.

## Installation

ForgeDock Pi requires Node.js 22+, Pi, Git, GitHub CLI, and `pi-subagents` 0.59+
for child-safe, depth-bounded reviewer fanout.

```bash
pi install npm:pi-subagents
pi install git:github.com/RapierCraftStudios/forgedock-pi
```

For local development:

```bash
pi install /absolute/path/to/forgedock-pi
```

Restart Pi or run `/reload` after installation.

## Configuration

The prompt-routed workflow uses the original `forge.yaml` contract. Start from the
packaged minimal template:

```bash
cp specs/original/templates/forge.yaml.minimal forge.yaml
```

At minimum configure:

```yaml
project:
  name: "My Project"
  owner: "my-org"
  repo: "my-repo"

paths:
  root: "/absolute/path/to/my-repo"
  worktree_base: "/absolute/path/to/my-repo/.forge/worktrees"

branches:
  default: "main"
  staging: "staging"
  feature_pattern: "milestone/{slug}"

agents:
  subagent_model: "provider/full-model-id"

orchestration:
  max_concurrent: 12
```

Add project checks under `verification.commands`. Missing checks must be reported as
skipped; they are never silently represented as passing.

`.forge/config.json` belongs to the retired controller implementation and is not treated
as equivalent to `forge.yaml`.

## Commands

| Command | Purpose |
| --- | --- |
| `/work-on <issue or next>` | Run or resume one complete issue lifecycle |
| `/work-on <PR> --remediate --issue <N>` | Run the bounded remediation/re-review route |
| `/review-pr <PR selector> [flags]` | Context-aware standard review and optional guarded merge |
| `/review-pr-staging <PR or route>` | Strict non-merging deployment/bundle review |
| `/orchestrate <issue set> [--auto or --confirm]` | Dispatch one complete work-on lane per issue |

`/forge:work-on`, `/forge:review-pr`, `/forge:review-pr-staging`, and
`/forge:orchestrate` are lexical compatibility aliases for the same skills.

The underlying native Pi skills remain directly available as:

```text
/skill:forgedock-work-on
/skill:forgedock-review-pr
/skill:forgedock-review-pr-staging
/skill:forgedock-orchestrate
/skill:forgedock-quality-gate
```

## Packaged behavioral authority

The package includes:

- a per-issue work-on agent, packaged under the historical
  `forgedock-work-on-coordinator` profile name and authorized only for mandatory nested
  review fanout;
- generic fresh review delegates rather than a specialized restricted reviewer profile;
- compact Pi-native work-on, orchestration, and review specifications;
- retained supporting commands, personas, configuration templates, and bounded helpers;
- a SHA-256 package-integrity manifest checked by the test suite;
- a Pi runtime adapter for tool, model, worktree, review, and concurrency mechanics.

## Current migration status

The active extension entrypoint now registers only the lexical prompt router. The prior
controller, journal, lease, and child-runtime implementation remains temporarily in the
source tree for migration comparison but is not registered or authoritative.

Required proof before declaring the migration complete:

1. one live ordinary issue completes from investigation through closure;
2. standalone standard and staging review routes complete correctly;
3. two independent orchestrated issues run concurrently;
4. one dependency unblocks and dispatches immediately after predecessor success;
5. interruption resumes from GitHub without private journal recovery.

## Development

```bash
npm install
npm run check
```

The suite validates TypeScript, lexical routing, skill/prompt packaging, specification
integrity, reviewer-only nesting, hard-edge DAG concurrency, and lower-level safety modules.

## Security

Pi extensions and prompt skills execute with the user's operating-system permissions.
Review `SECURITY.md`, `forge.yaml`, and repository protections before
enabling writes or automatic merge.

## License

ForgeDock Pi is licensed under [AGPL-3.0-or-later](LICENSE).
