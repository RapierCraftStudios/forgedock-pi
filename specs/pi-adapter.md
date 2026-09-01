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
4. Read only the specification needed for the current phase. Resolve relative paths
   from this packaged tree; never search for a missing spec.
5. Preserve the original behavior. Historical performance, telemetry, model-tier,
   OpenCode, engine, and prompt-cache sections may be skipped when they are not
   required for the requested route, but never skip investigation, build, verification,
   review, remediation, merge, close, or required GitHub evidence.

## Runtime translation

| Original construct | Pi behavior |
| --- | --- |
| `Skill(skill="work-on/investigate", ...)`, decompose, review, remediation, or close | Read the corresponding file under `specs/original/commands/work-on/` and execute it in the current work-on coordinator. |
| `Skill(skill="quality-gate", ...)` | Read `specs/original/commands/quality-gate.md` and execute it inline in the current coordinator. |
| `Skill(skill="review-pr", ...)` | Load and execute the packaged `forgedock-review-pr` skill in the current coordinator. Do not add a second review-coordinator hop. |
| `Skill(skill="review-pr-staging", ...)` | Load the packaged `forgedock-review-pr-staging` skill, which executes `specs/original/commands/review-pr-staging.md` directly. |
| Mandatory nested `Skill("test-gate", ...)` | Load the packaged `forgedock-test-gate` skill and require its `FORGE:TEST_GATE:RESULT=BLOCK\|PASS\|SKIP` marker. |
| Any new public issue creation, including mandatory nested `Skill(skill="issue", ...)` | Load packaged `forgedock-issue` and execute `specs/original/commands/issue.md` as the sole global schema/create contract. |
| Other nested `Skill(...)` references | Resolve the reference to the corresponding file under `specs/original/commands/` and load it directly in the visible coordinator. |
| `Task(...)` or `Agent(...)` | Use Pi's `subagent` tool with fresh context. Join every dispatched child before synthesis. |
| Claude `Read`, `Grep`, `Glob`, `Bash` | Pi `read`, search/navigation tools, and `bash`. |
| `$FORGE_HOME/commands/...` | `specs/original/commands/...` in this package. |
| `$FORGE_HOME/bin/...` and `$FORGE_HOME/scripts/...` (including bare `bin/...` and `scripts/...` shorthand inside the specs) | `specs/original/bin/...` and `specs/original/scripts/...` in this package. Resolve against the package root, never the target repository root. |
| `yq`-based config reads | Use direct Bash with `yq` when installed, or a short `node` command with the package's YAML dependency. Missing/malformed required configuration fails closed. A missing `yq` binary itself is never a failure: use the fallback automatically. |
| GitHub and Git operations | Use direct `gh` and `git` commands. Verify `gh auth status` and repository access, and run `gh auth setup-git` before noninteractive fetch/push. |
| Missing optional helper script | Follow the prose fallback already described by the specification. Never use an unbounded filesystem search. |
| Mechanical failure recovery | A mechanical failure (timeout, provider loss, gate mismatch, conflict) is automated `GATED`/`review-degraded` evidence with actionable detail. Reserve `needs-human` for a genuine human authority decision. |

## Subagents

Reviewers are read-only fresh-context children (the packaged `forgedock-reviewer`
profile) launched directly by the coordinator that owns the review. They receive the
frozen diff as a starting point and keep repository read/search access for evidence
tracing; a complete panel must be joined before synthesis, and an incomplete panel
fails closed as review-degraded evidence. Never substitute inline self-review for a
required reviewer. Nested shapes stay within Pi's default nesting depth:
`visible orchestrator → work-on coordinator → reviewers`.

Reviewer deadlines are Pi runtime plumbing, not workflow gates: give each reviewer a
generous `timeoutMs` (the original one-hour reviewer budget is a good default) and make
the parent join window strictly larger than the reviewer deadline, or omit it. Pi's
generic attention event is observational, never a timeout — wait with
`stopOnAttention: false` and do not steer, resume, or duplicate an active reviewer.

## Orchestrate dispatch mechanics

Orchestrate resolves and confirms the issue set, then launches exactly one top-level
`subagent` workflow with `async: true` whose `workflowScript` performs a single
`await runs.all(...)` — one fresh packaged `forgedock-work-on-coordinator` item per
ready issue, each with an isolated worktree. Pass `globalConcurrencyLimit` set to
`orchestration.max_concurrent` from `forge.yaml`, and size `maxSubagentSpawnsPerRun`
so every coordinator's reviewer panel fits. For run-to-completion execution, wait on
the exact returned workflow run ID with `subagent_wait` and a generous `timeoutMs`
rather than ending the parent turn; a wait timeout or failed terminal run is visible
GATED/FAILED evidence, never successful orchestration.

### Canonical dispatch recipe (authoritative — do not improvise)

All coordinator launches — initial wave, successor, and recovery relaunch — use the
same shapes. Never load the pi-subagents reference corpus to compose a script; this
recipe is the whole translation of the original Claude Code `Task()` dispatch.

1. **Wave (two or more ready issues)** — one `subagent({ async: true, workflowScript,
   globalConcurrencyLimit, maxSubagentSpawnsPerRun })` call. Inside the script, one
   `await runs.all(ready.map((issue) => ({ key: \`work-on-\${issue.number}\`,
   agent: "forgedock-work-on-coordinator", task: \`\${issue.number} --under-orchestration\`,
   context: "fresh", worktree: true })))`, then return the ordered results.
2. **Single issue** — either a bare `subagent({ agent, task, context: "fresh",
   worktree: true })` call with **no** `globalConcurrencyLimit`/
   `maxSubagentSpawnsPerRun` (those are valid only with `workflowScript`), or a
   workflowScript wrapping one `runs.run`. Successor issues launch inside the
   original workflowScript (sequential `runs.run` after a completed `runs.all` item)
   rather than as ad-hoc top-level calls.
3. **Child task text is always exactly** `"<issue number> --under-orchestration"` —
   for first dispatch and recovery alike. Never compose prose task descriptions;
   the coordinator rehydrates its state from GitHub, and improvised task text
   produces off-spec coordinator behavior.
4. **Recovery relaunch** — after verifying GitHub state (which lanes reached terminal
   labels), relaunch only the non-terminal issues through shape 1 or 2 exactly as a
   first dispatch. A workflow-level failure never fails lanes whose GitHub state is
   terminal; report them DONE and relaunch the remainder.
5. **Do not launch nested workflows inside a coordinator task.** Investigation
   research fanout is direct read-only children, not a sub-workflow of domain lanes.

## Configuration

The original `forge.yaml` contract is authoritative. At the start of every visible or
nested work-on/orchestrate/review route, read `forge.yaml` directly and verify the
selected `gh` identity has repository access. Run `gh auth setup-git` before fetch or
push. If configuration or authentication is missing, stop before GitHub writes or
implementation.

## Safety leaves

`src/core/staging-bundle-resolver.ts` is a deterministic runtime safety leaf used by
staging review: it accepts only same-repository GitHub PR identities with
merge/head/patch commits reachable from the frozen integration head but not the frozen
base, and fails closed on ambiguous metadata. Deterministic code may make a single
operation safe (bounded verification, frozen PR snapshot, exact-head guarded merge);
it must never choose the next workflow phase, synthesize a verdict, dispatch a panel,
close an issue, or reconcile a hidden run.
