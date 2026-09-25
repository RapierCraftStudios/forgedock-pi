---
description: Review one frozen pull request independently
argument-hint: "<PR>"
---
Use the `forgedock-review-pr` skill for the requested PR.

PR identity contract: when `$ARGUMENTS` is a bare positive PR number, use the
canonical `forge.yaml` in the current target checkout to derive `project.owner/repo` and
resolve that PR. Do not ask for a URL or repository when that canonical identity is available.
Ask only when the configured repository or PR identity cannot be resolved unambiguously.

User arguments: $ARGUMENTS
