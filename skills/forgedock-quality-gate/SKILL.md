---
name: forgedock-quality-gate
description: Run the original ForgeDock whole-change quality gate and return findings to the current builder for bounded remediation before commit or re-review.
---

# ForgeDock Quality Gate

1. Read `../../specs/pi-adapter.md` completely.
2. Read `../../specs/original/commands/quality-gate.md` completely in bounded chunks.
3. Run the gate against the worktree and changed files supplied in the invocation.
4. Return findings to the builder. Do not own phase transitions, GitHub workflow state,
   merge decisions, or issue closure.
5. Re-run the complete gate after fixes, respecting the original bounded iteration cap.
