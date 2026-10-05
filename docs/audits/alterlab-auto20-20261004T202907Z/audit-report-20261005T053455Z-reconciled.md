# ForgeDock orchestration audit — AlterLab 20-issue batch

**Audit:** `/audit --run-id b951966b-8c04-4f58-a8a1-0924819cecfa` — applied the existing read-only audit prompt/skill to the exact native root, supported by three independent audit lanes. No standalone package audit executable exists. **Status: PARTIAL.**

**Publication:** This report retains AlterLab issue/PR identifiers and technical details by explicit user direction. It is being published in the public ForgeDock repository; local host/session paths are normalized.

## Conclusion

**7 DONE / 9 GATED / 4 FAILED.** Seven issue PRs merged to `staging`; none merged to `main`, and no deployment or production verification occurred. Three of the seven successful merges (#33811, #34019, #33833) were completed by separate rebind/direct-resume runs not linked into the original workflow value. The nine GATED rows consist of four root gates (#33678, #34022, #33914, #34010) plus five dependency-blocked lanes. Four technical handoff failures remain open with no PR (#34023, #33990, #33975, #33991).

The user explicitly authorized one more remediation round for #33678/#34022 and a functional scope change for #33914, then selected **pause and preserve**. Those actions remain paused; this audit did not resume them. The authorization/pause records were not copied into a digest-bound lane continuation.

## Per-issue reconciliation

| Issue | Final | GitHub | PR | Main / rebind status | Wake or disposition |
|---|---|---|---|---|---|
| #34024 | GATED | OPEN | — | GATED / — | Held until #33983 is DONE with dependency=SATISFIED. |
| #34023 | FAILED | OPEN | — | FAILED / 32eb:FAILED | Technical handoff failure. Original target moved; explicit policy-file context failed. Rebind2 no-argument context matched its exact lane, but the owner stopped without source/GitHub writes. |
| #34022 | GATED | OPEN | #34056 OPEN | GATED / — | PR #34056 remains open. Exact-head review found a short paraphrased HTTP-200 interstitial false negative. User authorized another round, then chose pause. |
| #34020 | DONE | CLOSED | #34050 MERGED | DONE / — | PR #34050 merged to staging. 17 focused tests passed; aggregate Worker npm phase unavailable because vitest was missing. |
| #34019 | DONE | CLOSED | #34054 MERGED | FAILED / 7b8a:FAILED | PR #34054 merged to staging. 124 focused handler/shared-redaction tests passed; direct resumed owner returned DONE; native root rows remained FAILED/empty. |
| #34015 | GATED | OPEN | — | GATED / — | Held until #34024 is DONE with dependency=SATISFIED. |
| #34014 | DONE | CLOSED | #34055 MERGED | DONE / — | PR #34055 merged to staging. 44 focused detector tests passed; one remediation/re-review. |
| #34010 | GATED | OPEN | — | FAILED / — | External PR #34008 must merge to staging; no source changes. |
| #33993 | GATED | OPEN | — | GATED / 32eb:GATED | Held until #33990 is DONE with dependency=SATISFIED. |
| #33991 | FAILED | OPEN | — | FAILED / — | Technical handoff failure. Explicit context received the full policy file; no-argument context matched the original bound policy. No source/GitHub writes. |
| #33990 | FAILED | OPEN | — | FAILED / 32eb:FAILED | Technical handoff failure. Rebind2 no-argument policy matched batchNonce/issue/repo/target/model/contract/verification; explicit full-policy path caused the mismatch. No source/GitHub writes. |
| #33985 | GATED | OPEN | — | GATED / — | Held until #33914 is DONE with dependency=SATISFIED. |
| #33983 | GATED | OPEN | — | GATED / — | Held until #33678 is DONE with dependency=SATISFIED. |
| #33975 | FAILED | OPEN | — | FAILED / 32eb:FAILED | Technical handoff failure. Original target moved; rebind2 no-argument policy matched. Explicit policy-file context was rejected; no source/GitHub writes. |
| #33969 | DONE | CLOSED | #34052 MERGED | DONE / — | PR #34052 merged to staging. 42 focused detector tests passed; child fast-forwarded to a moved target after context, contrary to the frozen targetBase contract. |
| #33968 | DONE | CLOSED | #34051 MERGED | DONE / — | PR #34051 merged to staging. 41 focused detector tests passed; one authorized remediation/re-review. |
| #33914 | GATED | OPEN | — | FAILED / — | Partial display-only work is preserved. User authorized functional Auto-Recharge selection/request-ID scope, but no bound contract re-plan was prepared before pause. |
| #33833 | DONE | CLOSED | #34057 MERGED | FAILED / 32eb:FAILED | PR #34057 merged to staging; test-only worker settlement-cancellation regression. 40 focused tests passed (2 warnings); no live Redis/PostgreSQL proof. Native root rows had empty/FAILED results. |
| #33811 | DONE | CLOSED | #34053 MERGED | FAILED / 7b8a:FAILED | PR #34053 merged to staging. Two focused crawl status/export tests passed; direct resumed owner returned DONE; native root rows remained FAILED/empty. |
| #33678 | GATED | OPEN | #34049 OPEN | FAILED / — | The exact-head panel found malformed nested/literal SQL-query shapes still pass validation. PR #34049 is open; user authorized another remediation round, then chose pause. |

## Why only seven reached staging

- Four issues passed the entire owner/review/merge lifecycle in the main run: #34020, #33968, #33969, #34014.
- Two issues (#33811, #34019) merged only after separately prepared rebinds and direct resumption of their retained owners; #33833 merged from a second rebind root. Their original root rows were still FAILED/empty.
- Four root lanes were legitimately gated by specific security/behavioral gaps or an external PR. Five successors stayed gated by hard dependency edges.
- Four technical failures did not reach source or GitHub writes. Three “native binding mismatch” reports in rebind2 were false positives: the no-argument context policy exactly matched that rebind batch.

## Confirmed root causes

1. **Contract compiler defect (pre-dispatch):** 13 of 78 prepared acceptance criteria across issues #33811, #33833, #33975, #33983, #33990, #33993, #34010, #34014, #34015, #34019, #34022, #34023, #34024 included trailing Forge HTML metadata in the final checkbox text/hash. Source-body identity was not checked. Thus 26 criteria are proven PASS, 4 FAIL, 29 MISSING, 6 UNKNOWN, and 13 CONTRADICTED by hash mismatch.
2. **Target-base contradiction:** `work-on.md` instructs fetch/fast-forward; dispatcher binds exact `targetBase`/head. Staging advanced while lanes were active. In #33969 an owner fast-forwarded after context validation and committed on the new head without a parent rebind.
3. **Context argument-shape error:** `context [INPUT_DESCRIPTOR]` expects a `{path,sha256}` descriptor file, but owners passed a full `issue-N.json` lane policy or unsupported `--input`. For rebind2 #33990/#34023/#33975, no-argument context returned matching batchNonce, issue, repo, target, model, contract digest, and verification path. The path reuse for immutable contract files was correct.
4. **Result propagation/recovery bug:** generated `runIssue` short-circuits on transport `ok:true` before validating the required terminal result and native acceptance state. Rows can be `ok:true`, `output:""`, `acceptance:rejected`, resumable, yet map to FAILED without recovery.
5. **Recovery lineage:** rebinds/direct resumes were separate native runs, not descendants in the original status. `dispatch.mjs identify` could not resolve direct resume IDs; successful GitHub outcomes did not update the parent `workflow.value`.
6. **Authorization/wake gap:** post-run approvals were chat/session events, not policy-digest-bound continuation records. The batch has no durable GATED resume path, and no cumulative allowance across main and recovery roots.

## Usage and evidence limits

- Main root: 35/280 fanout admissions; 15 owner rows. Rebind1: 2/28. Rebind2 persisted status says 4/70, while the terminal native notification says 9/70. The mismatch is unresolved. Separate root envelopes sum to 378; no cumulative batch cap/ledger exists.
- Saved ownerUsage totals across the three roots: 2,186,925 input; 271,835 output; 70,798,336 cache-read; $1.06259336; 973 turns. This excludes direct-resume owner usage and reviewer usage, so it is not total batch cost.
- Search returned 100/321 issues, without pagination. Local tests were focused per lane; no full production build, deployment, production traffic, or canary check was run.
- Current staging head read back as `a4dcefccb8c42fc18e10a5aced8fc3b3327b8b9a`. No main merge or deploy.

## Corrected workflow contract and acceptance tests

The reconciled JSON carries the full corrected state-machine proposal and acceptance matrix. In brief: freeze a target head per owner; validate exact source-criterion hashes before dispatch; use native no-argument context (or a real descriptor schema); recover malformed/empty results regardless of transport success; persist original/latest owner IDs and one-use authorization in a single batch continuation ledger; only verified DONE/SATISFIED releases dependents; GATED records one wake condition; pagination and nested budgets are bounded and tested beyond 100 lanes.

Acceptance tests must cover: exact contract parser against trailing comments; valid/invalid context arguments; target movement and parent-owned rebind; `ok:true` with missing/rejected acceptance; same-owner resume identity; no duplicate writers; dependency release only after merge/readback; durable user cap/scope authorization; per-batch cumulative usage; >100 real generated lanes; required CI proof; and no-main/no-deploy guard.

## Artifact and remaining decision

Full evidence graph, criterion coverage, sources, per-issue outcomes, run counters, and corrected contract: `audit-report-20261005T053455Z-reconciled.json`. The earlier local-only coverage export is not included. The audit changed no product/source code, issues, PRs, or production state; this publication adds only these two report artifacts on a dedicated branch.

Remaining decision: whether to lift the pause and resume the already-authorized #33678/#34022/#33914 lanes after a parent-owned, correctly bound continuation is prepared. #34010 remains dependent on external PR #34008.
