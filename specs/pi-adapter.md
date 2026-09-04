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
- Legacy runtime/tool/model prose in archived specifications never overrides this file.

## Work-on agents

Orchestrate launches the packaged `forgedock-work-on-coordinator`; despite the historical
profile name, it is the sole per-issue work-on agent and writer.

A work-on agent executes investigation, planning, build, quality gates, verification, PR
preparation, remediation, merge, close, and cleanup inline. Before review/re-review it must
not call `subagent`. Any legacy phase `Task(...)`, `Agent(...)`, cache-TTL fork, alternate
runtime, or builder handoff is ignored.

Resolve one full child model from `forge.yaml` `agents.subagent_model`, then
`agents.default_model`. Reject empty or legacy shorthand model names before dispatch. The
work-on agent retains that model for the lifecycle; review tasks add the risk-calibrated
thinking suffix selected by the review skill.

Under orchestration, `$PWD` is the Pi-managed issue worktree. Require clean linked
`pi-parallel-*` state and configured-target ancestry before mutation. Never reset, replace,
or remove the active managed worktree. Standalone work-on creates and later removes at
most one exact retained owned worktree.

## Reviewers

Review roles use fresh ordinary builtin `delegate` agents with full normal tool
availability. Role prompts focus the review and require structured evidence; ForgeDock
does not register a specialized reviewer profile or impose a reviewer capability ceiling.
The owning work-on agent remains responsible for final publication, verdict, remediation,
merge, and closure.

Prepare repository, PR, full head/base SHAs, changed files, deterministic diff bundle,
role/persona, attempt, and invariants once. Embed the bounded diff in each task or pass one
stable readable file path; `runs.host` is not available in raw review workflows and must
not be used for bundle transfer. Launch the complete selected panel with one synchronous
`workflowScript` whose only dispatch is `await runs.all([...])`.

Each item uses:

- a stable role/attempt key;
- `agent: "delegate"`;
- the resolved full model with risk-calibrated thinking;
- `context: "fresh"`;
- `worktree: false`;
- `acceptance: false`;
- `timeoutMs: 900000`.

The panel join deadline is `1200000`. Join all roles before synthesis. A partial panel
cannot publish a verdict or authorize merge. For reviews exceeding three minutes, each
delegate may send at most one concise `contact_supervisor` progress update with role, head,
and current evidence step; do not publish progress to GitHub.

Retain each valid same-head role. Retry only when the child failed or the owning agent
cannot recover a substantive review. Launch one additional workflow containing only that
missing role with a new key under the same attempt. The one-workflow rule applies per
panel/retry dispatch, not the whole review. Never restart a panel for JSON key casing,
number-versus-string identity echoes, equivalent list shapes, or other harmless formatting.

Each delegate may use any normal tool needed for evidence, but its assignment is review,
not implementation or workflow ownership. Bind repository, PR, head/base, attempt, and
role from the launch record. Accept JSON or structured Markdown containing verdict,
qualitative summary, verified `path:line` behaviors, residual risks, and findings; normalize
harmless representation differences in the owner. Publish one consolidated panel comment
and one official verdict with exact-ID readback. Do not require per-role comments,
enumerate all comments, or build shell-regex protocols.

## Base movement and review reuse

A target-branch advance does not invalidate review while the PR head remains unchanged and
GitHub reports it clean and mergeable. Do not rebase solely to make the latest target an
ancestor of the feature head.

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

Fetch each distinct target and create one clean detached base at exact `origin/<target>`.
Set each work-on item's `cwd` to its target base before `worktree: true`; Pi then creates
the isolated issue worktree from the correct commit. Retain exact base paths for final
owned cleanup.

Launch one top-level async `subagent` workflow. When the current tool schema exposes it,
pass `globalConcurrencyLimit` from `orchestration.max_concurrent`; otherwise use and report
the extension's effective limit. Do not set `maxSubagentSpawnsPerRun`: normal review,
remediation, and exact-head re-review must not exhaust an arbitrary per-run launch cap.
Set orchestration control attention thresholds at or above the 1,200,000 ms panel join
window so a healthy concurrent review does not emit a false four-minute stall warning.
Every issue item
uses:

```js
{
  key: `work-on-${issue.number}`,
  agent: "forgedock-work-on-coordinator",
  task: `${issue.number} --under-orchestration`,
  context: "fresh",
  cwd: issue.targetBase,
  worktree: true,
  timeoutMs: 2147483647
}
```

Use one visible promise graph:

```js
function normalizeFailure(error) { return { ok: false, error: String(error) }; }
const a = runs.run("work-on-A", issueA).catch(normalizeFailure);
const b = runs.run("work-on-B", issueB).catch(normalizeFailure);
function lifecycleStatus(result) {
  const text = String(result?.output ?? result?.finalOutput ?? "");
  const match = text.match(/FORGE_WORK_ON_RESULT status=(DONE|GATED|FAILED)/);
  return match?.[1] ?? "FAILED";
}
function launchC(predecessors) {
  if (predecessors.some((result) => !result.ok || lifecycleStatus(result) !== "DONE"))
    return { ok: false, skipped: true, reason: "predecessor did not complete successfully" };
  return runs.run("work-on-C", issueC).catch(normalizeFailure);
}
const c = Promise.all([a]).then(launchC).catch(normalizeFailure);
return await Promise.all([a, b, c]);
```

Generate the same shape from the confirmed DAG. Independent roots start together; each
successor waits only for its actual predecessors, never a whole wave. Normalize every
promise immediately so unrelated lanes settle.

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
