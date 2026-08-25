# Security policy

## Supported versions

ForgeDock Pi is currently experimental. Security fixes are applied to the latest `main` revision until the first stable release.

## Reporting a vulnerability

Please use GitHub's private **Security advisory** reporting flow for this repository. Do not open a public issue for credential exposure, authorization bypass, command execution, path escape, protected-branch bypass, or merge-gate vulnerabilities.

Include:

- affected revision;
- threat model and required access;
- exact reproduction steps;
- affected tool, phase, or adapter;
- expected and observed authority boundary;
- suggested mitigation, if known.

## Security boundaries

ForgeDock Pi is designed so that:

- subagents edit only an assigned worktree;
- reviewers are read-only and cannot recursively delegate;
- models cannot select arbitrary verification commands;
- GitHub writes and merges pass deterministic policy checks;
- protected branches are not auto-merged;
- required checks, reviewers, audit artifacts, SHAs, and leases fail closed.

These controls are not an operating-system sandbox. Repository tests execute code and may access resources available to the current user unless a separate container or sandbox is configured. Forge-owned runtime and Git local-exclude writes use directory handles and no-follow opens where the host supports them, and fail closed when those primitives are unavailable. This protects against pre-existing and replacement symlink redirection, but it does not provide a complete lock against a concurrent local filesystem actor that can rename or replace unrelated paths; use a container or VM when that actor is in the threat model.

## Production guidance

Until production hardening is complete:

1. Use a non-production integration branch.
2. Set `autoMergeIntegration` to `false`.
3. Use a dedicated GitHub identity with least-privilege repository access.
4. Run untrusted repositories inside a container or VM.
5. Review `.forge/config.json` from the trusted base revision.
6. Do not expose provider, cloud, SSH, package-registry, or production credentials to child environments.
