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
| `Task(...)` or `Agent(...)` | Use Pi's `subagent` tool with fresh context. A selected review panel is one `workflowScript`/`runs.all` call, never parallel synchronous tool calls. Join every dispatched child before synthesis. |
| Claude `Read`, `Grep`, `Glob`, `Bash` | Pi `read`, search/navigation tools, and `bash`. |
| `$FORGE_HOME/commands/...` | `specs/original/commands/...` in this package. |
| `$FORGE_HOME/bin/...` and `$FORGE_HOME/scripts/...` (including bare `bin/...` and `scripts/...` shorthand inside the specs) | `specs/original/bin/...` and `specs/original/scripts/...` in this package. Resolve against the package root, never the target repository root. |
| `yq`-based config reads | Resolve required configuration once at route start with one direct `yq` call when installed, or one short `node` call using the package's YAML dependency. Retain those values through the route. Missing/malformed required configuration fails closed; do not retry alternate quoting forms. |
| GitHub and Git operations | Use direct `gh` and `git` commands. Verify `gh auth status` and repository access, and run `gh auth setup-git` before noninteractive fetch/push. |
| Missing optional helper script | Follow the prose fallback already described by the specification. Never use an unbounded filesystem search. |
| Child model selection | On Pi, resolve one full model ID from `forge.yaml` `agents.subagent_model`, then `agents.default_model`. This overrides legacy model prose in the original specs. Never pass `sonnet`, `opus`, or `haiku` aliases; difficult-investigation helpers use maximum thinking and reviewers use the risk-calibrated suffix from the review skill. |
| Mechanical failure recovery | A mechanical failure (provider loss, gate mismatch, conflict) is durable `workflow:engine-error` or `review-degraded` evidence with the run ID and handoff path, followed by resume/relaunch. Remove stale active-phase labels. Reserve `needs-human` for a genuine human authority decision. |

## Subagents

Reviewers are source-read-only fresh-context children using the packaged
`forgedock-reviewer` profile. Their sole write authority is one assigned exact-head PR
comment and its exact-ID readback. They never edit source, merge, close, label, create
issues, or recurse. Give each task the prepared diff bundle, repository, PR, full frozen
head SHA, domain, attempt, and persona guidance.

Launch the complete selected panel with exactly one synchronous `workflowScript` whose
only dispatch is one `await runs.all([...])`. Every item uses the resolved full Pi model,
`context: "fresh"`, `acceptance: false`, and a stable role/attempt key. Never emit
multiple synchronous `subagent` calls in one turn and never launch reviewers serially.
The coordinator must require every ordered result to succeed and contain the expected
identity plus a comment ID/URL, then GET each exact comment ID and verify its role marker,
full head SHA, panel attempt, findings block, and integrity token. Re-read the PR head
after all readbacks and discard the panel if it moved. Only one complete set from the
same head and attempt may reach synthesis. The coordinator never proxy-posts comments.

A transient provider failure increments the attempt and reruns a fresh complete panel at
the same frozen head, up to the existing retry bound; earlier partial comments remain
audit evidence but are never verdict input. A malformed result,
rejected child, failed publication/readback, or exhausted transient retries records
`review-degraded` evidence and stops without a verdict, remaining resumable rather than
becoming `needs-human`. Never substitute inline self-review.

Reviewer deadlines are runtime plumbing, not workflow gates: use the original generous
reviewer deadline and a strictly larger panel join deadline. Pi attention notices are
observational; do not steer, resume, or duplicate an active reviewer.

## Orchestrate dispatch mechanics

Orchestrate resolves and confirms the issue set, then launches exactly one top-level
`subagent` workflow with `async: true`. Pass `globalConcurrencyLimit` from the resolved
`orchestration.max_concurrent` and size `maxSubagentSpawnsPerRun` for all issue lanes and
their reviewer panels. The async composite has no parent deadline, but Pi gives each
workflow child a 30-minute default when `timeoutMs` is omitted. Set every complete
work-on item and its packaged profile to `timeoutMs: 2147483647` (Pi's supported maximum,
a practical no-deadline value). Watchdog notices and explicit cancellation remain.

### Canonical dispatch recipe (authoritative — do not improvise)

Before launch, resolve each issue's configured PR target. Fetch every distinct target and
create one clean detached base worktree at exact `origin/<target>` under the batch-owned
orchestrator base directory. Verify each base's `HEAD` and clean status. Set every issue
item's `cwd` to the absolute base for its target and `worktree: true`; Pi then creates the
issue worktree from the correct commit. Remove only these batch-owned detached bases after
all lanes using them are terminal.

Build one visible promise graph from the confirmed issue DAG. Attach the same named
`normalizeFailure` catch to every `runs.run` promise immediately so a failed child becomes
an `{ ok: false, error }` result instead of rejecting the graph. For each dependent,
create a named plain function that launches its canonical normalized `runs.run` only when
all direct predecessor results are successful, and assign its promise with
`Promise.all([predecessorPromises...]).then(namedLaunchFunction).catch(normalizeFailure)`.
Finish with one `await Promise.all([allIssuePromises...])`; because failures are normalized,
every sibling settles and every launched promise is observed. This starts a successor as
soon as its own predecessors finish; never await a whole sibling wave or poll.
The validated shape is:

```js
function normalizeFailure(error) { return { ok: false, error: String(error) }; }
const a = runs.run("work-on-A", { agent: "forgedock-work-on-coordinator", task: "A --under-orchestration", context: "fresh", cwd: "/absolute/base-for-A-target", worktree: true, timeoutMs: 2147483647 }).catch(normalizeFailure);
const b = runs.run("work-on-B", { agent: "forgedock-work-on-coordinator", task: "B --under-orchestration", context: "fresh", cwd: "/absolute/base-for-B-target", worktree: true, timeoutMs: 2147483647 }).catch(normalizeFailure);
function launchC(predecessors) {
  for (let i = 0; i < predecessors.length; i += 1)
    if (!predecessors[i].ok) return { ok: false, skipped: true, reason: "predecessor failed" };
  return runs.run("work-on-C", { agent: "forgedock-work-on-coordinator", task: "C --under-orchestration", context: "fresh", cwd: "/absolute/base-for-C-target", worktree: true, timeoutMs: 2147483647 }).catch(normalizeFailure);
}
const c = Promise.all([a]).then(launchC).catch(normalizeFailure);
return await Promise.all([a, b, c]);
```

Generate the same named-function shape from the concrete confirmed DAG; `A`/`B` are
independent roots and `C` depends only on `A`.

Every issue launch uses a stable `work-on-<number>` key,
`agent: "forgedock-work-on-coordinator"`, task text exactly
`"<number> --under-orchestration"`, `context: "fresh"`, `worktree: true`, and
`timeoutMs: 2147483647`. A predecessor failure returns an explicit unlaunched-dependent
result; it does not block unrelated promises. A single issue uses the same shape.

Before its first source edit, every orchestrated coordinator verifies that `$PWD` is a
clean linked worktree on a `pi-parallel-*` branch, fetches the configured target, and runs
`git merge --ff-only origin/<target>`. It then requires `origin/<target>` to be an ancestor
of `HEAD`. Never reset a checkout. If any guard fails before mutation, return mechanical
`workflow:engine-error` evidence for canonical relaunch from the correct base. If the
target moves after mutation, reconcile the issue patch in the same owned worktree—or one
replacement from its handoff—and rerun verification/review. Technical conflicts and
already-applied sibling hunks are not `needs-human`.

After the workflow settles, reconcile each issue from GitHub. Terminal issues stay DONE.
For each failed non-terminal lane, immediately replace stale active-phase labels with
`workflow:engine-error`, post one durable recovery comment containing the run ID and
handoff path. Resume the retained run only while its original worktree ownership remains
valid; otherwise launch one replacement managed worktree, restore the handoff patch there,
verify its diff, and continue with the identical canonical task. Never run two writers for
the same issue. Recovery success re-enters normal label progression. Never report a
workflow complete while a planned issue is merely abandoned.

A supported compact plan runs entirely on this recipe without loading the large phase-4
corpus. Never load the pi-subagents reference corpus to compose it. Consult original
phase files only for ambiguous selectors, cycles, or recovery
not covered above. Investigation helper calls remain direct children; the one reviewer
panel workflow described above is the coordinator's only nested workflow.

## Configuration

The original `forge.yaml` contract is authoritative. The outermost coordinator for a
lane reads it once as JSON (`FORGE_CONFIG_JSON=$(yq -o=json '.'
"${FORGE_CONFIG:-forge.yaml}")`) and derives repository, branches, paths, concurrency,
and `SUBAGENT_MODEL` from that retained value with `jq`; nested skill routes inherit it.
A standalone route performs the same one-time read. Model precedence is
`.agents.subagent_model // .agents.default_model // empty`; an empty value or legacy
`sonnet`/`opus`/`haiku` alias fails before child launch. Do not rerun equivalent `yq`
snippets, reload a spec already loaded in the
current phase, or refetch unchanged issue/history data. Refresh GitHub state only after
this route writes it or receives a completion event.

Verify the **active** identity (`gh auth status --active`) and repository access; a
stored-but-failing non-active account must never fail preflight. Run `gh auth setup-git`
before fetch or push. Missing configuration or authentication stops before writes.

## Safety leaves

`src/core/staging-bundle-resolver.ts` is a deterministic runtime safety leaf used by
staging review: it accepts only same-repository GitHub PR identities with
merge/head/patch commits reachable from the frozen integration head but not the frozen
base, and fails closed on ambiguous metadata. Deterministic code may make a single
operation safe (bounded verification, frozen PR snapshot, exact-head guarded merge);
it must never choose the next workflow phase, synthesize a verdict, dispatch a panel,
close an issue, or reconcile a hidden run.
