<!-- FORGE:CONTRACT -->
<!-- FORGE:RECORD {"v":1,"record_id":"sha256:8570e52fb299a4bc76aac88501ef7e94bef23b6df12e03337956f251f97dff26","source_head":"bdeda88466290319f33ab19dc8b3642a78dd8b24","inputs":[],"supersedes":null,"execution":{"repository":"example/product","issue":101,"target":"integration","model":"openai-codex/gpt-6-luna","remediation_limit":1}} -->
## Build Contract

**Issue**: [example/product#101](https://github.com/example/product/issues/101)
**Source head**: `bdeda88466290319f33ab19dc8b3642a78dd8b24`
**Inputs**: none
**Supersedes**: none

# Build contract: Provide normalized display text

Preserved issue body and obligations:

> # Provide normalized display text
>
> ## Acceptance Criteria
> - [ ] Export the producer behavior required by the display-boundary decision: display text trims surrounding whitespace and is lowercase while profile identifiers and source data remain unchanged.
>
> - [ ] Pass the focused producer regression in `test/profile.test.mjs` through the existing `npm test` entrypoint.
>
> ## Verification
> - Producer prerequisite: run configured command `test.producer` (`npm test`, `test/profile.test.mjs`) before and after this issue. Do not implement the #102 consumer behavior in #101. The full fixture suite is `npm run test:all` and is completed by the dependent integration issue.
>
> ## Affected Files
> - `src/profile.mjs`
> - `test/profile.test.mjs`
>
> ## Relevant decision
> Consult `docs/decisions/display-boundary.md` before implementation.

## Bound acceptance identities
- `I101-AC-d820f0bf3acb` — exact parent-bound criterion: source ordinal 1, behavioral, boundaries `src/profile.mjs` and `test/profile.test.mjs`; text hash supplied by dispatch: `sha256:d820f0bf3acb0b8d7b69d1692c1a80825f98cf42517e10d7efba8843ce720196`.
- `I101-AC-59636083d919` — exact parent-bound criterion: source ordinal 2, behavioral, boundaries `src/profile.mjs` and `test/profile.test.mjs`; text hash supplied by dispatch: `sha256:59636083d9198f5da40d77dc2e4ef39564875f05a2c38efb7417ac1fb465eca1`.

## Required behavior and proof
Implement the smallest pure string transformation: trim surrounding whitespace and lowercase display text. Preserve `profileId(profile)`'s identifier result and prove normalization does not mutate the source profile object. Add/update focused behavioral coverage in `test/profile.test.mjs`, and verify it through `npm test`.

## Non-goals
Do not implement optional `teamLabel` consumer rendering from the decision; do not edit `src/render.mjs` or `test/display.test.mjs`; do not add dependencies or change source profile identifiers/data.
