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