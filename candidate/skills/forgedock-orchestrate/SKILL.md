---
name: forgedock-orchestrate
description: Resolve a bounded issue set and dispatch one owner per issue through native Pi subagents
---

# ForgeDock orchestrate

The visible session is the dispatcher, never a product-code writer. It resolves one issue set,
prepares a concise plan, launches one owner per admitted issue, and reconciles outcomes. Owner
investigation and mutation plans stay inside each owner.

## Resolve and prepare once

1. Parse the selector once. Use `"$FORGEDOCK_CANDIDATE_BIN" prepare-dispatch --selector <selector>
   --cwd "$PWD" --out <run-dir>` so pagination, original bodies, acceptance text, repository
   identity, target, verification catalog, and source/config identities are captured once. Keep
   `<run-dir>` under the existing candidate artifact root or another unique directory outside
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
record hooks; the dispatcher does not synthesize missing issue history. A terminal retained
technical owner may be resumed once after actual native termination is confirmed. This is
transport recovery, not a new writer. Do not launch a second coordinator, investigation,
builder, quality gate, or remediation agent.

## Reconcile

Use the exact native workflow result/run identities and compact owner lines, not child index or
transport success. Normalize only the completed native result's `ok` state plus exactly one
validated owner marker for the expected issue: `DONE/SATISFIED`, `GATED/UNSATISFIED`, and
`FAILED/UNSATISFIED` remain distinct. A completed GATED owner is not a failed execution and
must not be resumed; a native failure with a misleading marker remains failed. Preserve
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
