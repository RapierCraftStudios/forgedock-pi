# Candidate qualification results

Qualification used the thin candidate built from merged `origin/main` commit
`c6bf7ed7a56fd66935f04384ce1b43b8cdf17db7` and candidate runtime commit
`2f6c4a4b7e874cc5b6b12858acb0f6bcc80c1603`. The evidence in
`qualification/evidence/` is sanitized: it contains run identities, outcomes,
timing/usage, relevant diffs, and disposable paths only.

## Checks

| Trial/check | Result | Evidence |
| --- | --- | --- |
| Complete repository suite and typecheck | PASS: 414 tests passed, 0 failed, 6 explicit environment skips | final check log / command output |
| Candidate-focused suite | PASS: 19 tests passed | `test/candidate/*.test.ts` |
| Static product-like replay | PASS: real cross-file consumer fails before the producer fix and passes after it; this is a fixture test, not agent qualification | `test/candidate/product-replay.test.ts` |
| Fresh owner trial | PASS: owner 201 observed failing-before/passing-after `npm test`, applied the decision, committed locally, and received one independent clean correctness review | `qualification/evidence/owner-replay.*` |
| Candidate intake | PASS: readable unstructured bodies remain owner obligations; acceptance and mutation files are preserved; empty/unreadable input gates | `qualification/evidence/intake-repeatability.md`, `test/candidate/cli.test.ts` |
| Repeated intake in a fresh Pi session | PASS: same digest and `preparedAt`; first `reused=false`, second `reused=true` at the same output path | `qualification/evidence/intake-repeatability.md` |
| Disposable integration checkout | PASS: clean `integration` checkout is created/replaced without changing the candidate worktree | `scripts/prepare-integration-checkout.sh` |
| Two-issue dependency orchestration | PASS for true ordering and delivery; issue 101 completed before issue 102 and the successor consumed the predecessor commit | `qualification/evidence/orchestration-first-pass.*` |
| Orchestration first-pass quality | **FAILURE PRESERVED**: issue 102's first reviewer found unconditional `undefined` team rendering and gated the batch | `qualification/evidence/orchestration-first-pass.json` |
| Scoped orchestration repair | PASS: same-role fallback repaired only issue 102, received a fresh scoped clean review, and returned `DONE issue=102 pr=none dependency=SATISFIED`; first-pass failure remains counted | `qualification/evidence/orchestration-repair.md`, `qualification/evidence/repaired-render.diff` |
| Same-repository Git-ref replacement/rollback | PASS: candidate ref `2f6c4a4...` replaced the installed ref and rollback restored the original source and unrelated settings | `qualification/evidence/replacement-rollback.*` |
| Packed package smoke and installed RPC | PASS: package contents and fresh `/forge-status` were validated from an isolated candidate install | final package/RPC outputs |
| Generated native workflows | PASS: native validation accepted the owner/reviewer requests, exact dependency DAG, and recovery fields | generated workflow validation output |

Runtime versions used for the live local trials were Pi `0.85.1`,
`pi-subagents` `0.60.0` at commit `0931cbbb98ab253177b181bd334fe02dd919dca5`,
and model `openai-codex/gpt-5.6-luna:low`.

## First-pass accounting

The single-owner issue 201 trial was accepted locally on its first owner/review
pass. The two-issue orchestration was not: issue 102 needed a review-driven
compatibility correction. That defect, repair commit, repair owner, and scoped
re-review are retained in the evidence rather than rerun away or relabeled as a
first-pass success.

Local commits, `dependency=SATISFIED`, and the `DONE` marker are disposable
replay signals. They do not represent GitHub delivery.

## Not claimed

- **Live GitHub lifecycle:** not executed. No issue, PR, comment, merge, or
  closure was written to a remote repository; the replay used a disposable
  local origin and fake GitHub boundary.
- **Production release:** not authorized. Ordinary installation, deployment,
  branch protection, and stopped-backlog restart were not changed.
- **Universal first-pass reliability:** not established by these samples.
- **Second-provider comparison:** not run; the selected configured model was
  `openai-codex/gpt-5.6-luna`.
