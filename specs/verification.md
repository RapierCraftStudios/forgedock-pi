# Selective repository verification

Use the existing `forge.yaml` `verification.commands` contract. Commands are grouped by
owning component/toolchain, not by a fixed list of supported languages. The agent selects
the relevant checks; existing tools execute them mechanically. Do not create a second
runner, per-PR CI jobs, generated gate frameworks, or a new repository index.

## Learn once, preserve authority

At first setup, discover actual commands from repository-owned package/build manifests,
test configuration, scripts, documented workflows and CI. Retain their working-directory,
pinned-toolchain and environment requirements; commands run from the worktree root.
Do not assume that the presence of a language implies a particular tool or command.
Do not copy CI expressions, credentials, deploy commands or issue/comment text into an
executable configuration. Infer only safe local equivalents with source evidence.

Preserve existing explicit commands and unrelated configuration. Fill missing groups with
unambiguous discovered commands; do not overwrite an override to make a failure disappear.
Store only the useful command catalog and small optional provenance/scope metadata below.
Derive fingerprints mechanically with `git hash-object --no-filters -- <file>`; never
invent them. These fingerprint defining files, not passing-test results.

```yaml
verification:
  commands:
    api:
      lint: "cd services/api && uv run ruff check ."
      test: "cd services/api && uv run pytest tests"
    web:
      test: "cd web && npm test -- --run"
      build: "cd web && npm run build"
  discovery:
    api:
      paths: [services/api/, shared/]
      sources:
        services/api/pyproject.toml: "<actual git blob id>"
    web:
      paths: [web/]
      sources:
        web/package.json: "<actual git blob id>"
```

Examples are not defaults to execute. `discovery` is optional advisory metadata; old
`verification.commands` configurations remain valid. Paths are repository-relative
component/file prefixes, not a dependency graph or proof of complete impact coverage.
Record the relevant manifest, script, CI and toolchain-defining source files actually used.
If source fingerprints change, disappear, or are absent, revalidate only affected groups.
Preserve still-valid overrides; resolve an obsolete/ambiguous command explicitly rather
than silently substituting a different check. Do not rediscover unchanged toolchains.

In orchestration the dispatcher prepares the catalog once before child dispatch, using
configuration/build definitions rather than inspecting product behavior. Save a read-only
JSON snapshot containing only `commands` and `discovery` in the batch's retained local
artifacts, outside clean target bases; compute its SHA-256 after writing. Pass its path and
digest as the adapter's explicit task input to every child. Do not serialize a whole config,
secrets, credentials, or unrelated fields. Retain this small input while lanes may resume.

The prepared catalog is authoritative for verification at route start, including preserved
explicit operator overrides. Execution identity/model/cap come from the bound lane policy in
`mechanical-execution.md`, not a missing or borrowed worktree forge.yaml. The child verifies
the digest and reads this input without copying it over or modifying its owned forge.yaml.
A missing input or digest mismatch must be resolved before executing catalog commands;
request a newly validated input, never silently fall back to stale configuration or history.
Retain the input descriptor across compaction/resume. If defining files or intentionally
issue-owned configuration change, revalidate the affected selection and report the delta;
the snapshot is not permission to overwrite those changes or discard explicit overrides.

Children never edit the canonical configuration outside their cwd. Durable catalog updates
remain dispatcher-owned and separate from issue-source commits; reconcile them after the
relevant merge. Standalone work-on uses its authorized local configuration instead. Preserve
permissions and unrelated values; never print a whole secret-bearing config.

## Select from the actual change

- Start with the changed behavior, paths, imports/callers, production entrypoint and the
  investigator's acceptance contract. The path metadata only supplies initial candidates.
- For each criterion, verify a bounded closure matrix: producer → every reachable consumer/
  caller and invocation mode, transitive imported/sourced dependencies, valid/invalid input,
  fresh/existing state, failure/retry/recovery, cancellation, and applicable concurrency.
  Each row needs a concrete counterexample or behavioral test; string-presence checks cannot
  close runtime rows. An alternate caller or transitive dependency found after admission is a
  contract gap requiring a superseding contract and re-plan before remediation.
- Prefer focused behavioral tests supported by the repository's real test runner. Do not
  append guessed selectors or flags to an arbitrary configured command.
- When impact is uncertain, broaden to the containing component/package suite. Expand
  across components for concrete shared-interface, schema or runtime coupling—not merely
  because another file has the same extension.
- Check production setup and real caller arguments; a fixture must not initialize state
  that production lacks or omit arguments that change validation behavior.
- Test doubles must model the real interface. Do not add production branches solely to
  accommodate obsolete fakes; update the tests unless a real supported caller needs the
  compatibility behavior and the contract proves it.
- Add missing regression coverage to the repository's normal tests. Verify test discovery,
  registration/accounting and applicable CI path filters before claiming that CI covers it.
- Missing required evidence is not PASS. A missing command triggers discovery/clarification,
  not silent success; unsafe or genuinely unavailable proof retains its explicit limitation.

## Order and reuse

Run cheap applicable syntax, formatter, lint/type, focused behavior and CI-wiring checks
before heavyweight builds or full integration environments. Fix those failures and finalize
the relevant build inputs first. Reuse the repository's existing build cache; retain the
resulting image/artifact identity and the actual inputs, options and environment tested.

Do not repeat an expensive successful build merely because review began or a new commit
changed unrelated material. Reuse only when relevant inputs and environment are provably
unchanged—including Dockerfile/build context, ignore rules, dependency locks, build args,
base image identity and toolchain when applicable. If that cannot be established, rerun.
Do not claim a build proves behavior its tests did not exercise.

Respect the approved local/CI resource capacity. Avoid simultaneous heavyweight builds
without demonstrated headroom; use an existing build queue or ordinary host locking when
needed, not another orchestration service. Record resource wait separately without hiding
it from total elapsed time. Owner concurrency is not a host-wide limit on nested reviewers
or build subprocesses.

Keep full logs in local artifacts. Return check names, input/artifact identity, PASS/FAIL/
SKIPPED, affected evidence and concise failure excerpts in the existing build/review record.
Passing evidence is reused by identity, not stored as a permanent green flag in forge.yaml.
