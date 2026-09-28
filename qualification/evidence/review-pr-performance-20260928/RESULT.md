# Retained review-run latency and correction

**Scope:** retrospective diagnosis of the completed ForgeDock review of AlterLab PR #33800, followed by tooling-only changes on the existing ForgeDock PR #583 branch. The original review and staging result remain **GATED / FAIL**; this work did not re-review the product or modify AlterLab, its PR, comments, issues, branch policy, or checks.

## Retained run

The local parent session (`01a0e74c…e1448e18c05fb`) began at `2026-09-28T09:16:07.694Z` and returned its final response at `09:48:33.943Z`: **1,946.249 seconds (32m 26.249s)** across 31 assistant messages. Its only user input was the two-line submission `/forge-status` followed by `/review-pr 33800`; neither command was dispatched as a separate extension command. The parent instead performed manual setup before reaching the review route.

The parent used `gpt-6-luna` with `max` thinking. The configured reviewer runs used `gpt-5.6-luna` with medium thinking; the evidence does not show a model/context configuration error.

| Event | UTC interval | Elapsed | Observation |
| --- | --- | ---: | --- |
| First input to `forge_prepare_review` | 09:16:07.694–09:24:40.602 | 8m 32.908s | Setup, historical/workspace reads, and manual policy collection preceded the registered review. |
| Standalone `inspect-pr` | 09:21:12.579–09:23:04.319 | 111.740s | Returned 934 lines of policy data; `forge_prepare_review` then collected policy again. |
| Registered `forge_prepare_review` | 09:24:40.602–09:25:08.865 | 28.263s | Prepared the frozen review and collected another policy snapshot. The parent then read the complete `policy.json` artifact instead of using a compact summary. |
| Joined reviewer workflow | 09:27:29.303–09:31:00.522 | 211.219s | All three selected reviewers completed; their terminal markers reported publication success. |
| Parent-panel attempt with transient GET error | 09:38:17.341–09:38:38.981 | 21.640s | Exact provisional-comment GET failed with `net/http: TLS handshake timeout`. |
| Same-revision adjudication retry | 09:43:22.157–09:43:54.540 | 32.383s | Reconciled the existing provisional record and published the final panel; no reviewer was relaunched. |
| Final gate publication | 09:45:37.754–09:45:51.538 | 13.784s | Published the completed GATED/FAIL gate. |

Three routine `contact_supervisor` progress updates were emitted by the joined reviewers and arrived as parent custom messages at workflow settlement. The parent then made three readback-only `forge_recover_reviewer_publication` calls even though each reviewer terminal line said `publication=published`; adjudication itself performs the final report-delivery check. After gate publication, the parent also reread saved/gate evidence before its final response, which followed 2m 42.405s after publication.

## Confirmed final-link defect

The successful adjudication returned final panel comment [#5867435430](https://github.com/RapierCraftStudios/AlterLab/pull/33800#issuecomment-5867435430), superseding provisional panel [#5867350242](https://github.com/RapierCraftStudios/AlterLab/pull/33800#issuecomment-5867350242). The published gate [#5867465695](https://github.com/RapierCraftStudios/AlterLab/pull/33800#issuecomment-5867465695) linked the **provisional** panel instead of the final decision. The saved adjudication, tool result, gate body, and final response therefore did not consistently identify the same parent decision.

## Root causes and bounded changes

- **Combined command routing:** Pi accepts one slash command per input. The router now explicitly rejects multiple ForgeDock commands in either a multiline or same-line input, states that none ran, and explains that `/review-pr` needs no prior `/forge-status`.
- **Redundant setup/policy collection:** the review skills now require one minimal PR-identity query and one `forge_prepare_review` call, not a standalone `inspect-pr`. Preparation returns the exact request object and a compact source-attributed policy summary while retaining the complete `policy.json`; publication performs the one necessary fresh policy refresh.
- **Unnecessary recovery reads:** reviewer instructions suppress routine supervisor progress messages while preserving genuine blocking/authorization requests and material plan-changing discoveries. The staging guard permits only bounded native supervisor status/list/pending/reply operations, so actionable requests remain answerable without opening product-write tools. The parent skills distinguish `publicationState: unverified` from a successful `FORGE_REVIEW_RESULT ... publication=published` and reserve recovery for absent/uncertain delivery; adjudication remains the final readback boundary.
- **Transient exact-comment read:** the existing helper now retries one transient comment GET against the same ID within the existing 120-second total budget. It never retries a POST. A regression verifies the retry and same-revision idempotency.
- **Final panel/gate linkage:** the final adjudication result carries the final verified panel URL and the rendered gate links that same URL. The gate tool rejects a stale/superseded panel link and returns a compact exact-identity publication receipt.
- **Actionable supervisor requests:** the stage guard now allows only native supervisor status/list/pending/reply operations; unsolicited send/ask and product mutation remain blocked. The `pi-subagents` dependency and its `triggerTurn` semantics are unchanged; a deterministic event-hook test covers delayed informational progress and a reply to a genuine decision request.
- **Post-publication work:** adjudication and gate tools return the details needed for the operator response without expanding full gate bodies. Skills direct the parent to finish after verified publication; a local todo completion, if present, is the last tool call.

The substantive AlterLab release prerequisites and the original GATED/FAIL decision are unchanged.

## Disposable exercise setup note

The first isolated fixture setup was rejected by `forge_prepare_review` before policy collection or reviewer launch: `review.max_concurrent: 1` with the retained 900,000 ms reviewer and 120,000 ms publication limits requires at least 2,820,000 ms of panel time, but the fixture supplied 1,920,000 ms. That was a fixture-configuration failure, **not a completed review attempt**: no reviewer child ran and the fake GitHub boundary recorded zero comment/issue writes. The ordinary Pi settings hash was unchanged. The sanitized setup receipt is `setup-failure.json`.

The corrected fixture used the original `review.max_concurrent: 2` and the same 900,000/1,920,000/120,000 ms limits. Its default risk roster selected one correctness reviewer; no extra role was requested or forced. I mistakenly launched a second, duplicate exercise before receiving and inspecting the first exercise's terminal result, contrary to the instruction not to duplicate it. Timestamps show the first had already settled; I should have waited for its result and not launched another. Both ran against separate fake-GitHub fixtures. In each, one correctness reviewer completed and published one fake report, then the configured `test` check stopped before execution because Pi had written untracked `.pi/subagents/artifacts` into the exact review worktree. Both parents stopped correctly: neither adjudication nor a staging gate was published, and neither fake fixture recorded issue writes. The staging skill now runs configured checks before reviewer launch and reuses their receipts; it does not weaken the clean-tree check or delete runtime artifacts. These are partial native route exercises, not completed reviews/gates and not evidence of AlterLab-scale speed or behavioral equivalence. No further native/model run will be launched. Multi-role workflow-result hooks, delayed supervisor notifications/actionable replies, and already-published report delivery are covered separately by deterministic tests in `test/candidate/restricted-staging-policy.test.ts`, `test/candidate/router.test.ts`, and `test/candidate/review-delivery.test.ts`.

## Deterministic event-hook coverage (no model runs)

The focused event-hook regression run passed 34/34 tests. `test/candidate/restricted-staging-policy.test.ts` feeds a three-role native workflow result through ForgeDock's actual `tool_result` hook, then injects a delayed `progress_update` through the installed `pi-subagents` native supervisor channel after the workflow receipt is complete. It verifies the channel's `triggerTurn` behavior, the persistent one-launch guard, and a separate actionable `need_decision` request/reply. `test/candidate/router.test.ts` verifies the staging hook permits only bounded native supervisor reply/read actions and blocks unsolicited `send`/`ask`. `test/candidate/review-delivery.test.ts` starts with all three reports already published and confirms adjudication performs exact report verification without a recovery republish. `test/candidate/adjudication.test.ts` also covers the controlled TLS readback failure, same-comment retry without another POST, and final gate link.

The deterministic hook tests cover the multi-role and delayed-notification boundaries without rerunning models. Both partial native-run outcomes and the duplicate-launch deviation are recorded in `native-result.json`.

## Validation

- Focused event-hook suite: 34/34 passed. The isolated controlled-readback regression `transient provisional-panel readback retries once and gate binds the final panel permalink` passed.
- One targeted adjudication/staging run overlapped the first full check. The controlled-readback regression passed, but four unrelated fixture writes failed with `Unknown system error -122`; this overlapping run is not counted as a passing suite.
- The first full check found one stale CLI test assertion expecting the old `Prepared policy facts` wording. The assertion was updated for the compact `Prepared policy summary` prompt.
- Final serial `npm run check`: PASS (`tsc --noEmit`; 512 tests, 506 passed, 6 explicit skips, 0 failed).
- Package check: `npm pack --json --ignore-scripts` succeeded; the 72-file package includes both review skills and the sanitized evidence files plus their `SHA256SUMS`.
