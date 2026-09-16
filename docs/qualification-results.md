# Candidate qualification results

Qualification was run against source commit `27a6bf39a1d6fc0663a2000c2aea84640f766a28`
(the final branch adds this evidence document only). The baseline was the merged
`origin/main` commit `c6bf7ed7a56fd66935f04384ce1b43b8cdf17db7`.

## Results

| Trial/check | Result | Evidence |
| --- | --- | --- |
| TypeScript and complete repository test suite | PASS: 414 passed, 0 failed, 6 explicit environment skips | `/tmp/forgedock-candidate-check-ebd.log` |
| Candidate-focused tests | PASS: routing, config, exact dependency DAG, frozen review, marker publication, ambiguous-create recovery, replacement/rollback, staging evidence, source-read-only reviewer, and product-like replay | `test/candidate/*.test.ts` |
| Product-like bug replay | PASS: real cross-file consumer failed before the producer fix and passed after it | `test/candidate/product-replay.test.ts` |
| Packed package smoke | PASS: 29 files; no top-level `skills/`, `specs/`, or `agents/` legacy roots | `/tmp/forgedock-pack-ebd.json`, `test/smoke/package-launch-contract.test.ts` |
| Generated native dispatch request | PASS: native `subagent` validator accepted rolling two-owner request; exact dependency and owner-recovery fields are present | `/tmp/candidate-dispatch-ebd.json`, final generated workflow validation |
| Generated native review request | PASS: native `subagent` validator accepted the frozen two-role request with per-role authorization | `/tmp/candidate-review-ebd.json`, final generated workflow validation |
| Fresh installed RPC command | PASS: `/forge-status` executed from the isolated config and reported `native subagent=available; staging tools=3/3` | `/tmp/forgedock-status-ebd.jsonl` |
| Isolated install/doctor | PASS: Pi `0.85.1`, `pi-subagents` `0.60.0`, pinned commit `0931cbbb...`; candidate and subagent tree digests and settings verified | `/tmp/forgedock-verify-ebd.json`, `/tmp/forgedock-doctor-ebd.json` |
| Publication fault injection | PASS: lost create response reconciled by stable marker and exact readback | `test/candidate/qualification.test.ts` |
| Replacement and rollback | PASS: disposable Pi registration replaced and restored without changing unrelated settings | `test/candidate/qualification.test.ts` |

A fresh final native child smoke was also run from the candidate checkout with one
read-only `scout` child and no source/GitHub writes. Its output is retained in
`/tmp/forgedock-candidate-native-child-ebd.jsonl`; native child run id
`f1a3cf88-5e23-4727-ab68-3047a1282623` completed successfully.

## Not claimed

- **LIVE GITHUB LIFECYCLE QUALIFIED:** not claimed. No issue, PR, comment, merge, or
  closure was written to a remote repository because no disposable remote write target
  was authorized. Run the normal `/work-on` canary only after authorizing that target,
  then exercise `/review-pr` and `/orchestrate` with `--issues-file`-equivalent replay
  data or real disposable issues as appropriate.
- **Direct-Pi paired quality baseline:** not run. A live model comparison would require
  a separately approved product-like replay and would otherwise conflate provider/network
  variance with workflow variance.
- **Second provider:** not run. `openai-codex/gpt-5.6-luna` was the selected configured
  model; other provider authentication was not ready in this environment.
- **PRODUCTION RELEASE AUTHORIZED:** not granted. Automatic product merge, deployment,
  branch-protection changes, and stopped-backlog restart were not performed.

The successful local sample proves package/native mechanics and selected exception
boundaries, not universal first-pass reliability. Review-driven code correction was not
needed after the final bounded remediation pass; the repeated earlier review findings
were preserved in the session evidence rather than hidden as first-pass success.
