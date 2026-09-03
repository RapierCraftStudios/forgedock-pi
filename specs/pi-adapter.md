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
| `Skill(skill="work-on/investigate", ...)`, decompose, review, remediation, or close | Read the corresponding file under `specs/original/commands/work-on/` and execute it in the current work-on agent. |
| `Skill(skill="quality-gate", ...)` | Read `specs/original/commands/quality-gate.md` and execute it inline in the current work-on agent. |
| `Skill(skill="review-pr", ...)` | Load and execute the packaged `forgedock-review-pr` skill in the current work-on agent. Do not add a second review-coordinator hop. |
| `Skill(skill="review-pr-staging", ...)` | Load the packaged `forgedock-review-pr-staging` skill, which executes `specs/original/commands/review-pr-staging.md` directly. |
| Mandatory nested `Skill("test-gate", ...)` | Load the packaged `forgedock-test-gate` skill and require its `FORGE:TEST_GATE:RESULT=BLOCK\|PASS\|SKIP` marker. |
| Any new public issue creation, including mandatory nested `Skill(skill="issue", ...)` | Load packaged `forgedock-issue` and execute `specs/original/commands/issue.md` as the sole global schema/create contract. |
| Other nested `Skill(...)` references | Resolve the reference to the corresponding file under `specs/original/commands/` and load it directly in the visible coordinator. |
| `Task(...)` or `Agent(...)` inside a work-on lane | Execute the requested investigation, planning, build, quality-gate, verification, remediation, or close work inline in the current work-on agent. The only exception is the selected fresh review/re-review panel, launched with one `workflowScript`/`runs.all` call and fully joined before synthesis. |
| Claude `Read`, `Grep`, `Glob`, `Bash` | Pi `read`, search/navigation tools, and `bash`. |
| `$FORGE_HOME/commands/...` | `specs/original/commands/...` in this package. |
| `$FORGE_HOME/bin/...` and `$FORGE_HOME/scripts/...` (including bare `bin/...` and `scripts/...` shorthand inside the specs) | `specs/original/bin/...` and `specs/original/scripts/...` in this package. Resolve against the package root, never the target repository root. |
| `yq`-based config reads | Resolve required configuration once at route start with one direct `yq` call when installed, or one short `node` call using the package's YAML dependency. Retain those values through the route. Missing/malformed required configuration fails closed; do not retry alternate quoting forms. |
| GitHub and Git operations | Use direct `gh` and `git` commands. Verify `gh auth status` and repository access, and run `gh auth setup-git` before noninteractive fetch/push. |
| Missing optional helper script | Follow the prose fallback already described by the specification. Never use an unbounded filesystem search. |
| `packages/protocol/...` CLI references | The Pi package does not ship that upstream workspace. Do not search for it. Emit the literal marker/body format shown by the current phase, post from a file, and verify the exact returned comment ID. |
| Child model selection | On Pi, resolve one full model ID from `forge.yaml` `agents.subagent_model`, then `agents.default_model`. This overrides legacy model prose in the original specs. Never pass `sonnet`, `opus`, or `haiku` aliases; work-on agents retain that model for the complete inline lifecycle and reviewers use the risk-calibrated suffix from the review skill. |
| Mechanical failure recovery | A mechanical failure (provider loss, gate mismatch, conflict) is durable `workflow:engine-error` or `review-degraded` evidence with the run ID and handoff path, followed by resume/relaunch. Remove stale active-phase labels. Reserve `needs-human` for a genuine human authority decision. |
| Explicit unmerged prerequisite | Add `blocked`, remove `needs-human` and stale active labels, post `FORGE:GATED` with the exact prerequisite and merge/event resume condition, return without remediation or a supervisor question, and resume the same PR after it lands. |

## Direct execution discipline

Retain the target root from `git rev-parse --show-toplevel` and the packaged root from the
loaded skill path once. Resolve every later path against those roots. Never guess alternate
path prefixes or probe absent files repeatedly; use one bounded `find` or `grep` from the
known root when discovery is needed. Keep Bash commands short. Use `jq` for JSON, file-backed
GitHub bodies, and `if` conditions for expected no-match probes instead of quote-heavy regex
pipelines whose normal nonzero result becomes a tool failure.

## Subagents

A work-on agent executes every lifecycle phase inline except fresh review. Before the
review or re-review phase, it must not call `subagent`: investigation, contract, planning,
implementation, quality gates, verification, PR preparation, remediation, merge, close,
and cleanup stay in the same per-issue agent. Original-spec `Task(...)`, `Agent(...)`, or
cache-TTL fork prose never overrides this Pi topology.

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
identity plus a comment ID/URL, then GET each exact comment ID and verify the literal
comment grammar from `agents/forgedock-reviewer.md`: role marker, full head SHA, panel
attempt, specific qualitative summary, 2–8 non-empty
`path:line — behavior — conclusion` entries, residual risks, one `## Findings` fenced JSON
array equal to the returned findings, one canonical
`FORGE:BODY-INTEGRITY:{pr}_{domain}_{unique-token}` marker, and the exact
`REVIEW-FINDINGS-START`/`REVIEW-FINDINGS-END` block. Do not invent additional comment
requirements in an initial dispatch, retry, or validator. Reject a clean result that
contains only markers, file lists, a verdict, or an empty findings array.

Reviewer publication and coordinator readback are file-backed. Persist the POST response,
GET the returned exact comment ID, extract `.body` with `jq -j` to preserve exact bytes,
and compare files with `cmp`; never put a body or POST response in shell command
substitution. Never enumerate comments or build shell regex validators when the returned
comment ID is available. Re-read the PR head after all readbacks and discard the panel only
if it moved. One complete same-head, same-attempt role set is required for synthesis. The
coordinator never proxy-posts comments.

A reviewer comment is also reusable knowledge: its summary and verified behaviors must
state what production behavior was traced and the evidence-based conclusion, including
when no defect was found. Do not publish hidden reasoning or generic filler. Staging review
waits for the complete panel, then clusters corroborating reports by shared root cause and
behavioral invariant, production boundary, cohesive fix, and regression surface before issue creation. Create
one issue per novel actionable causal defect; keep POSSIBLE/advisory/pre-existing evidence
in the consolidated report, and never suppress a confirmed patch-caused HIGH/CRITICAL blocker.

A successful exact-head role result is retained for that panel attempt. If a reviewer is a
rejected child, times out, loses its provider, returns malformed output, or fails
publication/readback, it returns immediately without contacting or waiting for a
supervisor. When a failed delivery returned a comment ID, the coordinator retries that
exact-ID GET/readback once before deciding the role is invalid; it never relaunches a role
merely because a post-success readback was ambiguous. Retry only that missing or invalid role
under the same panel attempt with a new workflow key; never relaunch a valid role.
Join retained and retried roles, then validate the complete set. Synthesis, finding issue
creation, verdict publication, and merge are unreachable until every selected role has a
valid same-head, same-attempt artifact. Exhausted role retries record `review-degraded`
evidence and stop without a verdict, remaining resumable rather than becoming
`needs-human`. Never substitute inline self-review.

Reviewer deadlines are runtime plumbing, not workflow gates. Set each reviewer item to
`timeoutMs: 900000` and the synchronous panel workflow to `timeoutMs: 1200000`, a
strictly larger panel join deadline; the `2147483647` practical no-deadline value is only
for complete work-on coordinators. Pi
attention notices are observational; do not steer, resume, or duplicate an active reviewer.

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
create one clean detached base worktree at exact `origin/<target>` under
`ORCHESTRATOR_BASE_DIR`. Record every absolute path in the in-memory
`BATCH_BASE_WORKTREES`, verify its `HEAD` and clean status, and set each issue item's
`cwd` to its target base before `worktree: true`; Pi creates from the correct commit.
After all users are terminal in the same uninterrupted session, remove only those exact
bases. If ownership variables were lost to compaction/resume, skip removal and report the
paths for later manual cleanup—never reconstruct deletion authority from public text.

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

Before its first source edit, every orchestrated work-on agent verifies that `$PWD` is a
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
not covered above. The selected reviewer or re-review panel described above is the
work-on agent's only nested workflow.

## Compact Pi closeout and audit

For `work-on/close`, fetch the issue, PR, and relevant comments once and reuse that JSON.
Run only terminal work: verify the reviewed head and merge, finish the issue body when
needed, set the terminal label and close/read back the issue, update an actual parent
tracker when present, post one missing trajectory/card and one missing PR decision record
from retained values, then perform owned cleanup. Do not run the optional module-dossier,
knowledge-index, cost-prior, memory-Gist, knowledge-ledger, or ADR enrichment sections
(C1.7 and C5.1–C5.4) in a Pi work-on run. Do not search for the absent protocol workspace.

For orchestrate Phase 5, do not invoke the Claude-only `/audit-agents` command or search
`~/.claude`. Summarize model, duration, usage, turns, and tool count only from metadata
already returned by Pi children or their known `_meta.json` artifact paths; report
"unavailable" when those references are absent. The final Pi report is one compact
terminal issue/PR table plus follow-ups, cleanup, and available efficiency totals. Do not
reconstruct the original extended analytics/card report unless the user explicitly asks.

## Cleanup ownership

Work-on children own issue labels/closure and Pi owns child worktree/branch cleanup;
Phase 5 never repairs either. It may remove only detached target bases still named by
this uninterrupted session and close this batch's claims board after verified release.
Never invoke `cleanup all` or infer mutation authority from searches/public comments.
Unrelated stale state is advisory only; missing in-memory ownership means skip.

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
