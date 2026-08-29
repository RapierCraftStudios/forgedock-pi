# ForgeDock Pi Runtime Adapter

This file translates runtime mechanics only. The Markdown specifications under
`specs/original/commands/` are the behavioral authority for routing, phase order,
terminal conditions, review policy, GitHub artifacts, remediation, merge, and closure.

## Authority and simplicity

1. The visible Pi session is the coordinator. Do not recreate a workflow engine,
   private journal, lease, reducer, checkpoint protocol, or hidden phase state.
2. GitHub issue/PR state, `workflow:*` labels, and completed `FORGE:*` artifacts are
   the resumable state. Reconstruct the next phase from them on every invocation.
3. A phase result is intermediate unless the original specification names it as a
   terminal state. Continue the route until terminal.
4. Read referenced specifications completely in bounded chunks before executing them.
   Resolve every relative path from this packaged specification tree; never search the
   filesystem for a missing spec.
5. Preserve the original behavior. Historical performance, telemetry, model-tier,
   OpenCode, engine, claims-board, and prompt-cache sections may be skipped when they
   are not required for the requested route, but never skip investigation, build,
   verification, review, remediation, merge, close, or required GitHub evidence.

## Runtime translation

| Original construct | Pi behavior |
| --- | --- |
| `Skill(skill="work-on/investigate", ...)` and other work-on sub-phases | Read the corresponding file under `specs/original/commands/work-on/` and execute it in the current visible coordinator. |
| `Skill(skill="quality-gate", ...)` | Read `specs/original/commands/quality-gate.md`; run it against the assigned worktree. Fork only when isolation or long execution materially benefits the route. |
| `Skill(skill="review-pr", ...)` | Load and execute the `forgedock-review-pr` skill in the current work-on coordinator. That coordinator launches the selected fresh reviewer panel directly and retains ownership of closure. Do not add a second review-coordinator hop. |
| `Skill(skill="review-pr-staging", ...)` | Load `review-pr-staging.md` directly and switch strategy immediately; do not emit another slash command. |
| `Task(...)` or `Agent(...)` | Use Pi's `subagent` tool. Use one synchronous `workflowScript` with `runs.all` for a complete parallel panel. Every reviewer gets fresh context and must be joined before synthesis. |
| Claude `Read`, `Grep`, `Glob`, `Bash` | Pi `read`, search/navigation tools, and `bash`. |
| `$FORGE_HOME/commands/...` | `specs/original/commands/...` in this package. |
| `yq`-based config reads | Read and interpret `forge.yaml` directly with Pi when `yq` is unavailable. Missing `yq` is not a hard failure in Pi; malformed or missing required configuration still is. |
| Missing optional helper script | Follow the prose fallback already described by the specification. Never use an unbounded filesystem search. |

## Subagents

Before delegating, list available agents and choose an executable, non-disabled profile.
Use fresh context for investigation/review and an isolated worktree for each writer.
The orchestrator launches exactly one packaged `forgedock-work-on-coordinator` per
issue, never the builtin `worker`. This coordinator is the explicit fanout exception:
it owns one issue and may use the child-safe nested `subagent` tool only for the
mandatory fresh reviewer panel. It must not launch another work-on coordinator,
orchestrator, or writer.

Review panels use fresh read-only reviewers with repository read/search access; a
frozen diff is the starting point, never the sole code authority. Reviewers must trace
callers, imports, registration points, and cross-service behavior as required by the
review protocol. Keeping review coordination in the work-on child yields the bounded
shape `visible orchestrator → work-on coordinator → reviewers`, within Pi's default
nesting depth.

Never substitute inline self-review for a required reviewer. An incomplete panel fails
closed and must leave an actionable `review-degraded`/gate-failure artifact.

## Work-on ownership

The work-on coordinator owns this closed loop:

`resolve → investigate → [decompose | build → verify → PR → review → remediation/re-review when required → merge → close → trajectory/cleanup]`

Review may merge but never closes the issue. Close explicitly verifies the merge,
closes the issue, updates labels, posts trajectory, and cleans the worktree before
returning terminal success. A new session must resume from GitHub alone.

## Review ownership

Standard review must route a staging/feature-to-protected-target PR to the staging
strategy automatically. It runs configured verification and integration checks,
derives the risk-based reviewer roster, joins the complete fresh panel, creates an
issue for every finding, posts an official PR review tied to the frozen SHA, and applies
the original blocking/merge policy. `--model` and advertised flags must either work or
be rejected explicitly before side effects.

Staging review is a bundle/deployment strategy, not merely a larger standard panel. It
accepts an exact PR number, discovers included PRs, checks prior findings across the
bundle, runs build/CI/runtime gates, and emits exactly one terminal gate result. It
never merges or deploys.

## Orchestrate ownership

Orchestrate is a dispatcher, never a builder. It resolves and filters the issue set,
confirms before launch, establishes explicit/file/database ordering, detects cycles,
and runs one complete work-on skill per ready issue with bounded concurrency. GitHub
states classify each lane as DONE, GATED, FAILED, or IN_PROGRESS. GATED is not FAILED.
Successors launch when predecessors become terminal-success; no polling loops or second
issue lifecycle are allowed. Cleanup and the consolidated report run after the queue
drains or reaches a documented paused state.

## Configuration

The original `forge.yaml` contract is authoritative. Do not silently reinterpret the
current `.forge/config.json` schema as equivalent. If `forge.yaml` is missing, stop with
an actionable migration/init message before GitHub writes or implementation.

## Safety leaves

Deterministic code may make a single operation safe (bounded verification, frozen PR
snapshot, exact-head guarded merge). It must not choose the next workflow phase,
synthesize a verdict, dispatch a panel, close an issue, or reconcile a hidden run.
