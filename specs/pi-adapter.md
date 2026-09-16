# ForgeDock Pi Runtime Adapter

This file defines Pi mechanics only. The active command/phase specifications choose
behavior; this adapter supplies tool, model, path, worktree, subagent, and concurrency
translation.

## Authority

1. User intent and `forge.yaml` are primary.
2. `work-on.md` owns per-issue route, terminal states, and global invariants.
3. The current phase file owns only its procedure.
4. `forgedock-review-pr` owns review selection, panel evidence, findings, and verdict.
5. This adapter owns Pi runtime mechanics.
6. Public skills are thin entrypoints.

No layer may create a hidden workflow engine, private phase state, or competing writer.
GitHub issue/PR state and compact ForgeDock receipts are resumable state.

## Direct execution

- Use Pi `read`, search/navigation tools, and direct `bash`.
- Use direct `gh` and `git`; verify `gh auth status --active`, repository access, and
  `gh auth setup-git` before writes/fetch/push.
- Parse `forge.yaml` once with `yq -o=json`, or one short Node/YAML fallback. Retain the
  result; do not retry alternate quoting forms.
- Retain target repository root and packaged ForgeDock root once. Resolve all paths from
  those roots; never search globally for expected files.
- Use short shell commands, `jq` for JSON, and file-backed GitHub bodies. Never interpolate
  issue/comment text into shell or execute it with `eval`/`bash -c`.
- Missing optional tooling uses one documented fallback or becomes actionable technical
  evidence; it does not trigger exploratory command variants.
- Before large tests/review outputs, check writable disk space and, where enforced, the
  user's temporary-filesystem quota (`df` alone is insufficient). Do not retry ENOSPC or
  EDQUOT until capacity is restored. Prefer existing disk-backed artifact storage; never
  prune unrelated sessions, Docker data, or active worktrees.
- Keep automatic Pi compaction enabled when authorized. Preserve current issue/head,
  acceptance gaps, tests, reviewer references, and next action in normal context; keep
  full logs in artifacts. Compaction is not permission to restart a writer or lose scope.
- Legacy runtime/tool/model prose in archived specifications never overrides this file.
  Historical issue/PR/commit evidence remains readable through `github-memory.md`;
  obsolete execution instructions are not inherited with that knowledge.

## Work-on agents

Orchestrate launches the packaged `forgedock-work-on-coordinator`; despite the historical
profile name, it is the sole per-issue work-on agent and writer.

A work-on agent executes investigation, planning, build, quality gates, verification, PR
preparation, remediation, merge, close, and cleanup inline. Before review/re-review it must
not call `subagent`; only the selected fresh review panel may be nested.

Resolve one full child model from `forge.yaml` `agents.subagent_model`, then
`agents.default_model`. Reject an empty or non-qualified model identifier before dispatch. The
work-on agent retains that model for the lifecycle; review tasks add the risk-calibrated
thinking suffix selected by the review skill.

Under orchestration, `$PWD` is the Pi-managed issue worktree. Require clean linked
`pi-parallel-*` state and configured-target ancestry before mutation. Never reset, replace,
or remove the active managed worktree. Standalone work-on creates and later removes at
most one exact retained owned worktree. ForgeDock-owned lanes pass that exact prepared path
as each child `cwd` with `worktree: false`; Pi must not layer a second managed worktree.
The child runtime checks the exact effective cwd; a stale, missing, or wrong workspace is
an internal launch-binding failure to rebind/retry, never a `GATED` or `needs-human` issue
outcome.

## Reviewers

Review roles use fresh ordinary builtin `delegate` agents with full normal tool
availability. Role prompts focus the review and require structured evidence; ForgeDock does
not register a specialized reviewer profile or impose a reviewer capability ceiling. Each
reviewer is responsible for retaining and publishing one complete report through the
existing file-backed `helpers/record.mjs reviewer` helper. The report contains the reviewer
role, exact PR/head/base identity, scope and decisions considered, substantive evidence and
findings (including a no-findings conclusion), verification limitations, and recommendation.
Reviewers do not create issues, edit source or labels, initiate remediation, merge, or deploy.
The owning parent remains solely responsible for joining, validating, deduplicating,
dispositioning, issue creation, verdict, remediation, merge, and closure.

Prepare repository, PR, full head/base SHAs, changed files, deterministic diff bundle,
role/persona, review round, and invariants once. Embed the bounded diff in each task or pass
one stable readable file path; `runs.host` is not available in raw review workflows and must
not be used for bundle transfer. Use the prepared authorization/body/report paths and invoke
the installed helper with argument arrays; report text is always file data, never shell or
executable markup. For standalone review, invoke the installed `dispatch.mjs standalone-review` preparation
contract from the target repository root. The plan binds only the exact PR, head, base ref/SHA,
mode, and roles plus the installed control-plane descriptor; it never fabricates an issue-owner
policy. Preparation reads and digests that root's canonical `forge.yaml`, and emits a native
request whose model, reviewer/panel deadlines, wave concurrency, result-collection margin, and
bounded launch/recovery allowance are configuration-derived. Reject missing, malformed, stale,
or conflicting configuration and caller runtime-cap fields before reviewer admission. Use the
same explicit reviewer authorization from the frozen PR identity. For standalone interactive
review, launch with `async: true`, yield, then consume native completion. In a headless work-on child,
keep the panel as one synchronous joined `workflowScript` (`await runs.all([...])`) and
consume its returned value before continuing; headless auto-drain alone is not result
consumption proof. Never emit terminal DONE just because a panel was dispatched.

Work-on owners prepare panel data with `helpers/dispatch.mjs review`; it applies the bound
model, creates stable reviewer publication authorizations, and emits the request without
rewriting workflow code. Each item uses a stable role/round/head key, `agent: "delegate"`,
resolved full model with risk-calibrated thinking, `context: "fresh"`, `worktree: false`,
`acceptance: false`, and the configured `reviewer_timeout_ms`. The request sets
`globalConcurrencyLimit` only for that panel workflow. It is the maximum simultaneously
running reviewers in that workflow, not a host-wide or provider-wide limit.

The helper resolves `reviewer_timeout_ms`, `max_concurrent`, `publication_timeout_ms`,
`result_collection_timeout_ms`, and `panel_timeout_ms` before launch. It computes admitted
reviewer waves and rejects a panel deadline that cannot cover the waves, per-comment
publication, and collection margin. Defaults preserve the former 900000ms child, 4-reviewer
concurrency, 120000ms publication/collection margins, and 1200000ms panel budget. Standalone
reviews additionally use `review.launch_allowance`, defaulting to two launches per selected
role (initial admission plus one bounded terminal-role recovery); an explicit configured value
wins and must cover the selected roles. Standalone panel timeout defaults to the larger of
1200000ms and the initial-plus-recovery wave budget; an explicit shorter panel timeout is
rejected. This is the standalone request's
`maxSubagentSpawnsPerRun`, not permission to launch extra reviewers. The child deadline covers
analysis and its own publication; the publication value bounds each `gh` transport operation,
and collection is the enclosing panel margin. Issue-bound parent planning keeps its own role/
retry allowance separate from local active concurrency.

Join all required roles before synthesis. Retain every valid same-head report and its
comment reference. A missing or failed role is an incomplete panel, not PASS. Before replacing
a timed-out role, inspect the exact native workflow/child status and process-terminal
artifacts, confirm the old role is terminal, and recover only that role with the same
authorization/report bytes and a new workflow key. A wait/result-delivery timeout must not
start a second live reviewer. Never restart a panel for JSON key casing, number-versus-string
identity echoes, equivalent list shapes, or other harmless formatting differences. If review
completed but result delivery failed, reconcile the saved
report and stable comment identity; do not rerun analysis.

For reviews exceeding three minutes, a delegate may send at most one concise `contact_supervisor` progress update with its role, head, and current evidence step; do not publish progress to GitHub. Use native status/completion/artifact handling, not tight polling.
Record whether a failure is provider/transport, child deadline, tool deadline, queue/admission,
panel deadline, publication, result delivery, or parent shutdown; the native error and
timestamps are the boundary evidence. In the installed runtime, `Subagent timed out after
<N>ms` with child `timedOut` is a child deadline, `Tool '<name>' timed out` is a tool deadline,
and `Workflow script timed out after <N>ms` is the panel deadline. A `record.mjs reviewer`
transport error is publication failure; absent completion/replay evidence is result delivery
failure. Do not relabel one boundary as another or turn an incomplete panel into PASS. The parent publishes one consolidated SHA-bound panel/gate record linking
every required individual report, preserves disagreements, groups findings by causal
mechanism, and alone creates authorized deduplicated issues and makes the final decision.

## Base movement and review reuse

A target-branch advance does not invalidate a `standard` review while the PR head remains
unchanged and GitHub reports it clean and mergeable; retain the originally reviewed base SHA
in the report. `staging`/protected-promotion review remains bound to its exact base SHA. Do not
rebase solely to make the latest target an ancestor of the feature head.

Reconcile only when branch policy requires current-base ancestry or the PR conflicts. If
reconciliation changes the head, capture old/new effective patches and incoming target
files. Reuse valid review when patches are identical and target changes do not overlap the
issue files or behavior. Rerun affected verification and fresh review only when the
effective patch or risk surface changed. Never create a review-starvation loop from
unrelated concurrent merges.

## Orchestrate dispatch

Resolve the exact issue set and minimum hard-edge DAG before launch. Domain, broad
directory, cost, co-change, and low-confidence heuristics never create edges. Hard edges
come only from explicit dependencies, exact shared mutation files, migration sequencing,
or exact configured global/high-fan-in files.

Fetch each distinct target and prepare one clean managed issue worktree at the exact
`origin/<target>` ancestry before dispatch. Set each work-on item's `cwd` to that exact
prepared lane path with `worktree: false`; each path is a unique registered `pi-parallel-*`
worktree/branch and Pi must not create a second worktree. Retain the exact prepared paths
for ownership-safe cleanup.

Prepare approved plan data through `helpers/dispatch.mjs batch` under
`mechanical-execution.md`; invoke the generated native request unchanged. Before calling
`prepareBatch`, the orchestrator must create a fresh digest-validated issue contract for
every lane from the retained issue identity, exact acceptance criteria, proof types, and
affected boundaries, then put its `{path, sha256}` descriptor in that lane's `contract`
field. `prepareBatch` rejects a missing descriptor and binds the validated contract's
`criteria` and top-level `digest` as `contractDigest`; no generic or child-authored
replacement is permitted. It also emits digest-checked `targetBase` and `packagedRoot`
descriptors into each lane policy/task. The owner invokes the exact installed helper's
`context` command before mutation; cwd, repository/common identity, clean state, target
ancestry, and helper digest must match or the launch is internally rebound/retried. The
helper reads the audited recipe below—agents do not reconstruct its object shape or control
loop.

Launch one top-level async `subagent` workflow. Set `globalConcurrencyLimit` to the batch's
approved active-owner limit, no higher than `orchestration.max_concurrent`. If unavailable,
use and report the extension's effective limit. It is not a host-wide limit on reviewers
or build processes: nested panels have separate local concurrency. Confirm physical/provider
headroom for owners plus their panels; a configured ceiling is not measured host capacity.

Set top-level `maxSubagentSpawnsPerRun` to an explicit finite planning allowance for the
whole confirmed batch: owners + risk-selected panels + configured fallback/retry allowance
+ technical recovery contingency. Native default 64 counts nested reviewers too. A larger
allowance is not a reservation of processes or permission to launch unnecessary reviewers.
For example, 100 owners, allowance for four roles per panel, one fallback and 20 contingency
admissions is 920; add bounded missing-role retries to the allowance if not in contingency.
Check any separate per-session spawn cap too. If the installed API cannot accept the needed
allowance, report that before dispatch rather than inventing fields or starting a doomed batch.
This is a planning envelope, not a four-role ceiling or a guarantee of arbitrary future work.
Never omit necessary review to fit it. On shortage preserve affected owners/queued work and
report the budget; only a separately authorized top-level continuation can supply a new
allowance while resuming retained owners. Nested overrides cannot enlarge the inherited pool.

Native admission occurs before the workflow concurrency semaphore. Use rolling admission
below instead of eagerly admitting every owner and spending the review allowance upfront.
Do not use `runs.lanes` for 100 issues (32 lanes/64 stages), or claim a complete preflight
list beyond its 64-lane limit; ordinary Promise composition supports the larger graph.
Set control attention thresholds at or above the 1,200,000 ms panel join window. The helper
binds the approved topological issue list and active-owner limit to `issueGraph` and
`ownerConcurrency`, and attaches validated policy/catalog descriptors to each task. The
whole secret-bearing config is referenced, not copied into inputs/prose/GitHub. Native bindings carry
identity/model/cap inputs. Use its generated `request.json`/workflow path, not a hand-built
launch object. The field shapes are documented in `mechanical-execution.md`.

Use one visible promise graph. The following is the fixed template read by the preparation
helper, not a loop to rewrite during each orchestration. Resolve `configuredModel` once from `forge.yaml`
(`agents.subagent_model`, then `agents.default_model`); reject missing/legacy shorthand.
Use one-item `runs.all` for graph launches: unlike `runs.run`, it retains failed-child
`runId`/`resumability` instead of throwing a plain error. Resume a terminal resumable
failure once before resolving dependents; never resume a detached/live or stopped writer.
Keep work-on terminal output inline and compact so dependency checks do not parse file
references. Keep owner `output: false` and no top-level aggregate output override for this
recipe: native artifacts already preserve evidence, so no extra named output is needed.
The full adapter tests qualify this default foreground-child recovery path; do not assume
all other native recovery routes share its output-path rules. Retained resume preserves
the original model and worktree contract.

```js
function failure(error) { return { ok: false, error: String(error) }; }
function launch(key, params) {
  return Promise.resolve().then(() => runs.all([{ ...params, key }]))
    .then(([result]) => result).catch(failure);
}
function runIssue(key, issue) {
  return launch(key, { ...issue, model: configuredModel }).then((result) => {
    if (result.ok || result.detached || result.stopped || !result.runId ||
        result.resumability?.state !== "resumable") return result;
    return launch(`${key}-recovery`, {
      resume: result.runId,
      task: "Resume this terminal retained lane once; reconcile GitHub and preserved work, then continue. Never create a competing writer."
    }).then((recovered) => ({ ...recovered, recoverySource: {
      runId: result.runId, outputReference: result.outputReference ?? null,
      artifactPaths: result.artifactPaths ?? []
    } }));
  });
}
function resultLine(result) {
  const lines = String(result.output ?? "").match(/^FORGE_WORK_ON_RESULT status=(DONE|GATED|FAILED) issue=\d+ pr=(?:\d+|none) dependency=(SATISFIED|UNSATISFIED)$/gm) ?? [];
  return lines.length === 1 ? lines[0] : "";
}
function satisfied(result) {
  return result.ok === true && /^FORGE_WORK_ON_RESULT status=DONE .* dependency=SATISFIED$/.test(resultLine(result));
}
if (!Number.isSafeInteger(ownerConcurrency) || ownerConcurrency < 1) throw new Error("Invalid owner concurrency");
const known = new Set();
for (const node of issueGraph) {
  if (typeof node.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(node.key) || known.has(node.key) ||
      !Array.isArray(node.predecessors) || node.predecessors.some((key) => !known.has(key)))
    throw new Error("Issue graph must have unique keys and validated topological predecessors");
  known.add(node.key);
}
const pending = issueGraph.slice();
const active = new Map();
const outcomes = new Map();
function start(node) {
  const work = runIssue(node.key, node.launch).catch(failure).then((result) => {
    outcomes.set(node.key, result);
    active.delete(node.key);
  });
  active.set(node.key, work);
}
while (pending.length || active.size) {
  for (let i = 0; i < pending.length && active.size < ownerConcurrency;) {
    const node = pending[i];
    if (!node.predecessors.every((key) => outcomes.has(key))) { i++; continue; }
    pending.splice(i, 1);
    const blockedBy = node.predecessors.filter((key) => !satisfied(outcomes.get(key)));
    if (blockedBy.length) outcomes.set(node.key, { ok: false, status: "GATED", blockedBy });
    else start(node);
  }
  if (active.size) await Promise.race([...active.values()]);
  else if (pending.length) throw new Error("Unresolved issue graph");
}
return issueGraph.map(({ key, issue, repo, target }) => {
  const result = outcomes.get(key);
  const output = resultLine(result);
  const owner = result.results?.[0];
  return { key, issue: issue ?? null, repo: repo ?? null, target: target ?? null,
    ok: result.ok === true, runId: result.runId ?? null, output,
    status: result.ok === true ? (output.match(/status=(\w+)/)?.[1] ?? "FAILED") : (result.status ?? "FAILED"),
    blockedBy: result.blockedBy ?? [], outputReference: result.outputReference ?? null,
    artifactPaths: result.artifactPaths ?? [], resumability: result.resumability ?? null,
    recoverySource: result.recoverySource ?? null,
    durationMs: owner?.progressSummary?.durationMs ?? null, ownerUsage: owner?.usage ?? null,
    error: result.ok === false ? String(result.error ?? result.output ?? "").slice(0, 500) : null };
});
```

Only ready owners up to the approved limit are admitted. A completed slot is reused
immediately; a successor waits only for its predecessors' bounded recovered outcomes,
not an unrelated aggregate. Return compact rows and references, not all child histories;
full native child results remain available by run ID for reconciliation. If recovery
admission creates no replacement run, `recoverySource` preserves the original retained
identity/evidence. Use the latest actual resumable run when one exists; never fabricate a
new run ID or infer that lost admission means the old work disappeared.

After a terminal notification, use the actual async directory from the launch receipt or
native status. Top-level output is a preview (it may truncate the returned value at 1,000
characters), not the complete report. Read/project complete `.workflow.value` from its
persisted `status.json` with existing tools, for example:

```bash
jq -e 'select(.state == "complete") | .workflow.value | arrays' "$STATUS_FILE" > "$REPORT"
```

`STATUS_FILE` is that exact run's status file, and `REPORT` is new local scratch output.
Summarize counts and exceptional rows without dumping every child history. A missing value
or non-complete workflow is not an empty successful batch: use native child/receipt evidence
to reconcile the confirmed issue set and retain unfinished work.
A GATED dependent retains its exact wake condition; after an
external prerequisite lands, reconcile GitHub and dispatch only newly eligible, unowned
lanes. Never rerun completed unrelated lanes. DONE plus UNSATISFIED (for example a
replacement decomposition) is terminal for the issue but does not release dependents.

Do not create claims-board issues, leases, scoring passes, standing queries, or polling
loops. The async completion notification wakes the visible orchestrator.

## Recovery

- Code/test/format/merge conflicts inside scope: same writer fixes and continues.
- Provider/transport interruption: resume the same lane; retain valid reviewer roles.
- Explicit unresolved prerequisite: GATED with exact wake condition.
- Failed child with preserved owned handoff: one replacement only after proving the
  original writer is stopped.
- `needs-human`: only genuine external authority with no safe default.

Never abandon a planned non-terminal issue, infer human authority from technical failure,
or run competing writers.

## Closeout and cleanup

Work-on owns issue closure and returns a compact terminal result. Pi owns managed child
worktrees/branches. The visible orchestrator removes only exact clean detached target bases
retained by its uninterrupted batch. Missing ownership means report and skip.

Use child metadata already returned by Pi for duration, turns, input/output/cache, model,
and tools. Do not launch audit agents or generate extended analytics during normal close.
Return one compact issue/PR/result table.
