---
name: forgedock-audit
description: Reconstruct one native ForgeDock run or persisted run directory into evidence-backed findings.
---

# ForgeDock Audit

Load `../../specs/pi-adapter.md` once, then execute `../../specs/original/commands/audit.md`.
The audit is read-only: it may inspect the target repository, native run artifacts, and
GitHub evidence, but it never edits pipeline code, changes labels, creates issues, grants
merge authority, deploys, or merges. Use the exact run input supplied by the user; never
infer an issue, repository, path, descendant, or production exposure from a heuristic.

Return both the stable machine-readable JSON and concise human-readable Markdown required
by the command specification. Preserve source disagreements and unknowns rather than
normalizing them into a successful result.
