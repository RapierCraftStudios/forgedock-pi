<!-- FORGE:INVESTIGATOR -->
<!-- FORGE:RECORD {"v":1,"record_id":"sha256:723a21b236665b0c7265adc859df33528d837e360387b8955ee633cb90984725","source_head":"713aced2e0e5efef105dbc379bc1687d8c65414c","inputs":[],"supersedes":null,"execution":{"repository":"example/product","issue":102,"target":"integration","model":"openai-codex/gpt-6-luna","remediation_limit":1}} -->
## Investigation

**Issue**: [example/product#102](https://github.com/example/product/issues/102)
**Source head**: `713aced2e0e5efef105dbc379bc1687d8c65414c`
**Inputs**: none
**Supersedes**: none

# INVESTIGATOR — Issue #102: Integrate normalized text into profile rendering

Repository: `example/product`; target branch: `integration`.

## Question and observable behavior
`renderProfile` is the real consumer boundary. It currently calls `profileId(profile)` and `normalizeDisplayName(profile.name)` and returns only `<id>:<normalized-name>`. With issue #101's producer delivered, `npm run test:display` passes the absent-team case but fails the supplied consumer regressions: `User-7:alice` is returned instead of `User-7:alice:Platform`, and a whitespace-bearing team label is omitted instead of being copied verbatim.

## Producer, history, and decision
The declared #101 predecessor is delivered as exact commit `713aced2e0e5efef105dbc379bc1687d8c65414c` on disposable `origin/integration`; its changed files are `src/profile.mjs` and `test/profile.test.mjs`. Its producer exports `normalizeDisplayName`, which trims and lowercases the display name while `profileId` reads the unchanged id. The applicable contract is `docs/decisions/display-boundary.md`: optional nonempty `teamLabel` is appended verbatim, without changing id/source data or adding a dependency. No GitHub PR or remote issue-record history exists in this explicitly local replay.

## Pre-edit experiment
After the required fast-forward to the delivered predecessor, `npm run test:display` failed on both team-label assertions (actual `User-7:alice`; expected `User-7:alice:Platform` and `User-7:alice:  Platform  `). The absent-label case passed. `npm test` passed the #101 producer regression (1/1).

## Bounded conclusion
The renderer fails to consume the optional team-label input. The fix belongs at `renderProfile`'s formatting boundary; preserve `profileId` and producer normalization and never mutate the source object.
