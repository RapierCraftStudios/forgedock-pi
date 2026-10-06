# Candidate qualification results

## Initial frozen-candidate qualification

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

## Knowledge-restoration candidate

The bounded knowledge/label restoration is implemented in candidate commit
`0e25c4ff65a68198b40260836d13b8db446436a5` and installed separately at
`/home/dev/.cache/forgedock-pi-candidate/0e25c4ff65a68198b40260836d13b8db446436a5`.
Its focused publication/label suite passes 8/8; the full repository suite passes
422 tests with 6 explicit skips.

The retained AlterLab #32792 evidence was backfilled retrospectively without
replaying product work. The issue now has separate investigator, classification,
context, contract, architect, builder, and gated records, plus a linked PR panel:

- Issue chain: [investigator](https://github.com/RapierCraftStudios/AlterLab/issues/32792#issuecomment-5709126031), [classification](https://github.com/RapierCraftStudios/AlterLab/issues/32792#issuecomment-5709126300), [context](https://github.com/RapierCraftStudios/AlterLab/issues/32792#issuecomment-5709126776), [contract](https://github.com/RapierCraftStudios/AlterLab/issues/32792#issuecomment-5709127128), [architect](https://github.com/RapierCraftStudios/AlterLab/issues/32792#issuecomment-5709127561), [builder](https://github.com/RapierCraftStudios/AlterLab/issues/32792#issuecomment-5709127987), [gated](https://github.com/RapierCraftStudios/AlterLab/issues/32792#issuecomment-5709128971)
- PR graph: [individual report](https://github.com/RapierCraftStudios/AlterLab/pull/33795#issuecomment-5707855284), [review panel](https://github.com/RapierCraftStudios/AlterLab/pull/33795#issuecomment-5709128687), [original parent decision](https://github.com/RapierCraftStudios/AlterLab/pull/33795#issuecomment-5707861883)
- Current issue label: `workflow:awaiting-merge`; unrelated labels preserved; issue remains open.

The backfill batch was retried once and all eight records reconciled as
`existing-identity`. It did not merge, close, deploy, or restart any backlog.

## Review-pipeline latency correction

The retrospective latency diagnosis and sanitized evidence (including two earlier partial
native attempts and one corrective native GATED/FAIL attempt that did not reach the configured
check in order) for the existing PR #583 branch are documented in
[`qualification/evidence/review-pr-performance-20260928/RESULT.md`](../qualification/evidence/review-pr-performance-20260928/RESULT.md).
The completed AlterLab #33800 GATED/FAIL result remains unchanged; this tooling
correction made no AlterLab writes.

## Corrected native reconciliation pair (2026-10-06)

The corrected disposable-only v2 contract was qualified once with the exact candidate
commit `4a36725a5f4ccd53e573549a167c1ac91b53f025` installed in isolation. Runtime
identity was Pi `1.0.2`, pi-subagents `0931cbbb98ab253177b181bd334fe02dd919dca5`,
and `openai-codex/gpt-6-luna:max`. The existing PR #583 was open at that candidate
head; no merge or install of the later evidence-only closeout was performed.

In the single native pair run, synthetic #101 and #102 both completed `DONE`, with
native status `completed`, acceptance `checked`, and dependency `SATISFIED` on the
same persisted parent root. #101 delivered commit
`713aced2e0e5efef105dbc379bc1687d8c65414c`; #102 fast-forwarded from that exact
predecessor before editing and delivered `0d5a548ac58951b6c23cb87668891d4bd00282ce`
with #101 as parent. The disposable local `origin/integration` readback matched the
final commit. The parent integration worktree itself remained at the prepared base,
behind the local ref by two commits; this is local ref delivery, not GitHub merge.

Both local correctness panels reported no structured findings and adjudicated
`APPROVE / PASS`. Owner-run verification passed: #101 `npm test` 1/1 (its two
`teamLabel` consumer cases remained correctly deferred); #102 `npm run test:display`
4/4, `npm run test:all` 5/5, and `npm test` 1/1, with `git diff --check` clean.
The pre-install no-model repository check passed 520 tests, 0 failed, 10 skipped;
the focused native-adapter pair passed 2/2. Reviewers inspected frozen source but
did not independently run tests.

The #102 owner automatically corrected one rejected reviewer-tool call that carried
an unrequested `includeProgress` option; the rejected call launched no reviewer, and
one valid review then completed. There was no human/operator repair, parent reply,
code remediation, repeated review, or evaluator-edited native result. The final
persisted parent root had no detached owner and no continuation. The earlier v1
ambiguous-contract result remains an immutable failure archive with #102 GATED and
the stale WAITING/detached root; it is not relabeled as success.

Timing and reported cost are separated in the [sanitized evidence bundle](../qualification/evidence/native-pair-v2-gpt6-20261006/README.md): setup 0.686s, no-model preflight 18.282s, parent preparation 2m32.245s, native owner/review/delivery window 19m56.039s, and 6m44.760s of parent collection after the root. The exact-root wait was reported as 19m31s and overlaps the root window. Parent execution elapsed 29m13.044s; setup through closeout totaled 29m32.012s. Reported model cost was $0.03490868 for the parent plus $0.08316298 for the native child workflow, or $0.11807166 combined; no-model setup is excluded.

### Requirements-to-evidence map

| Requirement | Evidence |
| --- | --- |
| Exact runtime/install and disposable contract | `qualification/evidence/native-pair-v2-gpt6-20261006/run/{launch-input,preflight,install-manifest}.json` |
| Authoritative same-root final batch status | `run/result.json`, byte-identical `run/native-root-status.json`, and `run/workflow-value.json`; root SHA-256 and issue rows are recorded in the bundle README |
| Issue-level context, records, predecessor consumption, and local delivery | `owners/`, `records/issue-101/`, `records/issue-102/`, and `run/dispatch-result.md` |
| Frozen code review, actual reviewer runs, and adjudication | `reviews/issue-101/` and `reviews/issue-102/` |
| Historical v1 ambiguous-contract failure | `qualification/fixtures/orchestration-replay/legacy-ambiguous-v1/` (unchanged) |

This one disposable pair demonstrates corrected local parent reconciliation only. It
creates no general reliability, GitHub policy/check, merge-readiness, or production
claim. Auto20 remains paused; no AlterLab issue/comment (including #33616), ordinary
Pi, product source, live fixture, deployment, or backlog execution was changed. The
closeout changes only this ForgeDock qualification report and its evidence bundle.
