<!-- FORGE:CONTRACT -->
<!-- FORGE:RECORD {"v":1,"record_id":"sha256:824cf4dfaf857163021111928c9a1cd6509dfae39dfa4ac33d503f651335d527","source_head":"713aced2e0e5efef105dbc379bc1687d8c65414c","inputs":[],"supersedes":null,"execution":{"repository":"example/product","issue":102,"target":"integration","model":"openai-codex/gpt-6-luna","remediation_limit":1}} -->
## Build Contract

**Issue**: [example/product#102](https://github.com/example/product/issues/102)
**Source head**: `713aced2e0e5efef105dbc379bc1687d8c65414c`
**Inputs**: none
**Supersedes**: none

# CONTRACT — Issue #102: Integrate normalized text into profile rendering

Preserve the complete authored acceptance obligations exactly:

# Integrate normalized text into profile rendering

## Acceptance Criteria
- [ ] The profile renderer consumes the normalized producer behavior and includes a supplied nonempty `profile.teamLabel` verbatim as the third colon-separated output segment. If `teamLabel` is absent, retain the two-segment output.

- [ ] For `{ id: "User-7", name: "  ALICE  ", teamLabel: "Platform" }`, the real renderer returns `User-7:alice:Platform`; without `teamLabel`, it returns `User-7:alice`. Preserve the identifier and source object.

- [ ] Make the supplied consumer regression in `test/display.test.mjs` pass through the real renderProfile path without adding a dependency.

## Verification
- Run configured command `test.consumer` (`npm run test:display`) for the consumer regression and `test.all` (`npm run test:all`) for the complete two-issue fixture after integration.

## Affected Files
- `src/render.mjs`
- `test/display.test.mjs`

Depends on #101

## Relevant decision
Consult `docs/decisions/display-boundary.md` before implementation.

## Concrete proof
Exercise the real `renderProfile` consumer with normalized producer input, a present nonempty label (including verbatim preservation), and no label; verify exact outputs, unchanged identifiers/source objects, and the configured focused and full test commands. Do not add dependencies or alter producer behavior.
