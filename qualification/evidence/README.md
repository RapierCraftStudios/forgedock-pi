# Sanitized qualification evidence

This directory records sanitized qualification without raw Pi transcripts. Most
folders contain disposable local replay evidence. `review-pr-performance-20260928/`
is a retrospective, read-only diagnostic of an already-completed remote review, two
prior partial disposable native attempts, and one later corrective native attempt; it
contains timings, outcome identities, and sanitized results only. The tooling correction
made no new AlterLab writes.

- `runs.json`: redacted run IDs, role/result, usage, duration, and launch boundary.
- `owner-replay.*`: successful single-issue owner/reviewer trial.
- `orchestration-first-pass.*`: true dependency ordering and the preserved first-pass blocker.
- `orchestration-repair.md` and `repaired-render.diff`: bounded same-role repair and scoped re-review.
- `intake-repeatability.*`: fresh-session, same-path idempotent intake result.
- `replacement-rollback.*`: disposable same-repository Git-ref replacement and restoration.
- `report-delivery-recovery-20260923/`: sanitized original specialist key-mismatch evidence and one controlled bare-command model exercise with exact role/run/report identities, first-publication failure, role-only recovery, adjudication, and gate result. No live AlterLab/GitHub writes or raw reviewer bodies are included.
- `review-pr-performance-20260928/`: retained-run latency/root-cause analysis, preserved setup/launcher failures, two partial one-role native attempts (the second was an unintended duplicate), one corrective native GATED/FAIL attempt with check-order/runtime-artifact limitations, and deterministic sequence/event-hook coverage; all used fake GitHub only, while historical AlterLab panel/gate links are read-only references.

Local commits and replay markers are not GitHub delivery. The retrospective report references an already-completed remote review; it does not claim any remote activity performed by this correction or its disposable exercise.
