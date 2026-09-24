# Frozen candidate release qualification — 2026-09-24

## Decision: NOT READY FOR RELEASE / PROMOTION

Candidate `c1c6e5c050123c3c0c2919bb3412805b45613c2c` remained frozen in isolated Pi 0.85.1 with pi-subagents 0.60.0 at `0931cbbb98ab253177b181bd334fe02dd919dca5`. All issue/PR identities below are local fixture identifiers; no live GitHub write occurred.

| Entry point | Result | Time / reported model cost | Local delivery / tracking |
|---|---|---|---|
| `/review-pr 7` | Correct blocker: `CHANGES_REQUESTED` / staging `FAIL`, `correctness:F1`; conditional migration skip accepted and disproven historical claim rejected. | Review parent 286.6 s / $0.03234; reviewer 61.5 s / $0.00791. Retained r1 tracking attempt 228.1 s / $0.05134. Fresh local helper recovery 51.4 s of fake-GH call window; no model/reviewer rerun. | Old r1 attempted receipt and panels remain unchanged. In a separately identified fixture, revision 2 created/read/searched issue #900 and published panels #106/#107 while reusing the same review report. No live issue exists. |
| `/work-on 201` | **PASS in its prior controlled fixture.** Normal owner returned `DONE/SATISFIED`; one correctness reviewer approved; consumer behavior failed before and passed after the change. | Parent 577.8 s / $0.15852; reviewer 48.8 s / $0.00475. | The owner simulated PR #502 merge, issue closure, and expected records in that separate fixture. This successful case was preserved and reused, not rerun. |
| `/orchestrate #101 #102 #103` | **Valid measured GATED outcome; not a successful three-issue delivery.** One guarded parent ran once. #101 and #103 started concurrently; #102 remained blocked and was never admitted. Native #101 was `FAILED/detached`, then the same owner ended `GATED`; #103 was `GATED`. | Parent 781.3 s; parent $0.03275. Two owners plus two reviewers; total reported model cost $0.22029. | PRs #501/#502 remain open; issues #101/#103 are open/gated; #102 remains open/ready. No merge/closure events; integration is still at the original `eb4906c…` base. Both owner worktrees were preserved by native handoffs. |

## Decisive orchestration gates

- #101 owner committed `317d4c94…`; `npm test` passed 2/2; reviewer report #1013 was clean. The prepared review had `publish:false`, so the owner saved a GATED adjudication and did not publish a REVIEW-PANEL or merge.
- #103 owner committed `0e5bbdcf…`; the focused region test passed 1/1, while configured `npm test` remained 2/2 red on the unmerged profile placeholder. Reviewer report #1012 was clean; adjudication failed closed because `reviewer-execution.json` was missing. The owner left the issue GATED.
- The generated workflow returned #102 as blocked by #101 with no owner run. No dependent code was written.

The previous collided orchestration attempts remain preserved and excluded. The earlier second dispatcher did call native status/worktree checks, but its status query showed no active fleet and exact worktree matches were empty. Cross-session duplicate prevention therefore remains **unqualified**; the new OS lock qualifies only top-level launch exclusion for a single fixture namespace. No candidate patch was made.

## Setup and safety limits

The retained issue-create request was valid GitHub/`gh api` syntax; the original adapter exited 2 because collection-level POST was unimplemented. An adapter-only correction passed a no-model installed-helper create/readback/search/persistence preflight, and unsupported requests still failed explicitly. A second launcher against the same fixture namespace was refused with exit 75 before its command ran. The new orchestration attempt used its own checkout, `.git`, bare remote, fake-GH state, artifacts, sessions, and temp root.

Package validation remains the prior result: 493 passed, 0 failed, 6 optional skips; 68-file package check. No whole ForgeDock package suite was rerun for unchanged code. Ordinary Pi/settings remain unchanged; PRs #583/#582 remain unmerged. No deployment, CI dispatch, AlterLab action, or live lifecycle was performed.

Operation-level sanitized excerpts are in `release-closeout-20260924-evidence.md`.
