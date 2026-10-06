# Two-issue orchestration replay fixture

Issue 101 supplies the missing producer normalization behavior. Issue 102 depends on that delivery and integrates it into the real consumer renderer with an explicit optional `profile.teamLabel` contract. The fixture source contains no completed solution or reviewer verdict.

The current disposable contract is recorded in `product/docs/decisions/display-boundary.md` and duplicated as explicit acceptance examples in `orchestrate-issues.json` and `product/test/display.test.mjs`; the consumer tests also assert that whitespace in a supplied team label is preserved verbatim. Verification is deliberately issue-scoped: #101 runs configured `test.producer` (`npm test`); #102 runs `test.consumer` (`npm run test:display`); the full suite is `test.all` (`npm run test:all`). All three named commands are declared in `product/forge.yaml` and `product/package.json`. The prepared dependency graph must remain exactly #101 → #102.

The original ambiguous issue/decision and GATED evidence are preserved byte-for-byte under `legacy-ambiguous-v1/`; the failed/waiting historical run itself is not rewritten. This v2 contract applies only to this disposable fixture and grants no product or AlterLab decision authority.
