---
name: forgedock-orchestrate
description: Resolve a bounded issue set and dispatch one owner per issue through native Pi subagents
---

# ForgeDock orchestrate

The visible session is the dispatcher, never a product-code writer. It resolves one issue set,
prepares a concise plan, launches one owner per admitted issue, and reconciles outcomes. Owner
investigation and mutation plans stay inside each owner.

## Resolve and prepare once

1. Parse the selector and select one trusted delivery mode before preparation. Use
   `--delivery-mode github` for the normal GitHub-style issue/PR/review/record lifecycle (including
   an explicitly authorized isolated fake-GitHub fixture); use `--delivery-mode local-replay` only
   when no GitHub publication is intended. `--issues-file` selects issue data and never selects
   delivery mode. When the launcher supplies `FORGEDOCK_CANDIDATE_DELIVERY_MODE`,
   `FORGEDOCK_CANDIDATE_OWNER_AUTHORITY_FILE`, or `FORGEDOCK_CANDIDATE_DISPATCH_ISSUES_FILE`,
   pass those exact values to the helper; do not reconstruct them from prose or issue data. Use
   `"$FORGEDOCK_CANDIDATE_BIN" prepare-dispatch --selector <selector> [--issues-file <path>]
   --delivery-mode <mode> [--owner-authority-file <path>] --cwd "$PWD" --out <run-dir>` so pagination, original bodies,
   acceptance text, repository identity, target, verification catalog, and source/config identities
   are captured once. `deliveryMode` selects workflow semantics only; it does not grant publication
   or merge authority. When fresh owners need explicit operation authority, pass its exact one-line
   user-granted scope in `--owner-authority-file <path>`; never derive or widen it from issue data.
   Keep `<run-dir>` under the existing candidate artifact root or another unique directory outside
   `$PWD`; the helper rejects explicit source-checkout output paths. Never write dispatcher logs,
   launch inputs, or parent evidence into the clean preparation checkout.
2. Before admitting any issue, query the supported native boundary (`subagent({ action:
   "status" })`) and correlate it with exact issue/worktree evidence. Also use the helper's
   live-worktree check. An ambiguous or unavailable match is surfaced/gated for that issue; do
   not perform broad process/session archaeology or treat a phase label as proof. A readable
   issue body without the rigid heading is retained as unstructured acceptance for the owner;
   only an empty/unreadable body is gated.
3. Build only real ordering: explicit dependency markers, exact shared declared mutation files,
   migration order, or exact configured global/high-fan-in files. Domains, directories,
   keywords, uncertainty, and cost guesses never create edges. Do not add a broad CI investigation
   or promote feature-PR checks from a promotion workflow; owners resolve PR-specific policy after
   a head exists. Confirm the small plan before launching when required by operator policy.

## Native dispatch

Run the generated request from `<run-dir>/request.json` through the installed `subagent` tool.
The request is a supported `workflowScriptPath`, uses fresh `forgedock-owner` children in
isolated native worktrees, and admits at most two owners during qualification. It uses rolling
admission: only ready issues consume owner slots; a successor waits for the predecessor's
exact `FORGE_WORK_ON_RESULT ... dependency=SATISFIED` line. A failed/gated predecessor does not
release its successor, while unrelated ready issues continue.

The generated request has a finite owner/review/recovery allowance and keeps each child on the
same candidate/native package configuration. Each owner must use the normal work-on label and
record hooks; the dispatcher does not synthesize missing issue history. If an owner returns
`detached`, retain its exact run ID and capacity slot; report `WAITING`, not `FAILED`, and do not
admit a dependent or fill that slot. Reply to its pending supervisor request only within the
parent's authority, then use one bounded
`subagent_wait({ id: runId, timeoutMs: 1800000, stopOnAttention: false })` on that exact run and
read its terminal `subagent({ action: "status", id: runId })` result. Never resume an active
detached writer or launch a replacement. Preserve the exact initial `workflow.value` result array. After native wait/status
confirms each detached run is terminal, create a continuation input with schema
`forgedock.candidate-dispatch-continuation/v1`, the unchanged `initialResults` array, and one
`terminalResults` row per detached owner (`issue`, exact same `runId`, terminal `nativeStatus`, owner
`status`, `ok`, `dependency`, exact marker `output` when completed, and native `error` when failed).
Copy the terminal marker from that run's status; never reconstruct it. Use
`continue-dispatch --plan <run-dir>/plan.json --results <continuation-input.json> --out <new-dir>`
to validate the original graph and generate a workflow seeded with settled owners; run only that
request in this same dispatcher session. A `DONE/SATISFIED` owner may release its dependent,
while `GATED/UNSATISFIED` keeps it blocked. If the native wait expires or exact status is unavailable,
keep the bounded `WAITING` result and do not generate a continuation. This is not a second
coordinator or a manual owner launch. A terminal retained technical owner may be resumed
once after actual native termination is confirmed only for transport recovery of that same owner.
Do not launch a second coordinator, investigation, builder, quality gate, or remediation agent.

## Reconcile

Use the exact native workflow result/run identities and compact owner lines, not child index or
transport success. Normalize only a terminal native result's `ok` state plus exactly one
validated owner marker for the expected issue: `DONE/SATISFIED`, `GATED/UNSATISFIED`, and
`FAILED/UNSATISFIED` remain distinct. A detached run is nonterminal and remains `WAITING`; neither
it nor its dependency can be settled from the detach receipt. A completed GATED owner is not a failed execution and must not be resumed; a native failure with a misleading marker remains failed. Preserve
failed/interrupted work and exact wake conditions. After an owner returns, discover its issue
records and current labels once; a missing required terminal record or label is a visibility
failure, not permission for the dispatcher to invent a replacement.
A missing result or incomplete review is not success. Work-on owns PR review, decision, merge,
closure, labels, and records; the dispatcher only unblocks genuine dependencies and cleans only
native-owned clean worktrees after terminal evidence. Do not create claims boards, leases,
ledgers, telemetry, recursive blocker issues, or automatic follow-up admission.

Report request-to-first productive work, acceptance/first-pass review, owner/reviewer usage and
waits where native data provides them. Distinguish implemented, tested, installed, and live
GitHub evidence. Do not restart successful unrelated lanes because another lane failed.
