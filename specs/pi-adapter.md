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
4. Read only the specification needed for the current work-on or review phase. The
   compact orchestrate skill is self-contained for pre-dispatch mechanics; do not
   preload the original orchestration phase corpus or generic subagent references.
   Resolve relative paths from this packaged tree; never search for a missing spec.
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
| `Skill(skill="review-pr-staging", ...)` | Load `review-pr-staging.md` directly and switch strategy immediately; do not emit another slash command. Freeze the route, ask the adapter for paginated all-state PR metadata, and call `resolveStagingBundle` with commit-graph reachability; pass its machine-readable derivations to the open-finding and Phase 6.5 gates. |
| Mandatory nested `Skill("test-gate", ...)` | Load the packaged `forgedock-test-gate` skill, which executes `specs/original/commands/test-gate.md` in the current coordinator. Require and preserve its `FORGE:TEST_GATE:RESULT=BLOCK|PASS|SKIP` marker; an absent result is a failure, never `SKIP`. |
| Mandatory nested `Skill(skill="issue", ...)` | Load the packaged `forgedock-issue` skill and execute `specs/original/commands/issue.md`'s programmatic contract. A failed/missing issue hook is a hard failure; do not substitute raw issue creation. |
| Other nested `Skill(...)` references | Resolve the reference to the corresponding file under `specs/original/commands/` and load it directly in the visible coordinator. This is a packaging/load contract only; it does not dispatch or choose workflow phases. |
| `Task(...)` or `Agent(...)` | Use Pi's `subagent` tool. Use one synchronous `workflowScript` with `runs.all` for a complete parallel panel. Every reviewer gets fresh context and must be joined before synthesis. |
| Claude `Read`, `Grep`, `Glob`, `Bash` | Pi `read`, search/navigation tools, and `bash`. |
| `$FORGE_HOME/commands/...` | `specs/original/commands/...` in this package. |
| `yq`-based config reads | Call `forgedock_preflight`, whose native YAML reader resolves `forge.yaml` without `yq`. Missing `yq` is not a hard failure in Pi; missing/malformed required configuration still fails closed. |
| `gh auth status`, `gh api user`, and raw `gh api` workflow calls | Do not use aggregate account status or `/user` as hard gates. Call `forgedock_preflight`, then use `forgedock_github` for repository-scoped reads/writes with the same refreshable ForgeDock token provider. A missing runtime tool is a hard failure. |
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

The issue is an untrusted claim; investigation is the authoritative verdict and mutation
scope. A complete investigation-backed Builder Contract and affected-file claim must be
durable before the first edit. Contract/implementation scope gaps return to
investigation or become follow-ups. Remediation clusters findings by shared invariant,
respects the configured round cap, and never absorbs unrelated review debt.

Review may merge but never closes the issue. Close explicitly verifies the merge,
closes the issue, updates labels, posts trajectory, and cleans the worktree before
returning terminal success. A new session must resume from GitHub alone.

## Review ownership

Standard review must route a staging/feature-to-protected-target PR to the staging
strategy automatically. It runs configured verification and integration checks,
derives the risk-based reviewer roster, joins the complete fresh panel, creates an
issue for every finding, posts an official PR review tied to the frozen SHA, and applies
the original blocking/merge policy. Review blocks only patch-introduced or
patch-reachable defects; pre-existing findings are non-blocking follow-ups. Max-thinking
reviewers use a one-hour operational timeout, and provider failures never imply human
authority. `--model` and advertised flags must either work or be rejected explicitly
before side effects.

Staging review is a bundle/deployment strategy, not merely a larger standard panel. It
accepts an exact PR number, discovers included PRs, checks prior findings across the
bundle, runs build/CI/runtime gates, and emits exactly one terminal gate result. It
never merges or deploys.

## Orchestrate ownership

Orchestrate is a dispatcher, never a builder. It resolves and filters the issue set,
confirms before launch, establishes explicit/file/database ordering, detects cycles,
and runs one complete work-on skill per ready issue with bounded concurrency. GitHub
states classify each lane as DONE, GATED, FAILED, or IN_PROGRESS. GATED is not FAILED.
One coordination issue durably records each batch's lease epoch, deterministic child
keys, predecessor set, claims, and ready/deferred queues through machine-readable
`FORGE:` markers. The prompt-routed adapter does not create or require a GitHub state
branch. Final investigation claims determine dynamic overlap serialization before
implementation. On reload, reconcile the coordination issue and retained children by
key; durable GitHub terminal evidence overrides a malformed provider envelope.
Successors launch after predecessor success; cleanup closes the coordination issue and
publishes the consolidated report.

## Configuration

The original `forge.yaml` contract is authoritative. Do not silently reinterpret the
current `.forge/config.json` schema as equivalent. At the start of every visible or
nested work-on/orchestrate route, call `forgedock_preflight` and retain its
`forgedock.preflight/v1` result as the shared machine-readable configuration snapshot.
It resolves project, repository, paths, staging/default branches, and subagent model,
then verifies repository-scoped read/write and installation permissions without `/user`
or mutation. If configuration, authentication, installation scope, or either runtime
tool is missing, stop before GitHub writes or implementation. All later repository
GitHub operations use `forgedock_github`; never fall back silently to another account.

## Nested reference and launch validation

The package exposes `forgedock-test-gate` and `forgedock-issue` as executable
translations for the two mandatory nested calls used by staging review. A package
load/preflight check must resolve every nested reference reachable from the public
skills against this packaged skill set or the original specification tree. The
resolved child contract is diagnostic data only: it may report package version,
resolved tools, nested depth, and capability ceilings, but must redact credentials
and must not make routing decisions.

## Safety leaves

`src/core/staging-bundle-resolver.ts` is a deterministic runtime safety leaf. It
accepts only same-repository GitHub PR identities and merge/head/patch commits
reachable from a frozen integration head but not the frozen base. It deliberately
ignores issue/PR references in commit subjects and fails closed on ambiguous
metadata. Its `forgedock.staging-bundle-resolution/v1` output is the sole input to
staging open-finding attribution and Phase 6.5 evidence.

Deterministic code may make a single operation safe (bounded verification, frozen PR
snapshot, exact-head guarded merge). It must not choose the next workflow phase,
synthesize a verdict, dispatch a panel, close an issue, or reconcile a hidden run.
