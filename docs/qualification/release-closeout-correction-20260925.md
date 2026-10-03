# PR #583: measured closeout of the corrected candidate

**Decision: NOT READY FOR BOUNDED USE.** The single-parent run completed useful development, review, and simulated delivery for all three fixture issues. The remaining blocker is the incomplete durable knowledge-record linkage for fixture issue #103 (details below). No evaluator repaired or rewrote the fixture records.

## Candidate and runtime identity

- Code commit measured and pushed on the existing [PR #583](https://github.com/RapierCraftStudios/forgedock-pi/pull/583): `36871a3d3d25b16e4954ddfabc6bfa8504502f5b`.
- Immutable isolated install: `/home/dev/.cache/forgedock-pi-candidate/36871a3d3d25b16e4954ddfabc6bfa8504502f5b`; package digest `eadf0acdced3cc118dd0e182d8708a207a5be3cc43ce459b1e00db75894021a9`.
- Runtime: Pi `0.85.1`; pi-subagents `0.60.0`, commit `0931cbbb98ab253177b181bd334fe02dd919dca5`; owner model `openai-codex/gpt-5.6-luna` (high), reviewer model same (medium).
- Full source validation on the code snapshot: typecheck passed; 501 tests, 495 passed, 0 failed, 6 optional skips; package contained 68 files. The isolated install/doctor verified the candidate and extension identities. The ordinary Pi installation was not changed.
- Automatic PR checks on code head `36871a3` passed: [check (22)](https://github.com/RapierCraftStudios/forgedock-pi/actions/runs/36080816625/job/107902151546) and [check (24)](https://github.com/RapierCraftStudios/forgedock-pi/actions/runs/36080816625/job/107902148592). No checks were manually dispatched.

## Fixture and measured run

The only top-level parent ran `/orchestrate #101 #102 #103` against the disposable fake-GitHub/local-bare fixture `forgedock-release-correction-c1c6e5c0-20260924T144216Z`, seeded at `eb4906c0a289d8e748f3fd832e5ea48a880e42d9`. All fixture issue/PR writes and merges stayed in that fixture; its PR numbers below are simulated, not live GitHub objects. The namespace lock was acquired by this parent and held to terminal completion. No live fixture write, live fixture merge, deployment, ordinary-install change, or evaluator delivery action occurred.

- Parent session `01a0d5fb-ac5e-719a-aa43-805c67e27045`; native workflow run `call_d732c61a8c924ab79d073b05664562cb|fc_0d1e87eb414fcee3016ab5c1ae199c8191bf11a81cbb998717`.
- Elapsed orchestration time: `959.65s`. Unique parent/owner/reviewer session usage: `$0.25083448`, 197 turns, 514,324 input tokens, 39,195 output tokens, and 5,046,784 cache-read tokens (cache reads included; sessions counted once).
- Issue #101 ran first. Its owner terminal result completed at `00:41:49.987Z`; #102 and #103 owners started at `00:41:50.248Z` and `00:41:50.645Z`, then overlapped for about 419 seconds. Thus the fixture exercised one prerequisite followed by two parallel successors, with owner concurrency two. It did **not** exercise an independent lane during #101.
- The fixture added a verification-only dependency from #103 to #101 because configured `npm test` includes #101's profile behavior; #103's two original acceptance criteria were unchanged. A scratch-only preflight also showed #101's patch passes the configured suite while #102/#103 remain unimplemented.

| Fixture issue | Owner run | Simulated PR / head / merge | Verification | Reviewer run and parent decision |
|---|---|---|---|---|
| #101 | `38982eee-6105-43e8-a28a-0071eb115562` | #501 / `ca9e18ef52383257aab05a578cc9796ddc1a293e` / `53d7f2bcced7e13b5fa28f9186941f31f1fc2546` | `npm test`: 2 passed; `git diff --check`: pass | `63ae2894-f37b-453d-b02a-689636e20f17`; APPROVE/PASS |
| #102 | `1fb27238-016b-4b8a-ae02-ee2fef41a03a` | #503 / `7b3b5ba9edee32f29ecec147dff07551a9737d3d` / `459de084cf6b973fb53080ed1d429742fc576826` | `npm test`: 3 passed; `git diff --check`: pass | `52352727-3c53-44fd-96a3-f8fd77e92d2a`; APPROVE/PASS |
| #103 | `51c13a5d-1647-40bb-b3b3-83e8168420eb` | #502 / `0bfa9d79f93d2b126e307b16832172a5dbbe54c1` / `f7cc4f0d250fd2d4e2ea21c6abd026812bad5a90` | focused check: 1 passed; `npm test`: 2 passed; `git diff --check`: pass | `dfdcf2a5-4d56-4299-931f-71b1bcc98380`; APPROVE/PASS |

All three native workflow rows were `DONE`/`SATISFIED`; all fixture issues ended closed with merged labels, and all simulated PRs ended merged. The final local `integration` head was `459de084cf6b973fb53080ed1d429742fc576826`.

The successor delivery was checked in Git, not inferred from owner markers: both successor PRs were created at base `53d7f2b…` (the #101 merge), both feature heads descend from that commit, and both successor trees contain the normalized `src/profile.mjs`. Relative to that base, #102 changed only `src/render.mjs` and `test/display.test.mjs`; #103 changed only `src/region-label.mjs`. The owner worktrees fetched the fixture's local `integration` remote after #101 completed.

## Review receipts, retries, and recovery

Each issue used one registered `forge_prepare_review` call, one actual correctness-review run with a captured `reviewer-execution.json` receipt, and one `forge_publish_adjudication` call. Each final artifact records APPROVE/PASS and complete tracking publication. The fixture contains two REVIEW-PANEL comments per PR because the final record explicitly supersedes the earlier panel comment; this was **not** a second reviewer run or panel-agent launch.

The #102 owner had two reviewer-workflow launch requests rejected by the frozen-authorization guard before a reviewer was spawned; it corrected the request itself, then launched the single reviewer run listed above. This was visible model self-correction, not operator/evaluator intervention. No detached owner occurred, so the actual batch did not invoke `subagent_wait`; generated-workflow tests cover the detached DONE/GATED continuation cases. Cross-session duplicate-owner prevention remains unqualified.

## Remaining blocker

Fixture issue #103's `FORGE:BUILDER` record (fixture-local comment `1020`) has machine metadata `inputs: []`, despite its existing pre-build investigation/classification/context/contract/architecture records (fixture-local comments `1010`–`1014`). Its terminal trajectory (comment `1028`) links the Builder record but does not restore that missing build-to-plan/context edge. The code, tests, review, and simulated delivery succeeded, but this leaves the issue's durable knowledge chain incomplete under the existing record contract. This is the reason for **NOT READY**; the owner-owned record gap is preserved as observed, with no evaluator repair and no replacement parent run.
