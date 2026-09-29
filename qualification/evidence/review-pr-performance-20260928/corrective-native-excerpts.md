# Corrective native-run excerpts

All URLs below are from the disposable `example/product` fake-GitHub boundary; no live GitHub writes occurred.

```text
FORGE_REVIEW_RESULT role=correctness report=.../correctness.report.md publication=published verdict=APPROVE
```

The parent attempted the configured check only after reviewer completion:

```text
forge_run_check: Configured checks require a clean frozen source checkout
```

The exact review worktree then contained only the four untracked native reviewer files under `.pi/subagents/artifacts/`. No configured test command ran and no check receipt was created. The fixture's `test/display.test.mjs` also had an unmatched closing parenthesis; the parent read it and correctly chose GATED rather than claiming verification.

The injected provisional-panel readback fault was recovered on the same comment ID:

```text
comment #1001 GET: injected TLS handshake timeout
comment #1001 GET retry: success
```

Final adjudication and gate readbacks were:

```text
forge_publish_adjudication: publication=published verdict=GATED gate=FAIL
  final panel=https://github.com/example/product/pull/7#issuecomment-1002
  readbackVerified=true
forge_publish_record: publication=published gate=FAIL
  gate=https://github.com/example/product/pull/7#issuecomment-1003
  linked panel=https://github.com/example/product/pull/7#issuecomment-1002
  readbackVerified=true
```

The parent made two rejected adjudication calls, then published revision 1 itself; no test harness changed its arguments. Its final response linked the gate record but omitted a separate panel URL:

> PR #7: GATED — staging gate FAIL. The correctness reviewer reported no findings, and its report was verified as published. Required GitHub CI passed, but configured `npm test` did not run: the frozen test file has an unmatched `)` after its second assertion. ... [Staging gate record](https://github.com/example/product/pull/7#issuecomment-1003)
