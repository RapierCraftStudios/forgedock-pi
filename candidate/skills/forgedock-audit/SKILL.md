---
name: forgedock-audit
description: Reconstruct one candidate run or report directory into compact evidence-backed findings
---

# ForgeDock audit

Read only the exact run/report path supplied by the operator. Use native run identities,
status, saved reports, source/config identity, and timestamps; do not infer an issue or
production exposure from a heuristic. Preserve disagreements and unknowns. Do not edit source,
GitHub state, labels, issues, merges, or deployment. Return compact findings with the exact
missing evidence and distinguish terminal failure from successful delivery.
