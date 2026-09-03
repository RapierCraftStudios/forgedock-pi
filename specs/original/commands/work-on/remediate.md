---
description: Remediate a current-head FIXABLE_REVIEW block, re-review, and re-gate with a FORGE:REMEDIATION paper trail
argument-hint: "[PR number] [--issue N] [--repo GH_REPO] [--gh-flag GH_FLAG] [--base PR_BASE]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/remediate — Remediation Subcommand

**Input**: $ARGUMENTS

**Invoked by**:
- `work-on.md` Phase 0A, standalone: `/work-on <pr> --remediate` (see forge#1813).
- `commands/orchestrate/phase-4-execution.md` item 6.4, auto-dispatched from current-head `FIXABLE_REVIEW` evidence. A legacy `needs-human` label is only a read signal to classify once, never the dispatch authority.

**Output**: Classify the block as `FIXABLE_REVIEW`, `WAITING_DEPENDENCY`, `ENGINE_ERROR`, or `AUTHORITY_REQUIRED`. Only the first enters remediation. Waiting dependencies return a durable GATED handoff, mechanics remain resumable, and authority-required cases alone use `needs-human`.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
**NEVER use plan mode (EnterPlanMode).**

**Scope note**: This mode re-drives concrete current-head code findings. It never uses `needs-human` as an entry ticket. A new human escalation requires `<!-- FORGE:HUMAN_AUTHORITY_REQUIRED -->` evidence naming the decision/action, authority holder, blocking object, evidence, and why automation cannot act.

**Compatibility**: structured `FORGE:BLOCK_CLASS` evidence is authoritative. Existing `needs-human` without authority evidence is read-only legacy state and must be classified once. Concrete findings become `FIXABLE_REVIEW`; explicit prerequisites become `WAITING_DEPENDENCY`; provider/tool/marker/publication/checkout/push/merge failures become `ENGINE_ERROR`; only proven human authority remains `AUTHORITY_REQUIRED`.

---

## Inputs

Parse from $ARGUMENTS:
- `{PR_NUMBER}` — PR number to remediate (required, first positional arg). It must have current-head `FIXABLE_REVIEW` evidence; a legacy `needs-human` label is classified once before use.
- `--issue {ISSUE_NUMBER}` — linked issue number (optional). If absent, resolved in Phase M0 from the PR body's `Closes #N` reference.
- `--repo {GH_REPO}` — GitHub repo (resolved from `forge.yaml → project` if omitted)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag
- `--base {PR_BASE}` — PR target branch (optional; resolved from the PR's `baseRefName` if omitted)

---

## Phase M0: Load State & Guard Rails (MANDATORY)

Re-read current state before doing anything:

```bash
PR_STATE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state,headRefName,baseRefName,body,mergeable,mergeStateStatus,url)
PR_OPEN_STATE=$(echo "$PR_STATE" | jq -r '.state')
HEAD_BRANCH=$(echo "$PR_STATE" | jq -r '.headRefName')
PR_BASE="${PR_BASE:-$(echo "$PR_STATE" | jq -r '.baseRefName')}"
PR_BODY=$(echo "$PR_STATE" | jq -r '.body')
```

**PR state guard**:
- `PR_OPEN_STATE = MERGED` → EXIT `REMEDIATE_RESULT: status: ALREADY_DONE` (nothing to remediate — already landed).
- `PR_OPEN_STATE = CLOSED` (not merged) → EXIT `REMEDIATE_RESULT: status: BLOCKED`, blocker: "PR #{PR_NUMBER} is closed, not merged — nothing to remediate."

**Resolve the linked issue** (`--issue` flag takes precedence; else parse from the PR body — anchored, matching the `"Closes #N" in:body` precedent from forge#1634/#1646, never a bare-number scan):

```bash
ISSUE_NUMBER="${ISSUE_NUMBER:-$(echo "$PR_BODY" | grep -oP '(?i)\bCloses #\K\d+' | head -1)}"
if [ -z "$ISSUE_NUMBER" ]; then
  echo "BLOCKED: cannot resolve linked issue — pass --issue explicitly"
  # EXIT REMEDIATE_RESULT: status: BLOCKED, blocker: "cannot resolve linked issue — pass --issue explicitly"
fi
```

**Load the linked issue and validate it is a genuine remediation target**:

```bash
ISSUE_STATE=$(gh issue view {ISSUE_NUMBER} {GH_FLAG} --json labels,state,body,milestone)
ISSUE_LABELS=$(echo "$ISSUE_STATE" | jq -r '[.labels[].name] | join(",")')
```

Read current-head `FORGE:BLOCK_CLASS` evidence from the PR/source issue. Enter remediation only for `FIXABLE_REVIEW`. If no structured class exists but `needs-human` is present, classify that legacy state once in Phase M1; do not treat the label itself as permission to remediate. `WAITING_DEPENDENCY` returns GATED, `ENGINE_ERROR` returns a resumable blocked result, and `AUTHORITY_REQUIRED` remains paused.

**Idempotency / resume check** — the paper trail lives on **both** the PR (primary — checked by the orchestrator's item 6.4 dispatch guard) and the linked issue (mirror — keeps `/work-on`'s standard FORGE-annotation trajectory and resume logic consistent with every other phase):

```bash
PR_REMEDIATION_COMMENT=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:REMEDIATION"))] | last')
```

- If a comment is found AND its body contains `FORGE:REMEDIATION:COMPLETE` → EXIT `REMEDIATE_RESULT: status: ALREADY_DONE`. **Single-attempt semantics (AC5)**: once a `FORGE:REMEDIATION:COMPLETE` marker exists for this PR, do NOT re-attempt fixes on a subsequent invocation, regardless of the prior verdict — this is what prevents an infinite remediation retry loop on a genuinely-blocked PR.
- If a comment is found WITHOUT `:COMPLETE` → a prior attempt was interrupted mid-flight (same failure mode as the investigation phase's partial-comment case). Delete the partial comment(s) on both the PR and the issue, then continue below as a fresh attempt:
  ```bash
  gh api repos/{GH_REPO}/issues/comments/{PARTIAL_PR_COMMENT_ID} -X DELETE 2>/dev/null || true
  gh api repos/{GH_REPO}/issues/comments/{PARTIAL_ISSUE_COMMENT_ID} -X DELETE 2>/dev/null || true
  ```
- If no comment is found → fresh attempt, continue below.

---

## Phase M1: Load Prior Findings & Classify the Block Reason

Gather the current-head block evidence and classify it before any terminal-label write:

**M1a — Current-head blocker evidence on the existing PR/source issue**:

Read the latest synthesized reviewer block, current-head official review, and blocker copy on the linked source issue. These are the primary remediation inputs for a work-on PR; blocking findings do not need child issues to be durable.

```bash
PR_FINDINGS=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | test("REVIEW-FINDINGS-SYNTHESIZED-START|REVIEW-AGENT"))] | .[-10:]')
FINDINGS=$(gh issue list {GH_FLAG} --state open --label "review-finding" --limit 100 \
  --json number,title,body \
  --jq "[.[] | select(.title | test(\"PR #{PR_NUMBER}\"))]")
```

Independent follow-up issues remain useful context but are not prerequisites for remediation.

**M1b — PR review verdicts and merge-block reasons** (Phase 8 of `review-pr.md` records the exact block reason on the linked issue when it aborts auto-merge — read that trail rather than re-deriving it):
```bash
BLOCK_COMMENTS=$(gh api repos/{GH_REPO}/issues/{ISSUE_NUMBER}/comments \
  --jq '[.[] | select(.body | test("Auto-merge aborted|not mergeable|Pre-Push Ancestry Guard Failed|Push Failed|Quality Gate Failed"; "i"))] | last')
```

**Classify into exactly one primary class**:
- **FIXABLE_REVIEW** — concrete current-head code/test findings, a merge conflict that can be reconciled, or a quality/build failure with a repository fix.
- **WAITING_DEPENDENCY** — an identified issue, PR, ref, deployment, or generated artifact must complete before this patch can be valid. This is scheduling, not authority.
- **ENGINE_ERROR** — provider/tool/marker/publication/configuration/checkout/push/merge mechanics, stale state, or exhausted retries. This remains resumable.
- **AUTHORITY_REQUIRED** — a genuine product/policy choice, credential or permission automation cannot obtain, destructive/external operation requiring consent, legal/compliance decision, or protected-target approval.

**If `WAITING_DEPENDENCY`**: do not remediate or ask a supervisor. Add `blocked`, remove `needs-human` and active workflow labels, and post `<!-- FORGE:GATED -->` plus `<!-- FORGE:BLOCK_CLASS:WAITING_DEPENDENCY -->` with the exact prerequisite issue/PR/ref and automatic merge/event wake condition. Return `REMEDIATE_RESULT: status: WAITING`. When the condition becomes true, reconcile against the updated target and restart verification/review.

**If `ENGINE_ERROR`**: do not remediate or add `needs-human`. Add `workflow:engine-error` or `review-degraded`, remove stale active labels, preserve run/worktree/handoff evidence, and return `REMEDIATE_RESULT: status: BLOCKED` for automated recovery.

**If `AUTHORITY_REQUIRED`**: do not remediate. Before adding `needs-human`, post and exact-ID read back `<!-- FORGE:HUMAN_AUTHORITY_REQUIRED -->` naming all five required fields: decision/action, authority holder, blocking object, evidence, and why automation cannot perform it. Without that proof, the write is forbidden. Return `REMEDIATE_RESULT: status: AUTHORITY_REQUIRED`.

**If `FIXABLE_REVIEW`**: transition the issue into active remediation before Phase M2. Keep exactly one active workflow state:

```bash
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "DRY_RUN: would replace needs-human with workflow:in-review on issue #{ISSUE_NUMBER}"
else
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} \
    --add-label "workflow:in-review" \
    --remove-label "needs-human" 2>/dev/null || true # <!-- allowlist:check-command-side-effects -->
fi
```

Do not perform this transition for the other three classes. A later technical failure becomes `ENGINE_ERROR` or `review-degraded`; a later prerequisite becomes `WAITING_DEPENDENCY`; only newly proven `AUTHORITY_REQUIRED` evidence may add `needs-human`.

---

## Phase M2: Checkout the PR's Existing Branch

Remediation always fixes forward on top of the PR's existing head commit — never rebase onto a different base and never force-push over the PR's history unless a fix genuinely requires it (e.g. resolving a merge conflict per the mergeability guard case, in which case use `git rebase`/`git merge` onto `origin/{PR_BASE}` exactly as the branch's own commit history would, then `--force-with-lease`).

```bash
cd {REPO_PATH}
git fetch origin
WORKTREE_PATH="{WORKTREE_BASE}/remediate-{HEAD_BRANCH_SLUG}-{PR_NUMBER}"
if [ -d "{WORKTREE_PATH}" ]; then
  git -C "{WORKTREE_PATH}" fetch origin
  git -C "{WORKTREE_PATH}" checkout {HEAD_BRANCH}
  git -C "{WORKTREE_PATH}" reset --hard "origin/{HEAD_BRANCH}"
else
  git worktree add "{WORKTREE_PATH}" {HEAD_BRANCH} "origin/{HEAD_BRANCH}"
fi
```

If worktree/branch checkout fails, classify `ENGINE_ERROR`, post a resumable handoff, add `workflow:engine-error`, remove stale active/`needs-human` labels, and return `REMEDIATE_RESULT: status: BLOCKED`.

---

## Phase M3: Apply Fixes

For each FIXABLE item from Phase M1: read the affected file(s) in `{WORKTREE_PATH}` before editing (never assume current state), apply the fix. Follow the same implementation discipline as `work-on.md` Phase 3F (cross-lane import guard, library-callback verification, deliverable-type consistency, no unrequested scope) — this file does not restate those rules, it inherits them.

**If the block reason was a mergeability conflict** (`CONFLICTING`/`DIRTY`/`BLOCKED`): resolve it by rebasing `{HEAD_BRANCH}` onto `origin/{PR_BASE}` (or merging `{PR_BASE}` in, whichever preserves a clean, reviewable history) — resolve conflicts manually, do not blindly take "ours"/"theirs".

**Quality Gate** (same loop as Phase 3G, max 3 iterations):
```
iteration = 0
while iteration < 3:
    iteration += 1
    Skill("quality-gate", args="{CHANGED_FILES} --worktree {WORKTREE_PATH}")
    if result == "QUALITY GATE: PASS": GATE_PASSED=true; break
    else: fix each HIGH/MEDIUM finding, re-stage
```
If still failing after 3 iterations: classify `ENGINE_ERROR`, post the remaining findings and handoff, add `review-degraded`, remove stale active/`needs-human` labels, and return `REMEDIATE_RESULT: status: BLOCKED`. Exhausted attempts are resumable technical evidence, not authority.

**Format/verify**: run the project's configured `verification.commands` (same as Phase 3H) before committing.

---

## Phase M4: Commit, Push, and Close Addressed Findings

```bash
cd {WORKTREE_PATH}
git add -u
git commit -s -m "fix(remediate): {description} (#{ISSUE_NUMBER})"
git push origin {HEAD_BRANCH}
```

If push fails, retry with `--force-with-lease` only when M3 legitimately reconciled a conflict. If it still fails, classify `ENGINE_ERROR`, post a resumable handoff, add `workflow:engine-error`, remove stale active/`needs-human` labels, and return `REMEDIATE_RESULT: status: BLOCKED`.

**Record every addressed blocker from the current-head review.** Work-on blockers normally have no child issue: keep their reviewer IDs/invariants in the remediation comment and let the scoped re-review verify them. If an older or independently published `review-finding` issue exists for an addressed blocker, close it directly after the remediation commit. Track only those actual issue numbers in `ADDRESSED_FINDING_NUMBERS[]` — Phase M8 reports this array in the final paper trail:
```bash
ADDRESSED_FINDING_NUMBERS=()
for FINDING_NUM in {FIXABLE_FINDING_NUMBERS_FROM_M1}; do
  gh issue close "$FINDING_NUM" {GH_FLAG} \
    --comment "Fixed by remediation of PR #{PR_NUMBER} (commit {COMMIT_SHA}). See #{ISSUE_NUMBER}."
  ADDRESSED_FINDING_NUMBERS+=("$FINDING_NUM")
done
```
Only close findings actually addressed in this commit — leave any FIXABLE-but-deferred or unrelated open findings untouched.

---

## Phase M5: Post Interim FORGE:REMEDIATION Progress (before re-review)

Post the same body to **both** `{PR_NUMBER}` and `{ISSUE_NUMBER}` (PR copy is the idempotency source of truth; issue copy keeps the standard trajectory/resume logic consistent):

```bash
gh pr comment {PR_NUMBER} {GH_FLAG} --body "<!-- FORGE:REMEDIATION -->
## Remediation In Progress for PR #{PR_NUMBER}

**Findings addressed**:
{bulleted list: finding # — title — one-line fix summary}

**Commit**: {COMMIT_SHA}
**Quality gate**: {iterations} iteration(s), PASS

Re-invoking \`/review-pr --auto-merge\` now."
gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "<!-- FORGE:REMEDIATION -->
## Remediation In Progress for PR #{PR_NUMBER}

**Findings addressed**:
{bulleted list: finding # — title — one-line fix summary}

**Commit**: {COMMIT_SHA}
**Quality gate**: {iterations} iteration(s), PASS

Re-invoking \`/review-pr --auto-merge\` now."
```

Note the marker is `<!-- FORGE:REMEDIATION -->` with **no** `:COMPLETE` suffix yet — per the marker-presence convention (forge#1360/#1357), the absence of `:COMPLETE` correctly signals "in progress" to any concurrent reader, and the M0 resume check above treats this exact state as an interrupted attempt if a session dies before M8.

---

## Phase M6: Re-Invoke /review-pr

```
Skill(skill="review-pr", args="{PR_NUMBER} --auto-merge --issue {ISSUE_NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}")
```

**OpenCode joined-child contract**: When `FORGE_RUNTIME=opencode` (or an OpenCode runtime marker is present), run this required re-review through one native foreground `task`:

```
if DRY_RUN=true:
  record "Would invoke the foreground re-review task for PR #{PR_NUMBER}."
else:
  task(
    description="Re-review PR #{PR_NUMBER}",
    subagent_type="general",
    background=false,
    prompt="Load commands/review-pr.md and execute it for PR {PR_NUMBER} with --auto-merge --issue {ISSUE_NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}. Return only the structured REVIEW_RESULT block after the review reaches its outcome."
  )
```

Wait for the completed child result and retain its `REVIEW_RESULT` in remediation state before continuing to Phase M7. A running/progress response is not a completion result. If the child errors or does not return a parseable `REVIEW_RESULT`, stop with `REMEDIATE_RESULT: status: BLOCKED`; do not report remediation in progress as a terminal parent result. The `Skill(...)` invocation above remains the non-OpenCode path.

This re-runs the full review (domain agents → verdict → Phase 8 auto-merge gate). The FIXABLE transition above left the issue at the non-terminal `workflow:in-review` state. `review-pr.md` recognizes the in-progress `FORGE:REMEDIATION` marker posted in Phase M5 as evidence of the prior escalation, so one of two things happens inside Phase 8:

- **Fresh technical block**: classify it again as `FIXABLE_REVIEW`, `WAITING_DEPENDENCY`, or `ENGINE_ERROR`; never add `needs-human` merely because re-review still blocks.
- **Authority required**: add `needs-human` only after exact-ID readback of complete `FORGE:HUMAN_AUTHORITY_REQUIRED` evidence.
- **Clean re-review**: `VERDICT=APPROVED`-equivalent and mergeable sets `workflow:awaiting-merge` only when protected-target approval is still required; otherwise continue the configured automatic merge.

```bash
POST_REVIEW_LABELS=$(gh issue view {ISSUE_NUMBER} {GH_FLAG} --json labels --jq '[.labels[].name] | join(",")')
if echo "$POST_REVIEW_LABELS" | grep -qE '(^|,)needs-human(,|$)'; then
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} --remove-label "workflow:in-review" 2>/dev/null || true # <!-- allowlist:check-command-side-effects -->
fi
```

Extract the re-review verdict for the paper trail (Phase M8 reports this verbatim):
```bash
RE_REVIEW_VERDICT=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | test("APPROVED:|CHANGES REQUESTED:"; "i"))] | last | .body // "unknown"' 2>/dev/null | head -c 200)
```

---

## Phase M7: Compute the #1809 Q1 Auto-Land Bar

Re-read the issue's current labels after M6:
```bash
POST_REVIEW_LABELS=$(gh issue view {ISSUE_NUMBER} {GH_FLAG} --json labels --jq '[.labels[].name] | join(",")')
```

**If `needs-human` with valid `FORGE:HUMAN_AUTHORITY_REQUIRED` evidence is present**: the bar does not apply. `RE_GATE_OUTCOME="AUTHORITY_REQUIRED"`. Skip to Phase M8. A bare legacy label must first be classified and cannot drive this branch.

**If `workflow:awaiting-merge` is present** (clean re-review case — the only branch where `review-pr.md`'s guard has already safely parked this PR): compute the bar.

```bash
# Trust filter: only reviews/comments from repo collaborators (OWNER/MEMBER/COLLABORATOR
# authorAssociation) can contribute to the auto-land bar. Unlike work-on.md Phase 7A's
# informational-only APPROVED: count (a summary-card/decision-record annotation, not a
# merge gate), this count directly drives `gh pr merge` below — so it must not trust
# unauthenticated signal. Any GitHub user can comment "APPROVED: ..." on a public PR;
# authorAssociation is GitHub's own repo-permission classification and cannot be spoofed
# by comment text. (Ref: forge#1976)
REVIEW_BODIES=$(gh pr view {PR_NUMBER} {GH_FLAG} --json reviews,comments \
  --jq '[.reviews[] | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR") | .body // ""] +
        [.comments[] | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR") | .body // ""] | .[]')
APPROVED_COUNT=$(echo "$REVIEW_BODIES" | grep -cE 'APPROVED:' 2>/dev/null || true); APPROVED_COUNT=${APPROVED_COUNT:-0}
```

**Auto-land bar — base-branch scoped** (forge#2570): the condition the PR must clear to auto-land depends on its target branch. This reconciles the remediation bar with the normal `/work-on` fast-lane merge bar for the *same target branch*, while keeping the strict human-verified bar only where a human is genuinely in the loop (the `staging → main` deploy gate).

**Re-derive the base fresh — do NOT reuse `$PR_BASE` for this decision** (forge#2624): `$PR_BASE` was resolved in Phase M0 as `PR_BASE="${PR_BASE:-$(... .baseRefName)}"` — a caller-supplied `--base` wins over the PR's actual live base whenever non-empty. That is fine for M0's own purposes (worktree base, display text), but this is a security-relevant decision point: a wrong/stale `--base staging` on a PR that actually targets `main` must never be allowed to relax the strict deploy-gate bar. Mirror `review-pr.md`'s sibling guard (`GUARD_BASE`, which always re-fetches `baseRefName` fresh at its own decision point) by re-querying the PR's live base here, independent of whatever `$PR_BASE` currently holds:

```bash
# forge#2624: re-fetch baseRefName fresh from the PR itself — never trust the
# M0-resolved $PR_BASE for this decision, since M0 prefers a caller-supplied
# --base over the live value. This is the one line in this phase that makes
# a trust/security decision, so it must be immune to a caller-overridable input.
LIVE_BASE_REF=$(gh pr view {PR_NUMBER} {GH_FLAG} --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "")

# forge#2570: `main` (and any deploy-gate base) keeps the strict #1809 Q1 verified-human bar;
# every other base (staging, milestone/* — the reversible integration branches) reconciles to
# the fast-lane bar. Key on "is the deploy gate", NOT the literal string "staging", so milestone
# branches reconcile too. Fail closed: only a KNOWN, non-empty, non-`main` LIVE base reconciles
# to the fast lane; an empty/unresolved fetch is treated as the deploy gate (strict) so a base-
# resolution failure (or a caller passing a stale/incorrect --base) can never accidentally
# relax the bar.
# forge#2625: `jq -r '.baseRefName'` stringifies a JSON null to the literal text "null" (not an
# empty string), so the `-n` check alone does not catch it — add an explicit `!= "null"` check
# so a literal-string "null" is treated the same as an empty/unresolved base (strict).
if [ -n "$LIVE_BASE_REF" ] && [ "$LIVE_BASE_REF" != "null" ] && [ "$LIVE_BASE_REF" != "main" ]; then IS_DEPLOY_GATE=false; else IS_DEPLOY_GATE=true; fi
```

**Non-`main` base (`IS_DEPLOY_GATE=false` — staging / milestone)** — reconcile to the fast-lane bar. `review-pr.md`'s Phase 8 guard only parks a PR at `workflow:awaiting-merge` after a clean, mergeable `APPROVED` re-review (the same bot-`APPROVED` signal the normal fast lane auto-merges on), so the only additional condition is this remediation's own quality gate:
1. `GATE_PASSED = true` from this remediation's Phase M3 quality-gate loop.

The strict `APPROVED_COUNT >= 2` verified-human requirement does NOT apply here: it is structurally unsatisfiable for bot-only pipeline review (bot reviews are `authorAssociation=NONE`), and `staging` is reversible — the real human gate is `staging → main`, which no agent performs. This makes the remediation bar identical to the normal fast-lane bar for the same target branch (the issue's core ask). The `authorAssociation` trust filter above is **unchanged** — the relaxation is scoped by *target branch only*, never by *who* may approve (forge#1976/#2519).

**`main` base (`IS_DEPLOY_GATE=true` — deploy gate)** — keep the strict #1809 Q1 bar, BOTH conditions required:
1. `APPROVED_COUNT >= 2` — at least two distinct adversarial `APPROVED:` review comments from repo collaborators (`OWNER`/`MEMBER`/`COLLABORATOR` authorAssociation only — see trust filter above; same counting convention as `work-on.md` Phase 7A).
2. `GATE_PASSED = true` from this remediation's own Phase M3 quality-gate loop.

**Evaluate the base-scoped bar**:
```bash
if [ "$IS_DEPLOY_GATE" = "true" ]; then
  # main / deploy gate — strict verified-human bar
  { [ "${APPROVED_COUNT:-0}" -ge 2 ] && [ "${GATE_PASSED:-false}" = "true" ]; } && BAR_MET=true || BAR_MET=false
else
  # staging / milestone — fast-lane bar (bot APPROVED already implied by workflow:awaiting-merge)
  [ "${GATE_PASSED:-false}" = "true" ] && BAR_MET=true || BAR_MET=false
fi
```

**If the bar is met** (`BAR_MET=true`):
```bash
gh pr merge {PR_NUMBER} {GH_FLAG} --merge
MERGE_STATE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state --jq '.state')
if [ "$MERGE_STATE" = "MERGED" ]; then
  RESOLUTION=$(resolve_script 'transition-label')
  TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
  case "$TIER" in
    adaptive|universal) bash "$SCRIPT_PATH" {ISSUE_NUMBER} {GH_FLAG} merged ;;
    prose)
      gh issue edit {ISSUE_NUMBER} {GH_FLAG} --add-label "workflow:merged" \
        --remove-label "workflow:awaiting-merge,needs-human,workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:invalid,workflow:decomposed" 2>/dev/null || true
      ;;
  esac
  RE_GATE_OUTCOME="AUTO-LANDED"
else
  RE_GATE_OUTCOME="HELD-AWAITING-MERGE"
  # gh pr merge reported success but the PR isn't actually MERGED — leave workflow:awaiting-merge
  # in place (unchanged) and let a human merge manually rather than retrying automatically.
fi
```

**If the bar is NOT met** (`BAR_MET=false`): leave the issue at `workflow:awaiting-merge` exactly as `review-pr.md`'s guard set it — do NOT attempt a merge. `RE_GATE_OUTCOME="HELD-AWAITING-MERGE"`. Fail-safe direction: any doubt about the bar (including an unresolved or unexpected `LIVE_BASE_REF`, which leaves `IS_DEPLOY_GATE=true`-equivalent strict handling) defaults to holding, matching `review-pr.md`'s own existing default for every other caller.

---

## Phase M8: Finalize FORGE:REMEDIATION Paper Trail

Post the completion body to **both** `{PR_NUMBER}` and `{ISSUE_NUMBER}` — this is the single idempotency marker checked by Phase M0 (this file, on future resume) and by the orchestrator's item 6.4 dispatch guard:

```bash
case "$RE_GATE_OUTCOME" in
  AUTO-LANDED)
    # forge#2570: the bar that was met differs by target branch. Non-`main` (staging/milestone)
    # lands on the fast-lane bar (clean re-review APPROVED + quality-gate pass), identical to the
    # normal /work-on path; `main`/deploy-gate lands only on the strict ≥2 verified-human bar.
    if [ "${IS_DEPLOY_GATE:-true}" = "false" ]; then
      AUTO_LAND_BAR_TEXT="MET — fast-lane bar for non-\`main\` base (clean re-review APPROVED + quality gate pass), matching the normal /work-on merge bar for the same target branch"
    else
      AUTO_LAND_BAR_TEXT="MET (${APPROVED_COUNT:-0} APPROVED: reviews + quality gate pass)"
    fi
    OUTCOME_DETAIL="to {PR_BASE}" ;;
  HELD-AWAITING-MERGE) AUTO_LAND_BAR_TEXT="NOT MET (${APPROVED_COUNT:-0} APPROVED: reviews)"; OUTCOME_DETAIL="at workflow:awaiting-merge" ;;
  WAITING)             AUTO_LAND_BAR_TEXT="N/A — waiting for explicit prerequisite"; OUTCOME_DETAIL="at blocked" ;;
  ENGINE-ERROR)        AUTO_LAND_BAR_TEXT="N/A — resumable mechanical failure"; OUTCOME_DETAIL="at workflow:engine-error/review-degraded" ;;
  AUTHORITY-REQUIRED)  AUTO_LAND_BAR_TEXT="N/A — proven human authority required"; OUTCOME_DETAIL="at needs-human" ;;
  *)                   AUTO_LAND_BAR_TEXT="N/A"; OUTCOME_DETAIL="" ;;
esac

REMEDIATION_BODY="<!-- FORGE:REMEDIATION -->
## Remediation Complete for PR #{PR_NUMBER}

**Findings addressed**: ${#ADDRESSED_FINDING_NUMBERS[@]} (${ADDRESSED_FINDING_NUMBERS[*]:-none})
**Re-review verdict**: ${RE_REVIEW_VERDICT:-unknown}
**Auto-land bar**: ${AUTO_LAND_BAR_TEXT}
**Re-gate outcome**: ${RE_GATE_OUTCOME} ${OUTCOME_DETAIL}

<!-- FORGE:REMEDIATION:COMPLETE -->"

gh pr comment {PR_NUMBER} {GH_FLAG} --body "$REMEDIATION_BODY"
gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "$REMEDIATION_BODY"
```

**If the outcome was `AUTO-LANDED`**: this Skill invocation is itself the caller's terminal delegate (Phase 0A.1 of `work-on.md` already told its own routing loop to STOP after dispatching here) — so `remediate.md` must drive the close phase itself rather than assume some other inline logic will. Invoke the close subcommand directly, the same way `work-on/review.md` does when it hands off from a spawned sub-agent context:

```
Skill("work-on:close", args="{ISSUE_NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --pr {PR_NUMBER} --base {PR_BASE}")
```

`work-on:close` handles project board update, final issue body, parent tracker, trajectory log, and worktree cleanup (including the remediation worktree at `{WORKTREE_PATH}`) — do not duplicate any of that here.

**If the outcome was `HELD-AWAITING-MERGE`, `WAITING`, `ENGINE-ERROR`, or `AUTHORITY-REQUIRED`**: preserve the resumable worktree when safe and return the structured result without invoking close. Do not imply a human is needed for the first three outcomes.

---

## Output

Return this structured block to the caller:

```
REMEDIATE_RESULT:
  status: COMPLETE | ALREADY_DONE | WAITING | AUTHORITY_REQUIRED | BLOCKED
  pr_number: {PR_NUMBER}
  issue_number: {ISSUE_NUMBER}
  re_gate_outcome: AUTO-LANDED | HELD-AWAITING-MERGE | WAITING | ENGINE-ERROR | AUTHORITY-REQUIRED | N/A
  findings_addressed: [{finding_number}, ...]
  blocker: {description if status=BLOCKED}
```

**Caller behavior**: this Skill drives close only for `AUTO-LANDED`. Other outcomes preserve their explicit block class: `blocked` waits for a dependency event, `workflow:engine-error`/`review-degraded` is automatically recoverable, `workflow:awaiting-merge` waits for protected-target approval, and only `AUTHORITY-REQUIRED` uses `needs-human`. The caller must not collapse these states back into one label.
