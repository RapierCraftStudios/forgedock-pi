<!-- FORGE:CLASSIFICATION -->
<!-- FORGE:RECORD {"v":1,"record_id":"sha256:2a95a8b90eed7dce09cbb6507e654c011f3d9c226fe0bf61f011b38646efe541","source_head":"bdeda88466290319f33ab19dc8b3642a78dd8b24","inputs":[],"supersedes":null,"execution":{"repository":"example/product","issue":101,"target":"integration","model":"openai-codex/gpt-6-luna","remediation_limit":1}} -->
## Classification

**Issue**: [example/product#101](https://github.com/example/product/issues/101)
**Source head**: `bdeda88466290319f33ab19dc8b3642a78dd8b24`
**Inputs**: none
**Supersedes**: none

# Classification: Provide normalized display text

## Classification
Issue #101 is a bounded producer behavior defect in `src/profile.mjs`, with its regression in `test/profile.test.mjs`. The required behavior is directly specified by `docs/decisions/display-boundary.md` and is already represented by the exported function and focused test.

## Scope and non-goals
- In scope: implement `normalizeDisplayName` as trim surrounding whitespace then lowercase display text; prove profile identifiers and source data remain unchanged; run the configured producer command.
- Out of scope: the #102 consumer behavior for optional `teamLabel` rendering. Do not edit `src/render.mjs`, consumer tests, dependencies, or the two-segment/third-segment render contract.

## Risk
Low, local transformation at the presentation boundary. The source profile object and identifier can remain untouched by normalizing only the string value.
