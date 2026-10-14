# Agent Instructions

## What this package is

A thin Pi extension over ForgeDock's core work-on engine. `/work-on` and `/orchestrate` start `forgedock run-issue` / `forgedock orchestrate` with `FORGEDOCK_LEAN_RUNTIME=pi`. The workflow, prompts and GitHub record live in ForgeDock (`bin/lean/`), not here.

## No overengineering

- Never overengineer. Use the smallest direct solution that satisfies the current requirement.
- Do not re-implement workflow, review, merge or orchestration logic in this package. Change ForgeDock's engine instead, so Claude Code and Pi stay on one spec.
- Do not add skills, prompt templates, subagent profiles or workflow specs here. Light specs beat heavy ones: the same issue took 19 minutes and ~6.8M tokens with no PR under the old heavy specs, and ~6 minutes for a correct merged-ready PR under ForgeDock's core prompts.
- If an implementation starts expanding beyond the immediate fix, stop, remove the extra machinery, and simplify before continuing.
