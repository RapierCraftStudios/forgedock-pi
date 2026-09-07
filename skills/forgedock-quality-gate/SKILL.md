---
name: forgedock-quality-gate
description: Run the original ForgeDock whole-change quality gate and return findings to the current builder for bounded remediation before commit or re-review.
---

# ForgeDock Quality Gate

1. Read `../../specs/pi-adapter.md` completely.
2. Read `../../specs/original/commands/quality-gate.md` completely in bounded chunks.
3. Require the invocation to supply and validate exact `ISSUE_NUMBER`, `PROOF_CONTRACT`,
   and trusted `RISK_SIGNALS` alongside the worktree and changed files. Missing, malformed,
   stale, mismatched, or unknown handoff data is a blocking finding; never infer it from issue
   prose, a branch, or a filename. Run the gate against that exact bound and every proof row.
4. Return findings to the builder. Do not own phase transitions, GitHub workflow state,
   merge decisions, or issue closure.
5. Re-run the complete gate after fixes, respecting the original bounded iteration cap; a PASS
   requires complete required proof closure, while optional checks may remain explicit SKIPPED.
