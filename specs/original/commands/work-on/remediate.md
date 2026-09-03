---
description: Remediate subcommand — checkout a needs-human PR, fix review findings, re-review, and re-gate with a FORGE:REMEDIATION paper trail
argument-hint: "[PR number] [--issue N] [--repo GH_REPO] [--gh-flag GH_FLAG] [--base PR_BASE] [--inline-review-blockers --reviewed-head SHA --round N]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/remediate — Remediation Subcommand

**Input**: $ARGUMENTS

**Invoked by**:
- `work-on.md` Phase 0A, standalone: `/work-on <pr> --remediate` (see forge#1813).
- `commands/orchestrate/phase-4-execution.md` item 6.4, auto-dispatched against a `needs-human`-gated predecessor's own open PR.
- The active work-on coordinator after an exact current-head `CHANGES REQUESTED` result, with the mandatory explicit handoff `--inline-review-blockers --reviewed-head {FULL_SHA} --round {N}`.

**Output**: Checkout the PR's existing branch → classify the block reason (fixable vs. policy escalation) → apply fixes → quality-gate → commit/push → re-invoke `/review-pr --auto-merge` → compute the #1809 Q1 auto-land bar → merge-if-verified or hold at `workflow:awaiting-merge` → emit a `FORGE:REMEDIATION` paper trail. Return result to caller.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
**NEVER use plan mode (EnterPlanMode).**

**Scope note**: This mode owns exactly one gap — re-driving a `needs-human` PR's own remediation. It does NOT implement the `needs-human` sub-label taxonomy (#1815's scope) and it does NOT edit `review-pr.md`'s Phase 8 guard (forge#1810) — that guard's existing safe-default (`workflow:awaiting-merge` on any clean re-review of a previously-escalated PR) is reused as-is; this file only adds a bar-check *after* that guard has already fired.

### Inline current-head blocker remediation (authoritative override)

When the active `work-on` coordinator reaches this phase directly from a current-head
`CHANGES REQUESTED` review, this is inline code-blocker remediation, not the legacy
standalone `needs-human` entry path. In that mode, the M0 `needs-human` prerequisite and
PR-global single-attempt stop do not apply. Attempt identity is the reviewed head plus the
configured remediation round; the configured round cap remains mandatory.

Before any edit, reload every current-head blocker and post exactly one
`FORGE:REMEDIATION_PLAN` containing a **blocker closure matrix** with one row per blocker
occurrence:

| Required column | Meaning |
|---|---|
| Blocker | Stable finding/occurrence ID and reviewer scenario/evidence |
| Shared invariant | The common safety/correctness boundary being repaired |
| Code boundary | Exact affected path/symbol authorized by the Builder Contract |
| Failing-before proof | Deterministic regression command that fails on the reviewed head |
| Passing-after proof | The same command and expected result after the cohesive patch |

If a safe deterministic regression cannot reproduce a row, provide an equivalent
machine-checkable proof and state why a test is unavailable. Add at least one end-to-end
test covering the shared invariant. Iterate edits/tests/replanning on the same local head
until every closure row passes. These local iterations do not consume additional rounds.
Only publishing one substantive new head for a fresh complete panel consumes the round.
Do not publish that head or launch the panel while any row is unproven.

Inline mode persists these exact tuple-scoped markers on the PR and linked issue:

```text
<!-- FORGE:REMEDIATION pr={PR_NUMBER} head={REVIEWED_HEAD} round={N} -->
<!-- FORGE:REMEDIATION:COMPLETE pr={PR_NUMBER} head={POST_REVIEW_HEAD} round={N} -->
```

The complete marker is written only after the fresh panel returns. Distinct complete
marker heads are the durable round counter used by the next invocation.

A finding remains open until the fresh current-head review no longer returns its
occurrence. Never close findings optimistically before re-review. If a fresh panel returns
a blocker, carry its exact scenario/evidence into the next closure matrix when another
configured round remains; after cap exhaustion, fail closed without another new head.

### Unattended verification and irreversible-side-effect proof

For non-interactive/headless remediation, execute verification in the coordinator process.
A background verifier is allowed only when it durably persists the same-lifecycle
continuation and automatically wakes that coordinator on every terminal state: completed,
failed, killed, or cancelled. A launch receipt or progress response is not verification.
Resource-sensitive packed-package smoke checks must run in a separate bounded serial
step. They remain mandatory and must be joined into the one final verification result
before push; do not run them inside the parallel aggregate suite.

When a closure row touches an irreversible provider action (merge, deploy, branch deletion,
publication, credential mutation, or equivalent), its proof must cover:

1. all authority and preconditions before the side effect;
2. the exact provider result bound to the durable receipt;
3. idempotent replay/reconciliation after provider success;
4. recovery when the process fails between side effect and durable receipt.

Stop remediation and publish `FORGE:REINVESTIGATE_REQUIRED` when fresh evidence shows the
accepted approach is invalid: no reachable active caller, a new authority boundary absent
from the Builder Contract, implementation in dormant/legacy machinery while another path
is authoritative, or repeated HIGH blockers in the same invariant after a substantive
remediation head. Include the invalidated approach, surviving evidence, and proposed
decomposition. Investigation/decomposition—not another remediation round—owns replacement
of architecture or scope.

**Engine coverage** (forge#2379, #2889): this subcommand's `command` name (`work-on/remediate`) and completion marker (`FORGE:REMEDIATION:COMPLETE`, including the `**Re-gate outcome**` field Phase M8 posts below) are registered in the headless engine's phase table — `RESERVED_TYPES.REMEDIATION` in `packages/protocol/src/types.js`, `remediate` in `packages/protocol/src/phases.js`'s `PHASE_IDS`/`PHASE_MARKERS`, and a matching `remediate` entry in `bin/engine/phases.mjs`'s `PHASES` array. A blocked review is committed with `terminalReason: "needs-human"`, then the engine continues directly into remediation; the divergence guard permits this specific handoff while keeping all other `needs-human` states paused.

---

## Inputs

Parse from $ARGUMENTS:
- `{PR_NUMBER}` — PR number to remediate (required, first positional arg). This is the `needs-human`-gated PR itself, NOT the linked issue number.
- `--issue {ISSUE_NUMBER}` — linked issue number (optional). If absent, resolved in Phase M0 from the PR body's `Closes #N` reference.
- `--repo {GH_REPO}` — GitHub repo (resolved from `forge.yaml → project` if omitted)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag
- `--base {PR_BASE}` — PR target branch (optional; resolved from the PR's `baseRefName` if omitted)
- `--inline-review-blockers` — explicit current-head inline remediation mode; never inferred from labels or comments.
- `--reviewed-head {FULL_SHA}` — exact reviewed PR head required with inline mode.
- `--round {N}` — substantive remediation round required with inline mode.

During argument parsing, initialize `INLINE_REMEDIATION=false`, `REVIEWED_HEAD=""`, and
`REMEDIATION_ROUND=""`; set `INLINE_REMEDIATION=true` only when
`--inline-review-blockers` is present, and assign the following flag values to the other
two variables. Inline mode requires all three inline flags together. A partial flag set
is a usage error.

Resolve the assigned repository root with `git rev-parse --show-toplevel` and read only
its literal `forge.yaml`; environment or caller overrides are not authority. The cap's
authoritative key is `review.remediation_max_rounds`. Use the
package's YAML dependency directly so this path has no optional parser branch:

```bash
REPOSITORY_ROOT=$(git rev-parse --show-toplevel)
CONFIG_FILE="$REPOSITORY_ROOT/forge.yaml"
CONFIG_VALUES=$(node --input-type=module - "$CONFIG_FILE" <<'NODE'
import fs from "node:fs";
import YAML from "yaml";
const config = YAML.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify({
  staging: config?.branches?.staging ?? "",
  maxRounds: config?.review?.remediation_max_rounds ?? 3,
}));
NODE
)
STAGING_BRANCH=$(echo "$CONFIG_VALUES" | jq -r '.staging')
MAX_REMEDIATION_ROUNDS=$(echo "$CONFIG_VALUES" | jq -r '.maxRounds')
```

Reject a missing staging branch, a non-integer cap, or a cap outside `1..10`. Count distinct durable,
tuple-scoped `FORGE:REMEDIATION:COMPLETE` reviewed-head markers for this PR.
`REMEDIATION_ROUND` must equal the next substantive round, and remediation stops before
mutation when it exceeds `MAX_REMEDIATION_ROUNDS`. Local same-head edit/test/replan
iterations do not change the round.

---

## Phase M0: Load State & Guard Rails (MANDATORY)

Re-read current state before doing anything:

```bash
PR_STATE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state,headRefName,headRefOid,baseRefName,body,mergeable,mergeStateStatus,url)
PR_OPEN_STATE=$(echo "$PR_STATE" | jq -r '.state')
HEAD_BRANCH=$(echo "$PR_STATE" | jq -r '.headRefName')
PR_BASE="${PR_BASE:-$(echo "$PR_STATE" | jq -r '.baseRefName')}"
PR_BODY=$(echo "$PR_STATE" | jq -r '.body')
CURRENT_PR_HEAD=$(echo "$PR_STATE" | jq -r '.headRefOid // empty')
```

Set the mode-independent target identity before finding selection:

```bash
if [ "$INLINE_REMEDIATION" = "true" ]; then
  TARGET_REVIEWED_HEAD="$REVIEWED_HEAD"
else
  TARGET_REVIEWED_HEAD="$CURRENT_PR_HEAD"
fi
```

For inline mode, require `REVIEWED_HEAD` to be a full SHA and equal `CURRENT_PR_HEAD`. A
mismatch is a stale handoff: stop before finding selection or mutation. Legacy standalone
mode rejects inline-only flags and uses the current PR head as its target identity.

**PR state guard**:
- `PR_OPEN_STATE = MERGED` → set `PR_ALREADY_MERGED=true`; do not return before linked-issue close/trajectory/cleanup reconciliation.
- `PR_OPEN_STATE = CLOSED` (not merged) → EXIT `REMEDIATE_RESULT: status: BLOCKED`, blocker: "PR #{PR_NUMBER} is closed, not merged — nothing to remediate."

**Resolve the linked issue** (`--issue` flag takes precedence; else parse from the PR body — anchored, matching the `"Closes #N" in:body` precedent from forge#1634/#1646, never a bare-number scan):

```bash
ISSUE_NUMBER="${ISSUE_NUMBER:-$(echo "$PR_BODY" | grep -oP '(?i)\bCloses #\K\d+' | head -1)}"
if [ -z "$ISSUE_NUMBER" ]; then
  echo "BLOCKED: cannot resolve linked issue — pass --issue explicitly"
  # EXIT REMEDIATE_RESULT: status: BLOCKED, blocker: "cannot resolve linked issue — pass --issue explicitly"
fi
if [ "${PR_ALREADY_MERGED:-false}" = "true" ]; then
  Skill("work-on:close", args="{ISSUE_NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --pr {PR_NUMBER} --base {PR_BASE}")
  # Require issue-close, trajectory, and cleanup read-back before returning ALREADY_DONE.
  # EXIT REMEDIATE_RESULT: status: ALREADY_DONE
fi
```

**Load the linked issue and validate it is a genuine remediation target**:

```bash
ISSUE_STATE=$(gh issue view {ISSUE_NUMBER} {GH_FLAG} --json labels,state,body,milestone)
ISSUE_LABELS=$(echo "$ISSUE_STATE" | jq -r '[.labels[].name] | join(",")')
```

- **Legacy standalone mode:** if `needs-human` is NOT among `ISSUE_LABELS` → EXIT `REMEDIATE_RESULT: status: BLOCKED`, blocker: "issue #{ISSUE_NUMBER} is not `needs-human` — legacy remediation only targets `needs-human`-gated PRs; use the normal `/work-on {ISSUE_NUMBER}` resume path instead."
- **Inline mode:** require `workflow:in-review` (or the exact non-terminal review state defined by the caller), a matching current PR head, and at least one revalidated current-head blocker. Do not require or add `needs-human`.

**Idempotency / resume check** — the paper trail lives on **both** the PR and linked
issue. Select one exact attempt marker, and retain both object IDs and bodies:

```bash
if [ "$INLINE_REMEDIATION" = "true" ]; then
  START_MARKER="<!-- FORGE:REMEDIATION pr={PR_NUMBER} head=${TARGET_REVIEWED_HEAD} round=${REMEDIATION_ROUND} -->"
else
  START_MARKER="<!-- FORGE:REMEDIATION -->"
fi
PR_REMEDIATION_COMMENT=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  | jq --arg marker "$START_MARKER" '[.[] | select(.body | contains($marker))] | last // {}')
ISSUE_REMEDIATION_COMMENT=$(gh api repos/{GH_REPO}/issues/{ISSUE_NUMBER}/comments \
  | jq --arg marker "$START_MARKER" '[.[] | select(.body | contains($marker))] | last // {}')
PARTIAL_PR_COMMENT_ID=$(echo "$PR_REMEDIATION_COMMENT" | jq -r '.id // empty')
PARTIAL_ISSUE_COMMENT_ID=$(echo "$ISSUE_REMEDIATION_COMMENT" | jq -r '.id // empty')
PR_REMEDIATION_BODY=$(echo "$PR_REMEDIATION_COMMENT" | jq -r '.body // ""')
ISSUE_REMEDIATION_BODY=$(echo "$ISSUE_REMEDIATION_COMMENT" | jq -r '.body // ""')
if [ "$INLINE_REMEDIATION" = "true" ]; then
  ALL_PR_COMMENTS=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments)
  INLINE_COMPLETED_TUPLES=$(echo "$ALL_PR_COMMENTS" | jq -r '.[].body // ""' \
    | grep -oE "<!-- FORGE:REMEDIATION:COMPLETE pr={PR_NUMBER} head=[0-9a-fA-F]{40} round=[0-9]+ -->" \
    | sed -E 's/.*head=([0-9a-fA-F]{40}) round=([0-9]+).*/\1 \2/' || true)
  if echo "$INLINE_COMPLETED_TUPLES" | awk -v head="$TARGET_REVIEWED_HEAD" -v round="$REMEDIATION_ROUND" '$1 == head && $2 == round { found=1 } END { exit (found ? 0 : 1) }'; then
    echo "REMEDIATE_RESULT: status: ALREADY_DONE"
    exit 0
  fi
  MAX_COMPLETED_ROUND=$(echo "$INLINE_COMPLETED_TUPLES" | awk 'BEGIN { max=0 } $2 > max { max=$2 } END { print max }')
  EXPECTED_REMEDIATION_ROUND=$((MAX_COMPLETED_ROUND + 1))
  [ "$REMEDIATION_ROUND" -eq "$EXPECTED_REMEDIATION_ROUND" ] || {
    echo "BLOCKED: expected remediation round $EXPECTED_REMEDIATION_ROUND, got $REMEDIATION_ROUND"
    exit 1
  }
  [ "$REMEDIATION_ROUND" -le "$MAX_REMEDIATION_ROUNDS" ] || {
    echo "GATED: remediation round cap exhausted before mutation"
    exit 1
  }
fi
```

- **Legacy standalone mode:** an unscoped complete marker is `ALREADY_DONE`; preserve its
  single-attempt semantics.
- **Inline mode:** ignore legacy unscoped markers. If a scoped complete marker already
  exists for `(PR, REMEDIATION_ROUND)`, the round is `ALREADY_DONE`. A different head may
  continue only at the next derived round and below the authoritative cap.
- If an exact start marker exists without its matching scoped completion, delete only
  those exact partial PR/issue comments by their retrieved IDs, then restart the same
  round. Never delete another head/round's artifact:
  ```bash
  [ -z "$PARTIAL_PR_COMMENT_ID" ] || gh api repos/{GH_REPO}/issues/comments/$PARTIAL_PR_COMMENT_ID -X DELETE
  [ -z "$PARTIAL_ISSUE_COMMENT_ID" ] || gh api repos/{GH_REPO}/issues/comments/$PARTIAL_ISSUE_COMMENT_ID -X DELETE
  ```
- If no exact attempt marker exists, continue as a fresh attempt.

---

## Phase M1: Load Prior Findings & Classify the Block Reason

Gather everything that caused (or is still causing) `needs-human`:

**M1a — Open current-head review-finding occurrences spawned from this PR**:

Title matching is discovery only, never remediation authority. For each candidate, read
its body and comments and require both the source PR and reviewed-head identity from a
structured marker such as `FORGE:REVIEW_FINDING ... head={FULL_SHA}`. Select only
occurrences whose source PR is `{PR_NUMBER}` and whose head equals `TARGET_REVIEWED_HEAD`.

A legacy candidate without a head marker must remain open. It may enter the closure
matrix only after the coordinator revalidates its exact reviewer scenario against the
current head and posts:

```text
<!-- FORGE:REMEDIATION_BINDING finding={OCCURRENCE_ID} pr={PR_NUMBER} head={TARGET_REVIEWED_HEAD} -->
```

An occurrence that cannot be revalidated or identified remains open, is excluded from
automatic remediation/closure, and is reported as residual evidence. Never infer current
head identity from title text, line proximity, or the fact that an issue is still open.

**M1b — PR review verdicts and merge-block reasons** (Phase 8 of `review-pr.md` records the exact block reason on the linked issue when it aborts auto-merge — read that trail rather than re-deriving it):
```bash
BLOCK_COMMENTS=$(gh api repos/{GH_REPO}/issues/{ISSUE_NUMBER}/comments \
  --jq '[.[] | select(.body | test("Auto-merge aborted|not mergeable|Pre-Push Ancestry Guard Failed|Push Failed|Quality Gate Failed"; "i"))] | last')
```

**Classify into FIXABLE vs. UNFIXABLE**:
- **FIXABLE** — open `review-finding` issues (CONFIRMED/LIKELY code defects), a `VERDICT=CHANGES REQUESTED` block with concrete findings attached, a mergeability guard failure (`CONFLICTING`/`DIRTY`/`BLOCKED` — resolvable by rebasing onto `{PR_BASE}`), or a quality-gate/build failure.
- **UNFIXABLE (policy escalation)** — `HAS_PURPOSE_REGRESSION=true` (the PR's behavior diverges from the issue's intent — a judgment call, not a code defect), `CALIBRATION_NEEDS_HUMAN=true` (statistical trust threshold), or `TRUST_NEEDS_HUMAN=true` (provenance `NOVEL_NEEDS_HUMAN` tier, insufficient prior data — a policy gate, not a bug). None of these are mechanically "fixable" by re-editing code.

**If the block reason classifies as UNFIXABLE** (and no FIXABLE item accompanies it): do NOT attempt any fix. Skip directly to Phase M8 with verdict `UNFIXABLE`, re-affirm `needs-human` (it should already be present), and return `REMEDIATE_RESULT: status: UNFIXABLE`. This satisfies AC5 — "genuinely-blocked PRs still terminate at `needs-human`."

**If at least one FIXABLE item exists**: transition the issue out of its terminal gate before proceeding to Phase M2. `needs-human` represents the prior review result, not an active automated remediation run; retaining it would make the dispatcher and recovery paths stop while remediation is in progress. Keep exactly one active workflow state:

```bash
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "DRY_RUN: would replace needs-human with workflow:in-review on issue #{ISSUE_NUMBER}"
else
  gh issue edit {ISSUE_NUMBER} {GH_FLAG} \
    --add-label "workflow:in-review" \
    --remove-label "needs-human" 2>/dev/null || true # <!-- allowlist:check-command-side-effects -->
fi
```

Do not perform this transition for an UNFIXABLE policy escalation. Mechanical checkout, quality-gate, push, provider, or publication failures produce automated `GATED`/`review-degraded` evidence and never add `needs-human`. Only a genuine policy or human-authority result may add `needs-human`; after such a re-review, remove `workflow:in-review` whenever that terminal label is present.

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

If the worktree/branch checkout fails for any reason (branch deleted, force-pushed out from under us, etc.): post automated `GATED`/`review-degraded` evidence and EXIT `REMEDIATE_RESULT: status: BLOCKED`. Do not add `needs-human`.

---

## Phase M3: Apply Fixes

For all FIXABLE items from Phase M1, first build the single blocker closure matrix defined above and cluster rows by shared invariant. Read every affected file in `{WORKTREE_PATH}` before editing (never assume current state), then apply one cohesive fix rather than sequential line-local patches. Follow the same implementation discipline as `work-on.md` Phase 3F (cross-lane import guard, library-callback verification, deliverable-type consistency, no unrequested scope) — this file does not restate those rules, it inherits them.

Before Phase M4, run every failing-before/passing-after command and the shared-invariant end-to-end test. Do not commit, push, or consume a fresh-review round until every matrix row has machine-checkable passing evidence.

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
If still failing after 3 iterations: post automated `GATED`/`review-degraded` evidence and EXIT `REMEDIATE_RESULT: status: BLOCKED`. Do not add `needs-human` or proceed to re-review with an unresolved gate failure.

**Format/verify**: run the project's configured `verification.commands` (same as Phase 3H) before committing.

---

## Phase M4: Commit, Push, and Close Addressed Findings

```bash
cd {WORKTREE_PATH}
git add -u
git commit -s -m "fix(remediate): {description} (#{ISSUE_NUMBER})"
git push origin {HEAD_BRANCH}
```

If push fails, retry with `--force-with-lease` only when M3 explicitly authorized a history rewrite for conflict resolution. If it still fails: post automated `GATED`/`review-degraded` evidence and EXIT `REMEDIATE_RESULT: status: BLOCKED`. Do not add `needs-human`.

**Do not close review-finding issues in this phase.** Preserve candidates separately
from findings that fresh review has actually cleared:

```bash
CANDIDATE_FINDING_NUMBERS=({FIXABLE_FINDING_NUMBERS_FROM_M1})
ADDRESSED_FINDING_NUMBERS=()
```

Keep every candidate open until Phase M6's fresh current-head panel proves that its exact
occurrence is absent. A local patch or passing quality gate is not closure authority.

---

## Phase M5: Post Interim FORGE:REMEDIATION Progress (before re-review)

Post the same body to **both** `{PR_NUMBER}` and `{ISSUE_NUMBER}` (PR copy is the idempotency source of truth; issue copy keeps the standard trajectory/resume logic consistent):

```bash
gh pr comment {PR_NUMBER} {GH_FLAG} --body "${START_MARKER}
## Remediation In Progress for PR #{PR_NUMBER}

**Candidate findings patched (pending fresh-review closure)**:
{bulleted list: finding # — title — one-line fix summary}

**Commit**: {COMMIT_SHA}
**Quality gate**: {iterations} iteration(s), PASS

Re-invoking \`/review-pr --auto-merge\` now."
gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "${START_MARKER}
## Remediation In Progress for PR #{PR_NUMBER}

**Candidate findings patched (pending fresh-review closure)**:
{bulleted list: finding # — title — one-line fix summary}

**Commit**: {COMMIT_SHA}
**Quality gate**: {iterations} iteration(s), PASS

Re-invoking \`/review-pr --auto-merge\` now."
```

`START_MARKER` is tuple-scoped in inline mode and unscoped only in legacy mode. Its lack of `:COMPLETE` records an in-progress exact attempt; M0 may delete/restart only that matching tuple after interruption.

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

- **Re-escalated**: in inline mode, fresh deterministic code blockers remain `workflow:in-review` for the next available configured round, or become automated `GATED`/`review-degraded` after cap exhaustion; they never imply `needs-human`. Purpose, calibration, trust, or other genuine human-authority results may add `needs-human` and remove `workflow:in-review`. Legacy standalone mode retains its historical human-escalation behavior.
- **Clean re-review**: `VERDICT=APPROVED`-equivalent, mergeable, and the "Previously-escalated re-review guard" (forge#1810) fires — setting `workflow:awaiting-merge` and removing `workflow:in-review`, *without* auto-merging (that guard's own safe default, left untouched by this file).

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
POST_REVIEW_HEAD=$(gh pr view {PR_NUMBER} {GH_FLAG} --json headRefOid --jq '.headRefOid // empty')
```

If fresh review proves the accepted approach is invalid (the triggers defined above), set
`REINVESTIGATE_REQUIRED=true` and take this explicit cap-safe branch before Phase M7:

```bash
if [ "${REINVESTIGATE_REQUIRED:-false}" = "true" ]; then
  REINVESTIGATE_MARKER="<!-- FORGE:REINVESTIGATE_REQUIRED pr={PR_NUMBER} head=${POST_REVIEW_HEAD} round=${REMEDIATION_ROUND} -->"
  COMPLETE_MARKER="<!-- FORGE:REMEDIATION:COMPLETE pr={PR_NUMBER} head=${POST_REVIEW_HEAD} round=${REMEDIATION_ROUND} -->"
  REINVESTIGATE_BODY="${REINVESTIGATE_MARKER}
${COMPLETE_MARKER}
## Remediation Approach Invalidated

**Invalidated approach**: {summary}
**Surviving evidence**: {current-head findings and invariant}
**Proposed next action**: return to investigation/decomposition; preserve the PR as historical evidence.

No new remediation head or panel is authorized from this invocation."
  gh pr comment {PR_NUMBER} {GH_FLAG} --body "$REINVESTIGATE_BODY"
  gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "$REINVESTIGATE_BODY"
  Skill(skill="work-on/investigate", args="{ISSUE_NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --reinvestigate-from-pr {PR_NUMBER}")
  # EXIT REMEDIATE_RESULT: status: BLOCKED, re_gate_outcome: REINVESTIGATE_REQUIRED
fi
```

The tuple-scoped completion marker consumes the reviewed round before returning to
investigation, so restart cannot delete/replay it as an interrupted attempt. Keep all
finding issues open.

After Phase M6, compare the fresh current-head findings with the closure matrix. For each
candidate occurrence absent from the complete fresh panel, close its issue with a comment
binding the remediation commit and append its number to `ADDRESSED_FINDING_NUMBERS[]`.
Keep every returned, deferred, or unrelated occurrence open and carry its updated
scenario/evidence forward when another configured round remains. Phase M8 reports only
`ADDRESSED_FINDING_NUMBERS[]`, never the unverified candidate list.

---

## Phase M7: Compute the #1809 Q1 Auto-Land Bar

Re-read the issue's current labels after M6:
```bash
POST_REVIEW_LABELS=$(gh issue view {ISSUE_NUMBER} {GH_FLAG} --json labels --jq '[.labels[].name] | join(",")')
```

**If `needs-human` is present** (re-escalated case): the bar does not apply — nothing to compute. `RE_GATE_OUTCOME="RE-ESCALATED"`. Skip to Phase M8.

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

# forge#2570: only the known reversible integration bases use the fast-lane bar:
# the exact configured `staging` branch and `milestone/*`. `main`, empty/null values,
# and every unknown branch name fail closed as deploy-gate/hold. A caller-controlled
# `--base` never participates in this allowlist decision.
if { [ -n "${STAGING_BRANCH:-}" ] && [ "$LIVE_BASE_REF" = "$STAGING_BRANCH" ]; } || [[ "$LIVE_BASE_REF" == milestone/* ]]; then
  IS_DEPLOY_GATE=false
else
  IS_DEPLOY_GATE=true
fi
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
PRE_MERGE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state,headRefOid,baseRefName)
[ "$(echo "$PRE_MERGE" | jq -r '.state')" = "OPEN" ] || { echo "GATED: PR is not open"; exit 1; }
[ "$(echo "$PRE_MERGE" | jq -r '.headRefOid')" = "$POST_REVIEW_HEAD" ] || { echo "GATED: PR head changed after review"; exit 1; }
[ "$(echo "$PRE_MERGE" | jq -r '.baseRefName')" = "$LIVE_BASE_REF" ] || { echo "GATED: PR base changed after review"; exit 1; }

gh pr merge {PR_NUMBER} {GH_FLAG} --merge --match-head-commit "$POST_REVIEW_HEAD"
MERGE_RESULT=$(gh pr view {PR_NUMBER} {GH_FLAG} --json state,mergeCommit,headRefOid,baseRefName)
MERGE_STATE=$(echo "$MERGE_RESULT" | jq -r '.state')
MERGE_SHA=$(echo "$MERGE_RESULT" | jq -r '.mergeCommit.oid // empty')
if [ "$MERGE_STATE" = "MERGED" ] && [[ "$MERGE_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  MERGE_RECEIPT="<!-- FORGE:REMEDIATION_MERGE_RECEIPT pr={PR_NUMBER} reviewed_head=${POST_REVIEW_HEAD} merge_sha=${MERGE_SHA} base=${LIVE_BASE_REF} -->"
  gh pr comment {PR_NUMBER} {GH_FLAG} --body "$MERGE_RECEIPT"
  gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "$MERGE_RECEIPT"
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
  RE-ESCALATED)        AUTO_LAND_BAR_TEXT="N/A — re-escalated before the bar was evaluated"; OUTCOME_DETAIL="at needs-human" ;;
  UNFIXABLE)           AUTO_LAND_BAR_TEXT="N/A — unfixable (see Phase M1 classification)"; OUTCOME_DETAIL="at needs-human" ;;
  *)                   AUTO_LAND_BAR_TEXT="N/A"; OUTCOME_DETAIL="" ;;
esac

POST_REVIEW_HEAD=$(gh pr view {PR_NUMBER} {GH_FLAG} --json headRefOid --jq '.headRefOid // empty')
if ! [[ "$POST_REVIEW_HEAD" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "BLOCKED: fresh review returned no exact PR head"
  # EXIT REMEDIATE_RESULT: status: BLOCKED
fi
if [ "$INLINE_REMEDIATION" = "true" ]; then
  COMPLETE_MARKER="<!-- FORGE:REMEDIATION:COMPLETE pr={PR_NUMBER} head=${POST_REVIEW_HEAD} round=${REMEDIATION_ROUND} -->"
  COMPLETION_TRAILER=""
else
  COMPLETE_MARKER="<!-- FORGE:REMEDIATION -->"
  COMPLETION_TRAILER="<!-- FORGE:REMEDIATION:COMPLETE -->"
fi
REMEDIATION_BODY="${COMPLETE_MARKER}
## Remediation Complete for PR #{PR_NUMBER}

**Findings addressed**: ${#ADDRESSED_FINDING_NUMBERS[@]} (${ADDRESSED_FINDING_NUMBERS[*]:-none})
**Re-review verdict**: ${RE_REVIEW_VERDICT:-unknown}
**Auto-land bar**: ${AUTO_LAND_BAR_TEXT}
**Re-gate outcome**: ${RE_GATE_OUTCOME} ${OUTCOME_DETAIL}

${COMPLETION_TRAILER}"

gh pr comment {PR_NUMBER} {GH_FLAG} --body "$REMEDIATION_BODY"
gh issue comment {ISSUE_NUMBER} {GH_FLAG} --body "$REMEDIATION_BODY"
```

**If the outcome was `AUTO-LANDED`**: this Skill invocation is itself the caller's terminal delegate (Phase 0A.1 of `work-on.md` already told its own routing loop to STOP after dispatching here) — so `remediate.md` must drive the close phase itself rather than assume some other inline logic will. Invoke the close subcommand directly, the same way `work-on/review.md` does when it hands off from a spawned sub-agent context:

```
Skill("work-on:close", args="{ISSUE_NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --pr {PR_NUMBER} --base {PR_BASE}")
```

`work-on:close` handles project board update, final issue body, parent tracker, trajectory log, and worktree cleanup (including the remediation worktree at `{WORKTREE_PATH}`) — do not duplicate any of that here.

**If the outcome was `HELD-AWAITING-MERGE`, `RE-ESCALATED`, `REINVESTIGATE_REQUIRED`, or `UNFIXABLE`**: leave the worktree in place and return the structured result below without invoking close. `REINVESTIGATE_REQUIRED` has already invoked investigation/decomposition; do not close the issue.

---

## Controlled staging refresh during remediation

Before accepting a remediation re-review or evaluating the merge bar, re-fetch the
authoritative `refs/heads/staging` and compare its exact SHA with the recorded review
base. A changed target may continue only after proving an authorized reachable sibling
merge and publishing `FORGE:BASE_REFRESH` with immutable launch SHA, old/new base SHAs,
target ref, sibling merge SHA, merge-base SHA, and attempt.

Preserve the owned remediation branch and existing PR. Synchronize the verified target
non-destructively with the expected remote-head lease; conflicts, ambiguous movement,
non-fast-forward movement, or lease mismatch are GATED. Rerun every affected quality
and acceptance check. Invalidate all prior reviewer receipts and approvals, freeze the
new exact base/head/merge-base tuple, and run a fresh complete re-review. Do not count
pre-refresh findings or checks as authorization, exceed the configured remediation
round cap, widen the Builder Contract, or weaken protected-branch rules. See
`specs/qualitative-review-protocol.md`.

## Output

Return this structured block to the caller:

```
REMEDIATE_RESULT:
  status: COMPLETE | ALREADY_DONE | UNFIXABLE | BLOCKED
  pr_number: {PR_NUMBER}
  issue_number: {ISSUE_NUMBER}
  re_gate_outcome: AUTO-LANDED | HELD-AWAITING-MERGE | RE-ESCALATED | REINVESTIGATE_REQUIRED | UNFIXABLE | N/A
  findings_addressed: [{finding_number}, ...]
  blocker: {description if status=BLOCKED}
```

**Caller behavior**: this Skill drives close when `AUTO-LANDED`. `REINVESTIGATE_REQUIRED` transfers control to investigation/decomposition with tuple-bound evidence and is terminal only for the current remediation invocation. Other non-land outcomes preserve their durable gated/awaiting state. The caller must never start another remediation head above the cap.
