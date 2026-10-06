# Corrected native pair qualification (disposable v2)

This is a sanitized, post-run evidence bundle for the one authorized live-model qualification. It does not rewrite any native root status, owner record, review report, or adjudication. `run/native-root-status.json` is a byte-for-byte copy of the final native root status; its SHA-256 matches the hash in `run/result.json`. Files under `records/` and the review reports, panels, receipts, adjudications, and run metadata are byte-for-byte copies of owner- and review-created local artifacts. The two frozen review diffs are stored as Base64 encodings so `git diff --check` does not mistake patch context spaces for newly added source whitespace; decoding reproduces the original files byte-for-byte. Original diff SHA-256 values: #101 `68497b49f4609acec8fcb02fff158a398e738536af78c96783c6601d23f0144d`; #102 `b4ead6f345bd2ad1e611f8f8a93fb63240ca8bb22842afc1a1a7cca09970fb17`. `SHA256SUMS` covers every other bundle file. Raw parent/child Pi transcripts are deliberately excluded; they remain only at their original temporary paths.

## Tested identity and scope

- ForgeDock candidate source: `4a36725a5f4ccd53e573549a167c1ac91b53f025`, PR #583's existing branch `fix/review-adjudication-20260918T060000Z` at qualification time.
- Installed candidate: `/home/dev/.cache/forgedock-pi-candidate/4a36725a5f4ccd53e573549a167c1ac91b53f025`; install manifest `run/install-manifest.json` records package digest `a71112815edd7bcd45108bb0934a54d943ac7f0d7f08ca12f1d43d8ca99f6868` and pi-subagents digest `d920744c4fa7d160fd860d802b978db37c3ef392fa2f2604567276b03d706c91`.
- Runtime: Pi `1.0.2`; pi-subagents commit `0931cbbb98ab253177b181bd334fe02dd919dca5`; model `openai-codex/gpt-6-luna` with `max` thinking (GPT-6/max).
- Disposable fixture only: synthetic `example/product` issues #101 → #102, base `bdeda88466290319f33ab19dc8b3642a78dd8b24`, owner concurrency 2. The v2 contract says trim/lowercase display names without changing identifiers/source objects; append an optional nonempty `teamLabel` verbatim as segment three; omit it when absent.
- No live GitHub issue, PR, comment, label, merge, closure, deployment, or product-source action occurred. Fake GitHub writes were disabled/rejected. The issue/PR numbers in the local review artifacts are fixture identities, not live GitHub records.

## Actual outcome and evidence map

| Claim | Evidence |
| --- | --- |
| The same native parent root reconciled both owners to terminal success | `run/result.json`, `run/native-root-status.json`, and `run/workflow-value.json`. Native root `231d2f30-3fd1-4b43-9135-d04c9d526908`, state `complete`, SHA-256 `7758055e4ca7546eae5cc053d7a03de9bf409e112e8419e175cb51c00028fbd2`. Both rows are `DONE`, native status `completed`, acceptance `checked`, dependency `SATISFIED`; no detached owner and `continuationCount=0`. This persisted root result—not a child marker—is the batch outcome.
| #101 implementation and delivery | `records/issue-101/`, `owners/issue-101-*`, and `reviews/issue-101/`. Commit `713aced2e0e5efef105dbc379bc1687d8c65414c` (parent `bdeda88466290319f33ab19dc8b3642a78dd8b24`) implements trim/lowercase normalization while preserving identifier and source object. `owners/owner-101-meta.json` preserves the owner completion/usage receipt.
| #102 consumed #101, implemented the consumer, and delivered | `owners/issue-102-context.md` records the clean fast-forward to exact #101 commit before edits; `owners/issue-102-trajectory.md`, `records/issue-102/`, and `reviews/issue-102/` preserve the result. Commit `0d5a548ac58951b6c23cb87668891d4bd00282ce` has #101 as its parent. Read-only local `origin/integration` readback was `0d5a548...`; `owners/owner-102-meta.json` preserves the owner completion/usage receipt.
| Review and adjudication happened once per issue | Each `reviews/issue-*/reviewer-execution.json` records one successful correctness reviewer run; corresponding `reviewer-run-meta.json` preserves its duration/usage; reports have no structured findings; local adjudications are `APPROVE / PASS`. Reviewers inspected frozen source but did not independently execute tests; owner test receipts are recorded separately.
| Local delivery is not GitHub delivery | `run/dispatch-result.md`, owner trajectories, and the fake-GitHub boundary. The disposable local `origin/integration` ref reached #102's commit. The parent integration worktree stayed at the prepared base (behind the local ref by two commits); owner worktrees remained clean. No GitHub or production readiness is claimed.

`run/preflight.json` is the no-model preflight. Its `localDelivery` readback `e45709c...` belongs to a separate preflight adapter proof, **not** the live pair; the actual pair delivery head is `0d5a548...` as recorded in the native outcome and owner evidence.

## Implementation and verification

- **#101** (`src/profile.mjs`, `test/profile.test.mjs`): pre-edit and strengthened regressions failed against the stub; post-edit `npm test` passed 1/1 and `git diff --check` passed. `npm run test:display` passed 1/3 on #101's reviewed head, with only the two optional team-label cases reserved for #102 failing; the full suite was deliberately deferred to the dependent issue.
- **#102** (`src/render.mjs`, `test/display.test.mjs`): pre-edit consumer regression failed as expected and producer `npm test` passed. Post-edit `npm run test:display` passed 4/4, `npm run test:all` passed 5/5, `npm test` passed 1/1, and `git diff --check` passed. The real renderer preserves the input, returns `User-7:alice:Platform` for the supplied label, and keeps the two-segment form when absent/empty. The frozen reviewed diffs are reversibly encoded as `reviews/issue-*/frozen.diff.base64`; adjudications are in `reviews/issue-*/`.
- Before installation, the candidate's no-model `npm run check` passed **520 passed, 0 failed, 10 skipped**, and the paired native-adapter tests passed **2/2**. The exact tested/installed candidate commit is listed above; the evidence-only closeout commit does not change runtime code.

## Self-correction and intervention accounting

The #102 owner made one invalid reviewer-tool call at `2026-10-06T06:46:24.248Z`: it added an unrequested `includeProgress` option, so frozen-authorization validation rejected the call in 6 ms before launching a reviewer. The same owner emitted a progress update and retried the prepared review without that extra option at `06:46:47.259Z`; the one actual reviewer then completed successfully. There was no repeated review, code remediation, human repair, parent reply, or evaluator edit. `run/result.json` records `operatorInterventions.count=0`; the child progress update is not a parent/operator intervention.

## Timing and cost (UTC)

| Phase | Recorded span |
| --- | ---: |
| Fixture setup | 0.686 s |
| No-model preflight | 18.282 s |
| Parent preparation to first native root | 152.245 s (2m32.245s) |
| Native root, including both sequential owners, review, adjudication, and local delivery | 1,196.039 s (19m56.039s), `06:31:59.252`–`06:51:55.291` |
| #101 owner end-to-end | 462.375 s (7m42.375s), `06:31:59.441`–`06:39:41.816` |
| #102 owner end-to-end | 733.286 s (12m13.286s), `06:39:41.956`–`06:51:55.242` |
| Actual correctness-reviewer execution, inside owner spans | #101 109.179 s; #102 84.848 s |
| Local adjudication tool calls, inside owner spans | #101 0.555 s; #102 0.622 s |
| Exact-root wait | One `bg_wait`, reported 19m31s; overlaps the native-root window and is not added again |
| Parent collection after native root | 404.760 s (6m44.760s) |
| Parent run elapsed | 1,753.044 s (29m13.044s); setup + preflight + parent phases total 1,772.012 s (29m32.012s) |

Owner end-to-end spans include investigation, implementation, checks, review/adjudication, and local delivery; reviewer/adjudication durations above are nested within them, not additional wall time. The first valid reviewer call for #102 succeeded; its 6 ms rejected attempt preceded it and is not a second reviewer run.

Reported model cost: parent `$0.03490868`; native child workflow `$0.08316298` (owners `$0.07523130` plus the two reviewer runs `$0.00793168`); combined reported total `$0.11807166`. No-model preflight/setup cost is not included.

## Historical comparison and limits

The earlier ambiguous-contract v1 trial remains separately archived at `qualification/fixtures/orchestration-replay/legacy-ambiguous-v1/` and is not rewritten as success. Its parent elapsed 29m06.965s; it preserved #101 `DONE`, #102 `GATED`, and an immutable stale `WAITING`/detached root snapshot. The old result logs three supervisor-channel calls (pending, status, reply; one reply), and its first pass remains unaccepted. The v2 pair is the first successful demonstration of the corrected disposable contract and persisted parent reconciliation—not proof of general reliability.

Auto20 remains paused. No AlterLab issues/comments (including #33616), ordinary Pi, product source, live fixture, deployment, or backlog execution was changed. PR #583 remains open; this qualification does not establish its GitHub checks, merge readiness, or production readiness. One disposable pair does not establish broad release reliability.
