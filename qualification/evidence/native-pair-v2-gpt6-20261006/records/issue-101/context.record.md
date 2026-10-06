<!-- FORGE:CONTEXT -->
<!-- FORGE:RECORD {"v":1,"record_id":"sha256:41c6152f462b1f9b238b30ede820edb80e7e804975ee14ac356aadd21cd6cbdb","source_head":"bdeda88466290319f33ab19dc8b3642a78dd8b24","inputs":[],"supersedes":null,"execution":{"repository":"example/product","issue":101,"target":"integration","model":"openai-codex/gpt-6-luna","remediation_limit":1}} -->
## Implementation Context

**Issue**: [example/product#101](https://github.com/example/product/issues/101)
**Source head**: `bdeda88466290319f33ab19dc8b3642a78dd8b24`
**Inputs**: none
**Supersedes**: none

# Implementation context: Provide normalized display text

## Target identity
- Repository: `example/product`
- Integration branch: `integration`
- Prepared integration/base SHA: `bdeda88466290319f33ab19dc8b3642a78dd8b24`
- Actual native worktree HEAD before mutation: `bdeda88466290319f33ab19dc8b3642a78dd8b24`
- Worktree was clean before edits.
- Intake declares no dependencies (`dependsOn: []`); no pre-edit fast-forward applies. The observed `origin/integration` was also the prepared base.

## Relevant boundaries
- Producer: `src/profile.mjs` (`normalizeDisplayName`, `profileId`)
- Producer regression: `test/profile.test.mjs`, reached through `npm test`
- Existing consumer inspected, explicitly not implemented here: `src/render.mjs`; its tests are in `test/display.test.mjs`.
- Decision read: `docs/decisions/display-boundary.md`.

## Verification contract
Prepared verification config identifies `test.producer` as `npm test`, `test.consumer` as `npm run test:display`, and `test.all` as `npm run test:all`. Issue #101 requires pre/post `npm test`; the full fixture suite and consumer integration belong to dependent #102.

## Delivery mode
Trusted dispatch selected `local-replay`. Keep issue records/review local (`publish:false`); do not write GitHub comments, PRs, labels, or merges. If the reviewed local dependency head is complete, the explicitly authorized final delivery step is pushing that committed head to disposable `origin/integration`.
