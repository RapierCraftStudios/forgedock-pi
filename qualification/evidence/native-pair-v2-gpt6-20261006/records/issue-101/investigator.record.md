<!-- FORGE:INVESTIGATOR -->
<!-- FORGE:RECORD {"v":1,"record_id":"sha256:86904c899e052d52038cf6a9c7047a6be81e78f703fb3b0f72855846c00d6ec4","source_head":"bdeda88466290319f33ab19dc8b3642a78dd8b24","inputs":[],"supersedes":null,"execution":{"repository":"example/product","issue":101,"target":"integration","model":"openai-codex/gpt-6-luna","remediation_limit":1}} -->
## Investigation

**Issue**: [example/product#101](https://github.com/example/product/issues/101)
**Source head**: `bdeda88466290319f33ab19dc8b3642a78dd8b24`
**Inputs**: none
**Supersedes**: none

# Investigation: Provide normalized display text

## What We Found
`src/profile.mjs` exports `normalizeDisplayName(value)`, but it currently always throws `Error("display normalization is not implemented")`. `test/profile.test.mjs` is the focused producer regression and imports this exported function. The configured producer command `npm test` was run before edits and failed its sole test at `test/profile.test.mjs:6` with that exact throw.

## Root Cause
The producer function is a stub, so the existing real consumer (`src/render.mjs`) cannot normalize the display name. The decision contract assigns trim/lowercase normalization to this boundary. The same decision reserves optional `teamLabel` output for the consumer integration successor; this issue will not change `src/render.mjs` or implement that behavior.

## Evidence
- Read `docs/decisions/display-boundary.md`: display text trims surrounding whitespace and is lowercase, while stored profile identifiers and the source profile object remain unchanged.
- Inspected producer-to-consumer path: `src/render.mjs` calls `profileId(profile)` and `normalizeDisplayName(profile.name)`; `test/display.test.mjs` exercises the consumer. The #101 change is confined to the producer boundary.
- `git log --oneline --decorate --all -- src/profile.mjs test/profile.test.mjs docs/decisions/display-boundary.md` contains only the prepared `bdeda88` replay baseline; no useful issue-specific history was available.
- Pre-edit `npm test`: failed (1 test, 0 passed) because normalization is not implemented.

## Acceptance Checks
1. Exported normalization trims and lowercases only the display string; `profileId` and the source profile data stay unchanged.
2. The focused producer regression passes through the existing `npm test` entrypoint.
