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
| `Skill(skill="work-on/investigate", ...)`, decompose, review, remediation, or close | Read the corresponding file under `specs/original/commands/work-on/` and execute it in the current work-on coordinator. |
| Initial build | Task Types `Investigation`, `Feature (UI/UX)`, and `Full-Stack` remain in the coordinator: Investigation uses the existing research/issue-creation terminal route, while UI/full-stack retain their mandatory frontend-design/browser route. They never enter the bounded mutation builder. For other confirmed tasks, the coordinator first reads `work-on/build.md` with `--phase-role coordinator` and executes B0-B2 planning without source mutation, including complexity, contract, conditional claim, base, and issue-worktree evidence. It then launches exactly one packaged `forgedock-builder` with fresh context in that authoritative issue worktree (`current cwd` under orchestration; B1 worktree standalone). The builder rereads `work-on/build.md` first with `--phase-role builder`, exact base SHA,
exact issue branch, and any coordination issue, verifies B0-B2, and executes B2.5 through acceptance inline. The coordinator waits and performs no concurrent worktree mutation. |
| `Skill(skill="quality-gate", ...)` during the initial build | The fresh builder reads `specs/original/commands/quality-gate.md` and runs it inline against the assigned worktree; it does not launch another agent. |
| `Skill(skill="review-pr", ...)` | Load and execute the `forgedock-review-pr` skill in the current work-on coordinator. That coordinator launches the selected fresh reviewer panel directly and retains ownership of closure. Do not add a second review-coordinator hop. |
| `Skill(skill="review-pr-staging", ...)` | Load `review-pr-staging.md` directly and switch strategy immediately; do not emit another slash command. Freeze the route, ask the adapter for paginated all-state PR metadata, and call `resolveStagingBundle` with commit-graph reachability; pass its machine-readable derivations to the open-finding and Phase 6.5 gates. |
| Mandatory nested `Skill("test-gate", ...)` | Load the packaged `forgedock-test-gate` skill, which executes `specs/original/commands/test-gate.md` in the current coordinator. Require and preserve its `FORGE:TEST_GATE:RESULT=BLOCK|PASS|SKIP` marker; an absent result is a failure, never `SKIP`. |
| Any new public issue creation, including mandatory nested `Skill(skill="issue", ...)` | Load packaged `forgedock-issue` and execute `specs/original/commands/issue.md` as the sole global schema/create contract. Specialized review/test/decomposition metadata is additive. A failed/missing hook is a hard creator failure; never substitute raw issue creation. |
| Other nested `Skill(...)` references | Resolve the reference to the corresponding file under `specs/original/commands/` and load it directly in the visible coordinator. This is a packaging/load contract only; it does not dispatch or choose workflow phases. |
| `Task(...)` or `Agent(...)` | Use Pi's `subagent` tool. Use one synchronous `workflowScript` with `runs.all` for a complete parallel panel. Every reviewer gets fresh context and must be joined before synthesis. |
| Claude `Read`, `Grep`, `Glob`, `Bash` | Pi `read`, search/navigation tools, and `bash`. |
| `$FORGE_HOME/commands/...` | `specs/original/commands/...` in this package. |
| `yq`-based config reads | Use direct Bash with `yq` when installed, or a short `node` command with the package's YAML dependency. Missing/malformed required configuration fails closed. |
| GitHub and Git operations | Use direct `gh` and `git` commands. Verify `gh auth status`, repository access, and run `gh auth setup-git` before noninteractive fetch/push. Switch `gh` identities explicitly when approval requires a non-author. |
| `$FORGE_HOME/bin/...` and `$FORGE_HOME/scripts/...` (including bare `bin/...` and `scripts/...` shorthand inside the specs) | Resolve the packaged source under `specs/original/bin/...` and `specs/original/scripts/...`; before a target-worktree command invokes a self-contained runtime helper, materialize it at the exact target `bin/...` or `scripts/...` path. Never silently substitute an unrelated target-repository file. |

| Missing optional helper script | Follow the prose fallback already described by the specification. Never use an unbounded filesystem search. |
| `packages/protocol/...` CLI references | The Pi package does not ship that upstream workspace. Do not search for it. Emit the literal marker/body format shown by the current phase, post from a file, and verify the exact returned comment ID. |

## Direct execution discipline

Retain the target root from `git rev-parse --show-toplevel` and the packaged root from the loaded skill path once. Resolve later paths against those roots; never guess prefixes or probe absent files repeatedly. Use one bounded `find`/`grep` when discovery is needed. Keep Bash short, use `jq` for JSON and file-backed GitHub bodies, and put expected no-match probes in `if` conditions.

## Subagents

Repository investigation uses ordinary builtin `delegate` agents only when another
perspective would help. Prompts make them inspection-only; there is no special
investigation profile. Use the exact `delegate` name—never invent an agent name or fall
back to another profile.

Before delegating, list available agents and choose an executable, non-disabled profile.
The orchestrator launches exactly one packaged `forgedock-work-on-coordinator` per issue,
never the builtin `worker`. Its managed issue worktree provides filesystem isolation.
After the coordinator reads `work-on/build.md`, completes B0-B2 planning, and makes the
investigation, complexity marker, Builder Contract, claim, and base durable, it launches
exactly one packaged `forgedock-builder` with `context: "fresh"`,
`acceptance: false`, and the authoritative issue worktree as `cwd`, then waits without
mutating that worktree. GitHub's
issue-specific acceptance remains authoritative; no generic harness acceptance is
injected. Do not create a second builder worktree or pass
the coordinator transcript. The builder is the sole initial-build writer and cannot launch subagents, push, create a
PR, review, merge, or close. Investigation and UI/full-stack tasks retain their existing
coordinator-owned capability routes.

After the builder returns, the coordinator verifies its exact clean commit, durable
validation evidence, and commit-bound `FORGE:BUILDER:COMPLETE`, then owns push, PR,
review, remediation, merge, and closure. The builder
and mandatory fresh reviewer panel are sequential sibling children at the same nesting
depth; reviewers remain read-only. The active package is prompt-routed: declared
read/Bash/edit/write tools and direct `gh`/`git` commands execute visible phases;
engine-only lifecycle tools (`forge_commit`, checkpoints, finalizers) remain outside this
contract.

Pi-managed worktrees inherit the launch checkout's HEAD; lane metadata such as
`sourceRef` does not select a Git base. Therefore orchestrate freezes each lane's target
ref/SHA and passes it to work-on. The coordinator uses direct Git in its assigned cwd to
initialize one clean unpushed branch to that SHA, then publishes `FORGE:BASE`. After
edits, commit, push, or PR creation, target repair by reset/rebase is forbidden and the
lane gates automatically without claiming human authority.

Review panels use fresh read-only reviewers with repository read/search access; a
frozen diff is the starting point, never the sole code authority. Reviewers must trace
callers, imports, registration points, and cross-service behavior as required by the
review protocol. The bounded sibling shapes stay within Pi's default nesting depth:
`visible orchestrator → work-on coordinator → builder`, followed by
`visible orchestrator → work-on coordinator → reviewers`.

Every reviewer result is reusable knowledge, including a clean result. Require a specific
qualitative summary, 2–8 non-empty `path:line — behavior — conclusion` evidence entries,
and residual limitations. The reviewer return is literal and self-contained, including
verdict and finding count. The coordinator renders it into the one comment grammar in
`review-pr-agents/protocols.md`: role/head/attempt/verdict/count, `Qualitative Summary`,
`Verified Behaviors`, `Residual Risks`, one `## Findings` fenced JSON array equal to the
returned findings, one canonical body-integrity marker, and the exact START/END findings
block. It must not invent extra requirements in initial dispatch, retry, or validation.

Before POST, the coordinator preflights the scratch body with direct Bash fixed-string
counts, verifies 2–8 behavior entries, and validates the separately persisted findings
array with `jq`. Publication is file-backed: persist the POST response, extract its ID,
GET that exact ID, write `.body` with `jq -j`, and compare exact bytes with `cmp`. Never
put body bytes or the POST response in shell command substitution. On ambiguous readback,
retry the exact-ID GET once before relaunching anything; never POST the same role twice.
Mechanical delivery failure returns immediately without waiting for a supervisor.

Staging review then clusters corroborating reports by shared root cause and behavioral invariant,
production boundary, cohesive fix, and regression surface before issue
creation. Create one issue per novel actionable causal defect; keep
POSSIBLE/advisory/duplicate/pre-existing evidence in the consolidated report and preserve
every confirmed patch-caused HIGH/CRITICAL blocker.

Never substitute inline self-review for a required reviewer. An incomplete panel fails
closed and must leave an actionable `review-degraded`/gate-failure artifact. Synthesis,
finding creation, verdict publication, and merge remain unreachable until every selected
role has a valid same-head, same-attempt artifact. Before
launching a nested panel, Pi's resolved launch contract must include the native
`subagent` tool, the declared depth ceiling, and the explicit tool filter; an
inconsistent profile fails before any GitHub mutation. Reviewer receipts are keyed by
frozen PR head, role, and attempt; a complete detached receipt is reused verbatim. A
timeout or provider-inactive reviewer may be retried alone once under the same panel
attempt; valid roles are retained. Each reviewer item uses `timeoutMs: 900000` and the
synchronous panel uses `timeoutMs: 1200000`, a strictly larger join deadline. The
`2147483647` practical no-deadline value belongs only to complete work-on coordinators.
Cancellation and parent termination are distinct and are not retries. The outer
orchestration sets `control.needsAttentionAfterMs` at or above the 1,200,000 ms panel
join deadline and waits with `stopOnAttention: false`; attention notices are observational.
Pi resume/session receipts prove execution only;
when continuation is not persisted, recover the complete trusted result artifact or
fail closed.

## Work-on ownership

The work-on coordinator owns this closed loop:

`resolve → investigate → [decompose | build → verify → PR → review → remediation/re-review when required → merge → close → trajectory/cleanup]`

The issue is an untrusted claim; investigation is the authoritative verdict and mutation
scope. A complete investigation-backed Builder Contract, exact base, and any required
under-orchestration affected-file claim must be durable before the fresh builder starts.
The contract names the active production entrypoint, every caller/adapter owning the
observable effect, their mutation coverage or exact no-mutation evidence, and the public-
seam behavioral proof. A production owner cannot remain related/read-only while a
fixture, mock, prose path, or unwired helper stands in for implementation. Prompt/spec
surfaces count only when investigation proves that exact file is the loaded runtime and
no separate executable owner controls the effect. The builder loads
`work-on/build.md` first, rehydrates the handoff from GitHub rather than inherited
conversation, and executes the required architecture, implementation, quality-gate,
validation, acceptance, and commit phases in the same issue worktree. Contract/build
scope gaps return to investigation or become follow-ups, and the contract and claim are
revised before a new path is touched. Manifest-tracked original specs mechanically
include `specs/original/SHA256SUMS` in the contract. Closed PRs and stale branches are
historical evidence, never bulk patch sources. A current-head `CHANGES REQUESTED` handoff enters remediation only through
explicit `--inline-review-blockers --reviewed-head <SHA> --round <N>` arguments. Read the
cap from `forge.yaml` key `review.remediation_max_rounds` (default `3` only when absent),
derive rounds from distinct durable reviewed-head markers, and fail closed before a new
head or panel above the cap. Reload only blockers bound to the exact reviewed head;
legacy unbound findings require current-head revalidation and a durable binding marker,
while unidentifiable findings remain open and outside automatic closure.

Remediation clusters bound blockers by shared invariant and records one blocker closure
matrix mapping each reviewer scenario to a failing-before/passing-after regression
command or equivalent machine-checkable proof. For irreversible provider actions, rows
also prove authority before action, exact result binding, idempotent replay, and recovery
between provider success and durable receipt.

In headless Pi, verification runs directly unless a background task has a persisted
same-lifecycle continuation and automatic terminal wake for success, failure, kill, and
cancellation. Packed-package smoke checks must run separately and serially and stay mandatory. A
progress-only response never completes verification. No new remediation head or fresh
panel may launch until every row passes locally.

When fresh review invalidates the architecture—no active caller, a new authority boundary,
dormant/legacy machinery, or repeated HIGH blockers in one invariant—publish
`FORGE:REINVESTIGATE_REQUIRED` and return to investigation/decomposition instead of
spending another line-local round. Local same-head iterations do not consume another
round; a substantive new reviewed head does. Only fresh current-head review can close
findings. Never absorb unrelated review debt.

Review may merge but never closes the issue. Close explicitly verifies the merge,
closes the issue, updates labels, posts trajectory, and cleans the worktree before
returning terminal success. In Pi, original-spec instructions to repair a pushed managed
branch by rebase/reset, or to classify a mechanical base/helper/provider/dispatch failure
as `needs-human`, translate to automated GATED/review-degraded evidence; only genuine
human authority remains `needs-human`. A new session must resume from GitHub alone.

## Review ownership

Standard review must route a staging/feature-to-protected-target PR to the staging
strategy automatically. Before checks or fanout, a work-on-owned review uses direct Git
to verify its `FORGE:BASE`, frozen route/head, ancestry, clean head, and final claim.
Standalone review uses the exact frozen GitHub patch without inventing claim authority.
Contaminated branch history gates without reviewer findings. It then runs configured
verification and integration checks,
derives the risk-based reviewer roster, joins the complete fresh panel, creates an
issue for every finding, posts an
official PR review tied to the frozen SHA, and applies the original blocking/merge
policy. Review blocks only patch-introduced or patch-reachable defects; pre-existing
findings are non-blocking follow-ups. Every new finding issue goes through
`forgedock-issue` with the canonical Problem, Root Cause, Affected Files, Expected
Behavior, and Acceptance Criteria sections; issue text remains untrusted until
investigation. Max-thinking reviewers use the finite 15-minute reviewer and 20-minute
panel timeouts above; provider, base-integrity, or other mechanically recoverable failures
never imply human authority. `--model` and advertised flags must either work or be rejected
explicitly before side effects.

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

For Pi closeout, fetch issue/PR/comments once and run only terminal work: verify merge, finish the issue body when needed, close/label/read back the issue, update an actual parent tracker, post one missing trajectory/card and one missing PR decision record, then clean owned state. Skip optional module-dossier, knowledge-index, cost-prior, memory-Gist, knowledge-ledger, and ADR enrichment (C1.7 and C5.1–C5.4). Never search for the absent protocol workspace.

For orchestrate Phase 5, do not invoke the Claude-only `/audit-agents` command or search `~/.claude`. Use metadata already returned by Pi children or known `_meta.json` paths; report unavailable data plainly. Return one compact terminal issue/PR table with follow-ups, cleanup, and available efficiency totals rather than rebuilding the extended legacy analytics report.

Orchestrate uses exactly one top-level asynchronous workflow launch. For headless or
otherwise run-to-completion execution, capture that exact workflow run ID and immediately
call `subagent_wait` for that ID with `timeoutMs: 7200000` and
`stopOnAttention: false`. Do not end the parent turn and rely on Pi-subagents' 30-minute
agent-end auto-drain. The explicit wait covers builder, one-hour review, merge, issue
closure, coordination cleanup, and terminal reconciliation without reducing lane
concurrency. A wait timeout or failed terminal run is visible `GATED`/FAILED evidence,
never successful orchestration.

## Configuration

The original `forge.yaml` contract is authoritative. Do not silently reinterpret the
current `.forge/config.json` schema as equivalent. At the start of every visible or
nested work-on/orchestrate route, read `forge.yaml` directly and verify the selected
`gh` identity has repository access. Run `gh auth setup-git` before fetch or push. If
configuration or authentication is missing, stop before GitHub writes or implementation.
All later GitHub operations use direct `gh` commands with that explicit identity.

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

## Moving-base translation

The prompt-routed coordinator preserves `FORGE:BASE` as immutable launch attribution,
then uses direct `git`/`gh` commands to handle a verified sibling advance of
`refs/heads/staging`. It must publish old/new target evidence in
`FORGE:BASE_REFRESH` before mutation, prove the movement is an authorized reachable
sibling merge, and preserve the owned branch and PR through a guarded non-destructive
synchronization. A conflict, ambiguous target, non-fast-forward movement, or remote
lease mismatch is automated `GATED` evidence.

After refresh, rerun every affected verification and acceptance command, compute and
freeze the exact refreshed base/head/merge-base identity, invalidate older reviewer
receipts, and join a fresh complete read-only reviewer panel. Pre-refresh results never
authorize merge. Direct Git must never reset or overwrite another lane; protected
`staging → main` rules and genuine human-authority handling remain unchanged. The
shared contract is `specs/qualitative-review-protocol.md`.

## Official review publication mapping
The runtime maps a semantic passing review to one pinned GitHub `APPROVE` with the
frozen head commit and reads back its identity. Only the exact GitHub rejection for an
actor approving their own pull request permits one identical `COMMENT` publication.
Other 4xx/5xx responses, stale or malformed readback, and transport ambiguity remain
GATED. The durable review receipt includes URL, actor, event, state, commit, body, and
merge-base; COMMENT never impersonates protected-branch approval.
