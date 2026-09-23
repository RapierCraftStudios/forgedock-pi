# Report-delivery recovery evidence

This sanitized bundle records the original specialist key-mismatch failure and one corrected bare-command exercise against an isolated `example/product` fixture. It intentionally excludes reviewer bodies, raw auth keys, credentials, and raw Pi transcripts.

- `RESULT.md`: scope, original cause, model outcome, setup failures, and validation status.
- `original-failure.json`: frozen AlterLab identity, key-class comparison, terminal evidence, error, and provenance digests; no target comment was modified.
- `model-exercise.json`: exact disposable PR identity, configured model/runtime/deadlines, native role/run/report identities, recovery result, adjudication/gate, and controlled-transport counts.

The model exercise's fake `gh` and local Git shim never contacted GitHub. Raw local model artifacts are not part of the package; the sanitized IDs/hashes in `model-exercise.json` are sufficient to review the reported flow and are not live report authorization keys.
