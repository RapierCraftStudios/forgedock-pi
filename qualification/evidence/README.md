# Sanitized qualification evidence

This directory records disposable local qualification without raw Pi transcripts.
The replay fixtures and scripts in the repository are the launch inputs; these
files preserve the result identities and material observations needed to audit
the runs.

- `runs.json`: redacted run IDs, role/result, usage, duration, and launch boundary.
- `owner-replay.*`: successful single-issue owner/reviewer trial.
- `orchestration-first-pass.*`: true dependency ordering and the preserved first-pass blocker.
- `orchestration-repair.md` and `repaired-render.diff`: bounded same-role repair and scoped re-review.
- `intake-repeatability.*`: fresh-session, same-path idempotent intake result.
- `replacement-rollback.*`: disposable same-repository Git-ref replacement and restoration.
- `report-delivery-recovery-20260923/`: sanitized original specialist key-mismatch evidence and one controlled bare-command model exercise with exact role/run/report identities, first-publication failure, role-only recovery, adjudication, and gate result. No live AlterLab/GitHub writes or raw reviewer bodies are included.

No file in this directory claims GitHub issue, PR, comment, merge, or closure
activity. Local commits and replay markers are explicitly non-GitHub signals.
