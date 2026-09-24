# Decisive sanitized evidence excerpts — 2026-09-24

All IDs, comments, issues, PRs, labels, and URLs below are from local fake-GH fixtures. None are live GitHub records. The frozen ForgeDock candidate is `c1c6e5c050123c3c0c2919bb3412805b45613c2c`.

## Issue-create request and fake-adapter correction

The retained normal parent publisher attempted this valid `gh api` shape for its saved `correctness:F1` draft:

```text
gh api repos/example/product/issues --method POST \
  -F 'title=Preserve marker in restore output' \
  -F 'body=@<saved correctness-F1-r1-parent.md>' \
  -f 'labels[]=bug' -f 'labels[]=review-follow-up'
```

The exact saved 1,400-byte body (SHA-256 `be4120258228e84672c264cc55cb63ae65ea23e92b05852855fb39a8a777bc52`) was:

```markdown
<!-- FORGE:REVIEW_FOLLOW_UP repository=example/product pr=7 head=4eae364aee63e3bab1244fb6992b563f0af9af7a concern=correctness-F1 -->
<!-- FORGE:REVIEW_FOLLOW_UP_FINGERPRINT sha256:83e1d4c1ce2f69489669d262f0926c9ecda310e20339f3b2970a673955653b24 -->
## Problem

PR #7 changes restore(input) to omit the existing marker field from its returned object.

## Root Cause

src/restore.mjs returns only payload after the PR edit, removing marker without a caller migration or replacement contract.

## Affected Files

- `src/restore.mjs`

## Expected Behavior

restore(input) preserves the existing returned shape, including marker and payload, unless an explicitly coordinated API migration is provided.

## Acceptance Criteria

- [ ] restore({marker, payload}) returns both marker and payload.
- [ ] Any intentional API change documents and migrates all affected consumers.
- [ ] A regression test covers the preserved or intentionally migrated contract.

### Evidence and stage

Required stage: Pre-merge correctness review
- Base e3fc7e99e5f8165b2996ad304a29e4a7d56fa6ac returns marker and payload.
- Frozen head 4eae364aee63e3bab1244fb6992b563f0af9af7a returns only payload.
- Reviewer report correctness:F1 identifies the exact regression.

### Review references

- https://github.com/example/product/pull/7#issuecomment-100

Parent decision: https://github.com/example/product/pull/7#issuecomment-104
```

The retained tool error was `unsupported controlled gh API: POST repos/example/product/issues`. The retained response did not report a subprocess code; the pre-fix adapter's `fail(..., 2)` branch and a separate reproduction of this invocation establish exit 2, with scratch issue/audit counts remaining zero. `gh api --help` supports `-F key=@file` and repeated `labels[]=value`; GitHub supports `POST /repos/{owner}/{repo}/issues`. The production request was valid; the fake adapter lacked collection POST.

After an adapter-only correction, the installed helper contract preflight (no model) created scratch #400, verified identical submitted body/title/labels through direct GET and a later helper search, and retained it across subprocesses. Search returned a plausible causal match. Unsupported `PUT repos/example/product/issues/400` still exited 2 with an explicit unsupported-route error and left state unchanged.

The retained r1 receipt was not cleared or retried. A separate recovery fixture used installed-helper adjudication revision 2, preserving the same review report and decision. It created local issue #900 (`Preserve marker in restore output`, labels `bug`, `review-follow-up`), verified direct readback and search, and published panels #106/#107 superseding #105. The original r1 journal/state remains preserved; reviewer run `8d8b40a2-1b1d-4952-a107-08eb9eaada27` was reused and reviewer reruns were zero. The helper output marked tracking `created`/`complete`; no live issue exists.

## Exclusive test-driver guard

A non-model preflight against the actual new fixture namespace held the root `flock` from cwd `repo/`; a second stand-in launcher from cwd `bin/` using that same namespace was refused with exit **75** before its command ran. The first stand-in's exit **37** was preserved. The launcher holds this namespace lock across the existing RPC runner; it covers checkout, fake-GH state, bare remote, artifacts, sessions, and temp files.

## Single-parent orchestration run

- Parent session: `01a0d2ec-6008-7393-b138-8d16caa9f26c`; one `/orchestrate #101 #102 #103` parent; 781.3 s wall time; runner exit 0. One generated workflow, owner concurrency 2.
- Owners launched concurrently: #101 `ea19e17f-1a0a-4397-8690-b3bcb671b324`; #103 `57b76bfc-efc9-4864-913e-5c2b209e2bd1`. Both owner inputs included the required exact local authorization sentence.
- Reviewers: #101 `a303570d-76fa-4b52-93ba-6fefe6096fea`, report comment #1013, no observations; #103 `e35fc2b1-97de-45ce-9140-8f31b248b463`, report comment #1012, no observations.

Native workflow result and owner terminal evidence remain distinct:

```text
issue-101: FAILED / UNSATISFIED (detached for intercom coordination)
issue-102: GATED / UNSATISFIED, blockedBy [issue-101], runId null
issue-103: GATED / UNSATISFIED
```

The same #101 owner later returned `FORGE_WORK_ON_RESULT status=GATED issue=101 pr=501 dependency=UNSATISFIED`; #103 returned `FORGE_WORK_ON_RESULT status=GATED issue=103 pr=502 dependency=UNSATISFIED`. No #102 owner was launched.

- #101 commit `317d4c94c5a5d498eda29f4eb38f1e99a684dd`, PR #501. `npm test` passed 2/2 and `git diff --check` passed. The reviewer report was published and clean, but the prepared review artifact had `publish:false`; its adjudication was saved GATED without a REVIEW-PANEL. One parent supervisor reply explicitly preserved the gate. No merge or closure.
- #103 commit `0e5bbdcf526d3fd13983b987e0a2c6af7f61e2db`, PR #502. The focused region check passed 1/1; configured `npm test` failed 2/2 on the unmerged profile placeholder. The clean reviewer report was published, but adjudication failed closed with `Native reviewer execution receipt for correctness is missing or not a regular file`. The owner wrote GATED; no panel, merge, or closure.

Final local state: #101/#103 OPEN with `workflow:gated`; #102 OPEN with its original `workflow:ready-to-build`; PRs #501/#502 OPEN; zero merge/closure events. Local and bare integration stayed at `eb4906c…`. The two owner worktrees were preserved by completed native handoffs (`cleanup: partial`); no manual removal or retry occurred.

Reported usage: parent $0.03274716; owners $0.10336972 and $0.07123920; reviewers $0.00723708 and $0.00570148; total $0.22029464. The parent answered one supervisor request; there was no post-launch user intervention. No live GitHub write, CI dispatch, deployment, or candidate-source edit occurred.

## Duplicate-admission finding kept separate

In the earlier collided attempt, the second dispatcher did call native status/worktree checks. Its status result was `No active subagent fleet`; its plan recorded `exactWorktreeMatches: []` and `activeOwnership: []`, despite visible `workflow:in-review` labels. The active runs were in a separate parent session and not visible at that supported boundary. Since phase labels alone are not ownership proof, retained evidence does **not** establish that ForgeDock ignored an observable active owner. Cross-session duplicate prevention remains unqualified; the new lock qualifies only top-level test-driver exclusion for one fixture root.

The successful `/work-on 201` case remains preserved in its prior fixture: owner `DONE/SATISFIED`, independent approval, local simulated PR #502 merge and issue closure. It was reused, not rerun. Fixture PR numbers across these separate runs are not shared identities.
