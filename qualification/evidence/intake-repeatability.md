# Intake repeatability

The candidate CLI preparation test invokes the same `prepare --issue ... --issue-file ... --out issue-N.json` command twice. The second invocation reuses the immutable record and preserves `preparedAt`; a changed issue body allocates a digest/run-scoped sibling and records `supersedes` instead of overwriting the first record.

The fresh owner replay also ran through a new Pi session with the same candidate helper and retained the complete issue body, decision reference, source identity, and review inputs. GitHub publication remained disabled.
