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
| Mandatory nested `Skill("test-gate", ...)` | Load the packaged `forgedock-test-gate` skill, which executes `specs/original/commands/test-gate.md` in the current coordinator. Require and preserve its `FORGE:TEST_GATE:RESULT=BLOCK|PASS|SKIP` marker; an absent result is a failure, never `SKIP`. |
| Mandatory nested `Skill(skill="issue", ...)` | Load the packaged `forgedock-issue` skill and execute `specs/original/commands/issue.md`'s programmatic contract. A failed/missing issue hook is a hard failure; do not substitute raw issue creation. |
| Other nested `Skill(...)` references | Resolve the reference to the corresponding file under `specs/original/commands/` and load it directly in the visible coordinator. This is a packaging/load contract only; it does not dispatch or choose workflow phases. |
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
closed and must leave an actionable `review-degraded`/gate-failure artifact. Before
launching a nested panel, Pi's resolved launch contract must include the native
`subagent` tool, the declared depth ceiling, and the explicit tool filter; an
inconsistent profile fails before any GitHub mutation. Reviewer receipts are keyed by
frozen PR head, role, and attempt; a complete detached receipt is reused verbatim. A
timeout or provider-inactive reviewer may be retried alone once with a capped extended
deadline. Cancellation and parent termination are distinct and are not retries. Parent
deadlines must exceed nested reviewer deadlines plus join grace, or be omitted. Pi
resume/session receipts prove execution only; when continuation is not persisted,
recover the complete trusted result artifact or fail closed.

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
The GitHub state branch durably records each batch's lease epoch, deterministic
child-key, predecessor set, ready queue, and deferred queue. On reload, reconcile
retained children by key and resume only unlaunched nodes within the cap, exactly once.
Unknown keys, stale authority, missing predecessors, or ambiguous completion produce an
actionable paused report and launch nothing. Successors launch when predecessors become
terminal-success; no polling loops or second issue lifecycle are allowed. Cleanup and
the consolidated report run after the queue drains or reaches a documented paused state.

## Configuration

The original `forge.yaml` contract is authoritative. Do not silently reinterpret the
current `.forge/config.json` schema as equivalent. If `forge.yaml` is missing, stop with
an actionable migration/init message before GitHub writes or implementation.

## Nested reference and launch validation

The package exposes `forgedock-test-gate` and `forgedock-issue` as executable
translations for the two mandatory nested calls used by staging review. A package
load/preflight check must resolve every nested reference reachable from the public
skills against this packaged skill set or the original specification tree. The
resolved child contract is diagnostic data only: it may report package version,
resolved tools, nested depth, and capability ceilings, but must redact credentials
and must not make routing decisions.

## Safety leaves

Deterministic code may make a single operation safe (bounded verification, frozen PR
snapshot, exact-head guarded merge). It must not choose the next workflow phase,
synthesize a verdict, dispatch a panel, close an issue, or reconcile a hidden run.
