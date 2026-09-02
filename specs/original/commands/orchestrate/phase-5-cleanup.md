---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Phase 5: Post-Batch Cleanup

## Phase 5: Post-Batch Cleanup

**This phase is MANDATORY after every orchestration batch and strictly batch-owned.** It may mutate only identities recorded by this confirmed batch. Repository-wide maintenance is never part of orchestration cleanup.

### Step 5A: Reconcile and clean current-batch ownership

Do **not** invoke `/cleanup all`, scan every closed/open issue for mutation, enumerate every repository worktree, or prune repository-wide branches.

Work-on children own their issue labels, closure, PR branch, and issue worktree; Phase 5 never repairs those by search. Pi handoffs own child worktree/branch cleanup. Phase 5 may remove only clean detached target-base worktrees whose paths remain in this uninterrupted session's in-memory allowlist. After compaction or resume, missing ownership means **skip and report**, never reconstruct deletion authority.

```bash
if ! declare -p BATCH_BASE_WORKTREES >/dev/null 2>&1; then
  echo "No in-memory batch-base ownership; skipping base removal."
elif [ "${#BATCH_BASE_WORKTREES[@]}" -eq 0 ] || [ -z "${ORCHESTRATOR_BASE_DIR:-}" ]; then
  echo "Empty in-memory batch-base ownership; skipping base removal."
else
  if ! BASE_ROOT_REAL=$(realpath -e -- "$ORCHESTRATOR_BASE_DIR") \
    || [ "${BASE_ROOT_REAL#/}" = "$BASE_ROOT_REAL" ]; then
    echo "Invalid batch-base ownership root; skipping base removal."
  else
    for BASE in "${BATCH_BASE_WORKTREES[@]}"; do
      if ! BASE_REAL=$(realpath -e -- "$BASE"); then echo "SKIP missing base: $BASE"; continue; fi
      case "$BASE_REAL" in "$BASE_ROOT_REAL"/*) ;; *) echo "SKIP unowned base: $BASE_REAL"; continue ;; esac
      git worktree list --porcelain | grep -Fqx "worktree $BASE_REAL" || continue
      [ -z "$(git -C "$BASE_REAL" symbolic-ref -q --short HEAD)" ] \
        || { echo "SKIP attached branch: $BASE_REAL"; continue; }
      if ! BASE_STATUS=$(git -C "$BASE_REAL" status --porcelain); then
        echo "SKIP unverifiable base: $BASE_REAL"; continue
      fi
      [ -z "$BASE_STATUS" ] || { echo "SKIP dirty base: $BASE_REAL"; continue; }
      git worktree remove "$BASE_REAL" || echo "WARNING: failed to remove batch base $BASE_REAL"
    done
  fi
fi
```

Step 5C handles only this batch's claims board. Report unrelated stale labels, orphan candidates, milestones, worktrees, or branches as advisory observations without mutating them. Never relabel or close issues, or delete child worktrees/branches, in Phase 5.

### Step 5B: Run agent audit

Invoke `/audit-agents` on this session to measure pipeline efficiency:

```
Skill(skill="audit-agents", args="latest")
```

Include the audit summary in the final report (Phase 6). Key metrics to surface:
- **Avg idle%** — percentage of time agents spent stalled vs working
- **Resume cycles** — how many times agents had to be resumed
- **Stall boundaries** — which phase transitions cause the most stalls

### Step 5C: Close the coordination issue (claims board) <!-- Added: forge#2072 -->

**Why this step exists**: Step 3D.1 (`phase-3-dependency.md`) creates this batch's coordination issue and exports `FORGE_COORD_ISSUE`/`COORD_ISSUE_NUMBER`. Because Step 5A deliberately has no global orphan sweep, close this one explicitly after its active claims are released.

**Run after Step 5B, before Step 5D.** No-ops cleanly if the claims board was never created this run (`COORD_ISSUE_NUMBER` unset/empty — e.g. Step 3D.1's `gh issue create` failed, or this batch never reached DAG construction). Tolerates GitHub API failures without aborting the rest of Phase 5 — the same tolerant-failure convention (`2>/dev/null || echo ...`, `|| true`) used throughout `phase-3-dependency.md`/`phase-4-execution.md`.

**The orchestrator lease and every active claim must already be released.** If either remains active, leave the coordination issue open and report the owner; never close an ownership record that may still protect live work.

```bash
read_active_claims() {
  local COORD_NUM="$1" COMMENTS CLAIMS HOLDER TERMINAL
  COMMENTS=$(gh api --paginate --slurp "repos/{GH_REPO}/issues/${COORD_NUM}/comments" 2>/dev/null) || return 1
  CLAIMS=$(printf '%s' "$COMMENTS" | jq -c 'flatten as $c | [$c[]
      | select((.body | split("\n")[0]) == "<!-- FORGE:CLAIM -->") | . as $claim
      | ($claim.body | capture("\\*\\*Holder\\*\\*: #(?<holder>[0-9]+)").holder) as $holder
      | select([$c[] | select((.body | split("\n")[0]) == "<!-- FORGE:CLAIM_RELEASED -->")
        | select((.body | capture("\\*\\*Holder\\*\\*: #(?<holder>[0-9]+)").holder) == $holder)
        | select(.created_at > $claim.created_at)] | length == 0)
      | {holder:$holder}]') || return 1
  [ -n "$CLAIMS" ] || return 1
  for HOLDER in $(echo "$CLAIMS" | jq -r '.[].holder'); do
    TERMINAL=$(gh issue view "$HOLDER" -R {GH_REPO} --json labels --jq \
      '[.labels[].name | select(. == "workflow:merged" or . == "workflow:invalid" or . == "workflow:awaiting-merge" or . == "needs-human")] | length > 0' 2>/dev/null || echo false)
    [ "$TERMINAL" = true ] && CLAIMS=$(echo "$CLAIMS" | jq --arg holder "$HOLDER" '[.[] | select(.holder != $holder)]')
  done
  echo "$CLAIMS"
}

if [ -n "${COORD_ISSUE_NUMBER:-}" ]; then
  ACTIVE_CLAIMS=$(read_active_claims "$COORD_ISSUE_NUMBER") || {
    echo "WARNING: could not verify claims; leaving claims board open"; ACTIVE_CLAIMS='[{"holder":"unknown"}]';
  }
  ACTIVE_CLAIMS_COUNT=$(echo "$ACTIVE_CLAIMS" | jq -er 'length') || ACTIVE_CLAIMS_COUNT=1
  LEASE_COMMENTS=$(gh api --paginate --slurp "repos/{GH_REPO}/issues/${COORD_ISSUE_NUMBER}/comments" 2>/dev/null) || LEASE_COMMENTS=""
  if [ -z "$LEASE_COMMENTS" ]; then
    LEASE_RELEASED=false
  else
    LEASE_RELEASED=$(printf '%s' "$LEASE_COMMENTS" | jq -er 'flatten | [.[] | select(((.body | split("\n")[0]) == "<!-- FORGE:LEASE -->") or ((.body | split("\n")[0]) == "<!-- FORGE:LEASE_RELEASED -->"))] | last | .body // "" | split("\n")[0] == "<!-- FORGE:LEASE_RELEASED -->"') || LEASE_RELEASED=false
  fi

  if [ "$ACTIVE_CLAIMS_COUNT" -gt 0 ] || [ "$LEASE_RELEASED" != true ]; then
    echo "Claims board #${COORD_ISSUE_NUMBER} still has active ownership; leaving it open."
  else
    gh issue close "$COORD_ISSUE_NUMBER" -R {GH_REPO} --comment "Batch complete — lease and current-batch claims released. Closing claims board." 2>/dev/null \
      && echo "Closed coordination issue #${COORD_ISSUE_NUMBER}" \
      || echo "WARNING: failed to close coordination issue #${COORD_ISSUE_NUMBER}"
  fi
else
  echo "No coordination issue for this batch — Step 5C is a no-op"
fi
```

**Idempotency**: `gh issue close` on an already-closed issue succeeds as a no-op (no error) — safe to re-run this step on a resumed/compacted session without an extra pre-check.

### Step 5D: Report cleanup results

Include the cleanup summary in the final report (Phase 6), including whether the coordination issue was closed this run (see Step 5C). If cleanup found problems, call them out — they indicate agent pipeline failures that may need investigation.

---
