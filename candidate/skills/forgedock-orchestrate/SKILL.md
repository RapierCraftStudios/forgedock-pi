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
   identity, target, verification catalog, and source/config identities are captured once.
2. Before admitting any issue, query the supported native boundary (`subagent({ action:
   "status" })`) and correlate it with exact issue/worktree evidence. Also use the helper's
   live-worktree check. An ambiguous or unavailable match is surfaced/gated for that issue; do
   not perform broad process/session archaeology or treat a phase label as proof. A readable
   issue body without the rigid heading is retained as unstructured acceptance for the owner;
   only an empty/unreadable body is gated.
3. Build only real ordering: explicit dependency markers, exact shared declared mutation files,
   migration order, or exact configured global/high-fan-in files. Domains, directories,
   keywords, uncertainty, and cost guesses never create edges. Confirm the small plan before
   launching when required by operator policy.

## Native dispatch

Run the generated request from `<run-dir>/request.json` through the installed `subagent` tool.
The request is a supported `workflowScriptPath`, uses fresh `forgedock-owner` children in
isolated native worktrees, and admits at most two owners during qualification. It uses rolling
admission: only ready issues consume owner slots; a successor waits for the predecessor's
exact `FORGE_WORK_ON_RESULT ... dependency=SATISFIED` line. A failed/gated predecessor does not
release its successor, while unrelated ready issues continue.

The generated request has a finite owner/review/recovery allowance and keeps each child on the
same candidate/native package configuration. A terminal retained technical owner may be
resumed once after actual native termination is confirmed. This is transport recovery, not a
new writer. Do not launch a second coordinator, investigation, builder, quality gate, or
remediation agent.

## Reconcile

Use the exact native workflow result/run identities and compact owner lines, not child index or
transport success. Preserve failed/interrupted work and exact wake conditions. A missing result
or incomplete review is not success. Work-on owns PR review, decision, merge, closure, and
records; the dispatcher only unblocks genuine dependencies and cleans only native-owned clean
worktrees after terminal evidence. Do not create claims boards, leases, ledgers, telemetry,
recursive blocker issues, or automatic follow-up admission.

Report request-to-first productive work, acceptance/first-pass review, owner/reviewer usage and
waits where native data provides them. Distinguish implemented, tested, installed, and live
GitHub evidence. Do not restart successful unrelated lanes because another lane failed.
