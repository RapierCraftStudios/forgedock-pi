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
- `release-closeout-20260924.md`: fixed-scope isolated-candidate results for `/review-pr`, `/work-on`, and `/orchestrate`, with the final NOT READY decision and sanitized timing/intervention/delivery summary.
- `release-closeout-20260924-evidence.md`: decisive sanitized issue-create, adapter-preflight, launch-lock, native workflow, owner/reviewer, gate, test, final-state, and separate duplicate-admission excerpts.

No file in this directory claims **live** GitHub issue, PR, comment, merge, or
closure activity. The release-closeout entrypoint results use local fake-GH state
and local bare Git only; they are explicitly not live GitHub signals.
