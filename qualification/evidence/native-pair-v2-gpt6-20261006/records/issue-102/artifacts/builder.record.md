<!-- FORGE:BUILDER -->
<!-- FORGE:RECORD {"v":1,"record_id":"sha256:c7bca6ae0804eefa98b7a64db73fddbda238cf87558933ad05499e0707b2775b","source_head":"0d5a548ac58951b6c23cb87668891d4bd00282ce","inputs":[],"supersedes":null,"execution":{"repository":"example/product","issue":102,"target":"integration","model":"openai-codex/gpt-6-luna","remediation_limit":1}} -->
## Build Complete

**Issue**: [example/product#102](https://github.com/example/product/issues/102)
**Source head**: `0d5a548ac58951b6c23cb87668891d4bd00282ce`
**Inputs**: none
**Supersedes**: none

# BUILDER — Issue #102: Integrate normalized text into profile rendering

## Frozen local change
- Repository: `example/product`.
- Reviewed source head: `0d5a548ac58951b6c23cb87668891d4bd00282ce`.
- Base/effective issue-101 predecessor: `713aced2e0e5efef105dbc379bc1687d8c65414c`.
- Changed files: `src/render.mjs`, `test/display.test.mjs`.

## Implementation and proof
`renderProfile` retains the existing identifier and normalized display name, appends `:${teamLabel}` only when it is a nonempty string, and returns the original two-segment output otherwise. The label is not trimmed or case-normalized and the source object is not mutated. The real consumer suite verifies no label, empty label, `Platform`, and whitespace-padded label.

Pre-edit `npm run test:display` reproduced the omission: 1 pass, 2 failures. After the change:
- `npm run test:display`: passed, 4/4.
- `npm run test:all`: passed, 5/5.
- `npm test`: passed, 1/1 producer test.
- `git diff --check`: passed.

## Deviations and limitations
No dependency was added and no producer behavior was changed. The empty-string test is an additional boundary check implied by the criterion that only a nonempty label becomes a segment. This is an explicitly local replay: there is no GitHub PR, remote record permalink, GitHub policy/check claim, label/comment/merge/closure action, or GitHub delivery. Independent correctness review is being performed with `publish:false`; the authorized disposable `origin/integration` push remains the local dependency-delivery boundary.
