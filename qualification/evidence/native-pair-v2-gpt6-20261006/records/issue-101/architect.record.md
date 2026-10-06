<!-- FORGE:ARCHITECT -->
<!-- FORGE:RECORD {"v":1,"record_id":"sha256:60c3f99721fb0735b2d0e79a52771d309370029aea872f947680038f31678e52","source_head":"bdeda88466290319f33ab19dc8b3642a78dd8b24","inputs":[],"supersedes":null,"execution":{"repository":"example/product","issue":101,"target":"integration","model":"openai-codex/gpt-6-luna","remediation_limit":1}} -->
## Implementation Plan

**Issue**: [example/product#101](https://github.com/example/product/issues/101)
**Source head**: `bdeda88466290319f33ab19dc8b3642a78dd8b24`
**Inputs**: none
**Supersedes**: none

# Implementation plan: Provide normalized display text

1. Replace only the intentional throwing body of `normalizeDisplayName` in `src/profile.mjs` with `value.trim().toLowerCase()`; leave `profileId` intact.
2. Strengthen the focused producer test in `test/profile.test.mjs` with uppercase display input surrounded by whitespace, and assert the original profile identifier and object data remain unchanged after normalization.
3. Run `npm test` before editing (captured failing stub) and after editing (required pass). Do not claim `npm run test:display` or `npm run test:all` as issue #101 prerequisites; #102 owns the consumer integration/full fixture suite.
4. Review diff/scope, commit locally, run one read-only independent correctness review against the prepared base and exact acceptance, then adjudicate all observations. Under the explicit local replay authority, make no GitHub/label writes; after accepted local review push the exact committed dependency head to disposable `origin/integration`.
