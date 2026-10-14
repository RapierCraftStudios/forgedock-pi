# ForgeDock Pi

**ForgeDock's issue-to-merge pipeline inside [Pi](https://github.com/earendil-works/pi-mono), on any model Pi can reach.**

[![CI](https://github.com/RapierCraftStudios/forgedock-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/RapierCraftStudios/forgedock-pi/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

This package adds three commands to Pi:

| Command | Runs | What happens |
| --- | --- | --- |
| `/work-on <issue> [--lane L] [--model M]` | `forgedock run-issue` | One issue end to end: lease, worktree, one builder session (investigation → plan → fix + regression test, posted as stage comments), one read-only reviewer (does it fix the issue? does it regress?), PR, merge, close. |
| `/orchestrate <issue...> [--parallel K] [--lane L] [--model M]` | `forgedock orchestrate` | Many issues at once: K parallel lanes, `**Depends on**: #N` ordering, durable batch state, breaker, host admission governor. `/orchestrate --resume <batch-id>` continues a batch. |
| `/forge-runs` | | Lists the runs started from this Pi session and their log files. |

The lifecycle, its prompts and its GitHub record (labels, stage comments, trajectory) are ForgeDock's core work-on, unchanged. This package only sets `FORGEDOCK_LEAN_RUNTIME=pi`, so every builder and reviewer session is a bare `pi -p` session: no extensions, skills or project-local settings, just the harness, the repo's context files and ForgeDock's prompt.

Runs are detached and log to `~/.forge/pi-runs/`. Closing or reloading Pi does not stop them, and ForgeDock runs are lease-held and resumable, so nothing is orphaned. Progress shows in a widget above the editor; when a run ends, its result is added to the session.

## Install

Requires Node.js 22+, Pi, Git, the GitHub CLI (`gh auth login`), and ForgeDock with the Pi runtime (`npm i -g forgedock`, a release that includes `engine.lean_runtime`).

```bash
pi install git:github.com/RapierCraftStudios/forgedock-pi
```

Restart Pi or run `/reload`. Set `FORGEDOCK_BIN` if `forgedock` is not on `PATH`.

## Configure the target repository

Run `/work-on` inside a checkout that has a ForgeDock `forge.yaml` (`npx forgedock init` creates one). Recommended:

```yaml
engine:
  lean_runtime: pi             # also set by this package; lets `forgedock` on the CLI match
  # lean_reviewer_model: openai-codex/gpt-6-luna   # default: Pi's configured model
orchestration:
  max_concurrent: 4
```

The builder uses `--model` or Pi's default model. Lanes come from the issue: a milestone issue targets `milestone/<slug>`, anything else `staging`. The default branch is never a lane.

## Scale and speed

- Concurrency: `/orchestrate ... --parallel K` (or `orchestration.max_concurrent`). Each lane is its own detached `forgedock run-issue` process with its own worktree.
- The engine pauses a lane's process group while the host is over its admission ceiling and resumes it after, so many lanes on one machine degrade instead of thrashing.
- A dead Pi or ForgeDock process never strands an issue: the lease expires and `forgedock resume-stalled` (or `/orchestrate --resume`) picks it up.
- Fast-model option: `--model openai-codex/gpt-6-luna:high` trades thinking depth for speed per lane.

## Development

```bash
npm install
npm run check   # typecheck + tests
```

See `CHANGELOG.md` for history. Versions before 0.3.0 shipped a separate prompt-spec workflow; it remains in git history.
