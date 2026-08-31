---
description: Build subcommand — create worktree, post contract, sequence context/architect/implement/validate
argument-hint: "[issue number] [--repo GH_REPO] [--gh-flag GH_FLAG] [--base PR_BASE]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build — Build Phase Orchestrator

**Input**: $ARGUMENTS

**Invoked by**: `work-on.md` Phase 3 — entered when the issue carries label `workflow:ready-to-build` or `workflow:building` (see Universal Phase Dispatcher in work-on.md).
**Output**: Create worktree, post contract, run build phases, return result to work-on.md.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154. This file's mechanical bits (3B classification, 3D label transitions) stay at this tier because they're interleaved with the reasoning-heavy build steps (3C.5/3C.6/3F) in the same `Skill()` invocation — see `work-on.md` section "Model and Effort Tiering — What Actually Applies". <!-- Added: forge#1827 -->
**NEVER use plan mode (EnterPlanMode).**

**CRITICAL: You MUST execute ALL phases B0–B6 in order. TRIVIAL may skip B3 context work and B4 planning work, but it must still load `build/architect.md` and publish that specification's explicit completed skip marker before B5. For STANDARD and COMPLEX tasks B3/B4 are not optional.**

### Canonical Build Path (STANDARD/fast-lane) <!-- Added: forge#1276 -->

**Default execution model: inline.** For STANDARD and fast-lane issues, phases B3 (context gathering) and B4 (architecture planning) run **inline in the current context window** — not as separate `Skill()` sub-agent spawns. B5 (implement) and B6 (validate) also run inline.

`Skill()` invocations for context/architect sub-phases are only permitted when the Spawn-Decision Table (work-on.md `##Spawn-Decision Policy`) explicitly applies — specifically Row (c) (parent context near overflow: ≥20 Skill invocations or ≥10 files already changed before the build sub-phase). For most issues, the Skill() forms shown in B3 and B4 below are **reference documentation** describing the sub-phase contract, not mandatory sub-agent invocations.

**Build topology summary**:

| Path | When | Phases |
|------|------|--------|
| **STANDARD/fast-lane (default)** | All issues not matching exceptions below | B0 → B1 → B2 → B2.5 → [B3] → [B4] → B5 → B6 — all inline |
| **Spawn exception (Row c)** | ≥20 Skill invocations OR ≥10 files changed before build | Spawn B3/B4 as fresh sub-agents via `Skill()` |
| **TRIVIAL fast-path** | COMPLEXITY_BAND: TRIVIAL | Skip B3 context work; execute the B4 explicit completed skip-marker path; then B5/B6 |

This resolves the three-topology conflict: `work-on.md` Phase 3 (inline 3A–3M), `work-on/build.md` (this file), and `work-on-monolithic.md` ([BENCHMARK]) all describe the **same canonical inline path**. `work-on/build.md` adds worktree lifecycle management (B1) and the FORGE:CONTRACT handoff (B2) that the monolithic variant omits for brevity. The `Skill()` forms in B3/B4 below document the sub-phase contract and serve as the exception path only. <!-- Added: forge#1276 -->

<!-- FORGE:SPEC_LOADED — work-on/build.md loaded and active. Agent is bound by this spec. -->

---

## Fresh Pi builder entry contract

Authoritative Task Types `Investigation`, `Feature (UI/UX)`, and `Full-Stack` do not enter
the bounded mutation builder. The coordinator executes the existing Investigation
research/issue-creation special case or the mandatory frontend-design/browser route. For
all other confirmed tasks,
the work-on coordinator completes investigation, frozen-base setup,
the Builder Contract, and any required under-orchestration affected-file claim before
launching one fresh `forgedock-builder` in the same issue worktree. The builder's first repository read is
this file. It rehydrates the issue, latest completed investigation, latest contract,
exact base, and any required orchestration claim from GitHub; inherited coordinator conversation is not a
build input. A missing or ambiguous handoff is automated `GATED`.

The coordinator enters this specification with `--phase-role coordinator`; the fresh
builder rereads it with `--phase-role builder`, verifies completed B0-B2 evidence, and
resumes at B2.5 rather than
creating another worktree or duplicate contract. It executes B3-B6.5 inline, loads each
referenced phase file when reached, and does not launch subagents. No source mutation may
precede this file load and the required architecture artifact. The coordinator waits and
must not mutate the worktree concurrently.

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--base {PR_BASE}` — PR target branch (e.g. `milestone/modular-pipeline-architecture` or `staging`)
- `--phase-role coordinator|builder` — `coordinator` executes fresh B0-B2 and may create the contract/complexity marker; `builder` verifies the completed handoff and resumes at B2.5
- `--expected-base-sha {SHA}` — exact 40-character SHA from the coordinator's frozen target (required for builder role)
- `--expected-branch {BRANCH}` — exact issue branch from the coordinator handoff (required for builder role)
- `--coord-issue {NUMBER}` — orchestration coordination issue carrying the active claim (required only under orchestration)

**Phase notation**: This file uses **B0–B6** for its own phases. The calling orchestrator (`work-on.md`) uses **3A–3M** for its sub-phases. Mapping: work-on.md Phase 3A = B0 (load state), Phase 3B = complexity classification (posts `FORGE:FAST_PATH` before invoking build), Phase 3C onward maps to B1+ in this file. When cross-references mention "Phase 3B", they refer to work-on.md's Phase 3B, not a phase in this file. <!-- Added: forge#1380 -->

---

## Phase B0: Load State from GitHub (MANDATORY)

Re-read current state before doing anything. Pagination, completion filtering, and latest
selection are mandatory for every durable handoff artifact:

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone
BUILD_PHASE_ROLE="{coordinator|builder}"
case "$BUILD_PHASE_ROLE" in coordinator|builder) ;; *) echo "BUILD_RESULT: status: GATED blocker: --phase-role must be coordinator or builder"; exit 1 ;; esac

COMMENTS=$(gh api --paginate repos/{GH_REPO}/issues/{NUMBER}/comments --slurp | jq 'flatten')
# Select the latest terminal investigator artifact first; never filter by schema and fall
# back to an older artifact.
INVESTIGATOR_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:INVESTIGATOR -->") and (contains("<!-- INVESTIGATION:COMPLETE -->") or contains("<!-- INVESTIGATION:INVALID -->")))) | last | .body // ""')
CONTRACT_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:CONTRACT -->"))) | last | .body // ""')
FAST_PATH_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:FAST_PATH -->"))) | last | .body // ""')
BASE_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:BASE -->"))) | last | .body // ""')
# Select latest artifacts before checking completion so newer partial/malformed state cannot
# fall back to stale completed authority.
ARCHITECT_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:ARCHITECT -->"))) | last | .body // ""')
BUILDER_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:BUILDER -->"))) | last | .body // ""')
BUILDER_ID=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:BUILDER -->"))) | last | .id // ""')

[ -n "$INVESTIGATOR_BODY" ] || { echo "BUILD_RESULT: status: GATED blocker: latest completed investigation missing"; exit 1; }
printf '%s' "$INVESTIGATOR_BODY" | grep -qF '<!-- INVESTIGATION:INVALID -->' && { echo "BUILD_RESULT: status: INVESTIGATION_COMPLETE blocker: latest investigation is INVALID"; exit 0; }
printf '%s' "$INVESTIGATOR_BODY" | grep -qF '### Production Execution Seam' || { echo "BUILD_RESULT: status: GATED blocker: latest completed investigation missing Production Execution Seam"; exit 1; }
for label in 'Observable effect' 'Public entrypoint' 'Production owners' 'Mutation coverage' 'Acceptance seam'; do
  line=$(printf '%s\n' "$INVESTIGATOR_BODY" | grep -F "**${label}**:" | tail -1)
  value=${line#*:}
  value=$(printf '%s' "$value" | xargs)
  [ -n "$value" ] && ! printf '%s' "$value" | grep -Eqi '^\{|\}$|^(tbd|todo|unknown|none|n/a|placeholder)$' || { echo "BUILD_RESULT: status: GATED blocker: Production Execution Seam field $label is empty or placeholder"; exit 1; }
done
SIDE_EFFECT=$(printf '%s\n' "$INVESTIGATOR_BODY" | sed -n 's/^\*\*Irreversible\/provider side effect\*\*: \(YES\|NO\)$/\1/p' | tail -1)
case "$SIDE_EFFECT" in YES|NO) ;; *) echo "BUILD_RESULT: status: GATED blocker: investigation side-effect classification missing"; exit 1 ;; esac

validate_ownership_rows() {
  local body="$1" source="$2" require_closed="$3" rows
  printf '%s' "$body" | grep -qF '### Production Seam Ownership' || { echo "BUILD_RESULT: status: GATED blocker: $source missing Production Seam Ownership"; return 1; }
  rows=$(printf '%s\n' "$body" | awk '/^### Production Seam Ownership/{p=1;next} /^### /{p=0} p' | grep '^|' | grep -vE '^\|[- ]+\||Observable [Ee]ffect')
  if [ -z "$rows" ]; then
    [ "$source" = 'Builder Contract' ] && echo "BUILD_RESULT: status: GATED blocker: Builder Contract has no production ownership data row" || echo "BUILD_RESULT: status: GATED blocker: architecture has no current ownership data row"
    return 1
  fi
  ! printf '%s\n' "$rows" | grep -Eqi '\{[^}]*\}|\b(TBD|TODO|UNKNOWN|PLACEHOLDER)\b|\|[[:space:]]*\|' || { echo "BUILD_RESULT: status: GATED blocker: $source ownership row is empty or placeholder"; return 1; }
  if [ "$require_closed" = true ]; then
    printf '%s' "$body" | grep -qF '**Ownership gate**: CLOSED' || { echo "BUILD_RESULT: status: GATED blocker: $source ownership gate is not exactly CLOSED"; return 1; }
  fi
}

validate_provider_proof() {
  local body="$1" source="$2" require_closed="$3" rows
  printf '%s' "$body" | grep -qF '### Provider Transaction Proof' || { echo "BUILD_RESULT: status: GATED blocker: $source missing Provider Transaction Proof"; return 1; }
  rows=$(printf '%s\n' "$body" | awk '/^### Provider Transaction Proof/{p=1;next} /^### /{p=0} p' | grep '^|' | grep -vE '^\|[- ]+\||Provider operation')
  [ -n "$rows" ] || { echo "BUILD_RESULT: status: GATED blocker: $source has no provider transaction row"; return 1; }
  ! printf '%s\n' "$rows" | grep -Eqi '\{[^}]*\}|\b(TBD|TODO|UNKNOWN|PLACEHOLDER)\b|\|[[:space:]]*\|' || { echo "BUILD_RESULT: status: GATED blocker: $source provider row is empty or placeholder"; return 1; }
  if [ "$require_closed" = true ]; then printf '%s' "$body" | grep -qF '**Provider transaction gate**: CLOSED' || { echo "BUILD_RESULT: status: GATED blocker: $source provider gate is not exactly CLOSED"; return 1; }; fi
}

validate_high_risk_proof() {
  local body="$1" risks proofs risk_count proof_count
  risks=$(printf '%s\n' "$body" | awk '/^### Risk Assessment/{p=1;next} /^### /{p=0} p' | grep -E '\|[[:space:]]*HIGH[[:space:]]*\|' || true)
  [ -n "$risks" ] || return 0
  proofs=$(printf '%s\n' "$body" | awk '/^### HIGH-Risk Verification/{p=1;next} /^### /{p=0} p' | grep '^|' | grep -vE '^\|[- ]+\||HIGH Risk')
  risk_count=$(printf '%s\n' "$risks" | grep -c '^|' || true); proof_count=$(printf '%s\n' "$proofs" | grep -c '^|' || true)
  [ "$risk_count" -eq "$proof_count" ] && [ "$proof_count" -gt 0 ] || { echo "BUILD_RESULT: status: GATED blocker: every HIGH risk requires one verification row"; return 1; }
  ! printf '%s\n' "$proofs" | grep -Eqi '\{[^}]*\}|\b(TBD|TODO|UNKNOWN|PLACEHOLDER)\b|\|[[:space:]]*\|' || { echo "BUILD_RESULT: status: GATED blocker: HIGH-risk row is empty or placeholder"; return 1; }
  printf '%s' "$body" | grep -qF '**HIGH-risk gate**: CLOSED' || { echo "BUILD_RESULT: status: GATED blocker: HIGH-risk gate is not closed"; return 1; }
}

# Coordinator role is allowed to create B2 artifacts on a fresh build. Builder role must
# receive and validate them; this avoids requiring the contract before contract creation.
if [ "$BUILD_PHASE_ROLE" = builder ] || [ -n "$CONTRACT_BODY" ]; then
  validate_ownership_rows "$CONTRACT_BODY" 'Builder Contract' false || exit 1
  [ "$SIDE_EFFECT" = NO ] || validate_provider_proof "$CONTRACT_BODY" 'Builder Contract' true || exit 1
fi

if [ "$BUILD_PHASE_ROLE" = builder ]; then
  COMPLEXITY_BAND=$(printf '%s' "$FAST_PATH_BODY" | sed -n 's/.*\*\*COMPLEXITY_BAND\*\*: \([A-Z_]*\).*/\1/p' | head -1)
  case "$COMPLEXITY_BAND" in TRIVIAL|STANDARD|COMPLEX) ;; *) echo "BUILD_RESULT: status: GATED blocker: valid FORGE:FAST_PATH complexity marker missing"; exit 1 ;; esac

  [ "${EXPECTED_BASE_SHA:-}" != "" ] && printf '%s' "$EXPECTED_BASE_SHA" | grep -Eq '^[a-f0-9]{40}$' || { echo "BUILD_RESULT: status: GATED blocker: expected base SHA missing or malformed"; exit 1; }
  [ -n "${EXPECTED_ISSUE_BRANCH:-}" ] || { echo "BUILD_RESULT: status: GATED blocker: expected issue branch missing"; exit 1; }
  mapfile -t BASE_SHA_LINES < <(printf '%s\n' "$BASE_BODY" | sed -n 's/^\*\*Target SHA\*\*: `\([a-f0-9]\{40\}\)`$/\1/p')
  mapfile -t BASE_BRANCH_LINES < <(printf '%s\n' "$BASE_BODY" | sed -n 's/^\*\*Issue branch\*\*: `\([^`]*\)`$/\1/p')
  [ "${#BASE_SHA_LINES[@]}" -eq 1 ] && [ "${BASE_SHA_LINES[0]}" = "$EXPECTED_BASE_SHA" ] || { echo "BUILD_RESULT: status: GATED blocker: FORGE:BASE SHA missing, ambiguous, or mismatched"; exit 1; }
  [ "${#BASE_BRANCH_LINES[@]}" -eq 1 ] && [ "${BASE_BRANCH_LINES[0]}" = "$EXPECTED_ISSUE_BRANCH" ] || { echo "BUILD_RESULT: status: GATED blocker: FORGE:BASE branch missing, ambiguous, or mismatched"; exit 1; }
  [ "$(git branch --show-current)" = "$EXPECTED_ISSUE_BRANCH" ] || { echo "BUILD_RESULT: status: GATED blocker: assigned worktree branch mismatches handoff"; exit 1; }

  if [ -n "${COORD_ISSUE:-}" ]; then
    COORD_COMMENTS=$(gh api --paginate repos/{GH_REPO}/issues/$COORD_ISSUE/comments --slurp | jq 'flatten')
    CLAIM_BODY=$(printf '%s' "$COORD_COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:CLAIM -->"))) | last | .body // ""')
    printf '%s' "$CLAIM_BODY" | grep -qF '<!-- CLAIM:COMPLETE -->' || { echo "BUILD_RESULT: status: GATED blocker: active FORGE:CLAIM missing or incomplete"; exit 1; }
    printf '%s' "$CLAIM_BODY" | grep -qE "\*\*Holder\*\*: #${NUMBER}( |$)" || { echo "BUILD_RESULT: status: GATED blocker: FORGE:CLAIM holder mismatch"; exit 1; }
    DELIVERABLE_PATHS=$(printf '%s\n' "$CONTRACT_BODY" | awk '/^### Deliverables/{p=1;next} /^### /{p=0} p' | grep -oE '`[^`]+`' | tr -d '`' | grep -E '\.(py|tsx?|jsx?|sql|json|ya?ml|md|mjs|sh)$' | sort -u)
    while IFS= read -r path; do [ -z "$path" ] || printf '%s' "$CLAIM_BODY" | grep -qF "$path" || { echo "BUILD_RESULT: status: GATED blocker: claim missing deliverable $path"; exit 1; }; done <<< "$DELIVERABLE_PATHS"
  fi
fi
```

**Resume check — one authoritative route per state**:

1. **Completed marker**: extract `validated_commit` from the latest complete builder body;
   require one 40-character SHA, equality with clean `HEAD`, frozen-base ancestry, and the
   expected issue branch. Only then return `BUILD_RESULT: status: ALREADY_DONE` with that
   exact `commit_sha`; stale or malformed completion is `GATED`.
2. **Partial marker plus staged/uncommitted changes**: preserve the partial comment and
   existing worktree exactly, then continue directly to B6 validation/commit. Do not
   delete artifacts, restart planning, or rerun implementation.
3. **Partial marker plus clean committed `HEAD` different from the frozen base**: preserve
   it, rerun configured verification and the V5 ancestry audit against that exact commit,
   set `VALIDATED_COMMIT_SHA` only after both pass, then execute B6.5 acceptance and bind
   completion. Do not create another commit.
4. **Partial marker plus clean frozen-base `HEAD`**: the artifact and Git state conflict;
   return automated `GATED` without deleting either.

```bash
FROZEN_BASE_SHA="${EXPECTED_BASE_SHA:-}"
if [ "$BUILD_PHASE_ROLE" = builder ] && [ -n "$BUILDER_BODY" ]; then
  validate_ownership_rows "$ARCHITECT_BODY" 'current architecture for resume' true || exit 1
  [ "$SIDE_EFFECT" = NO ] || validate_provider_proof "$ARCHITECT_BODY" 'current architecture for resume' true || exit 1
  validate_high_risk_proof "$ARCHITECT_BODY" || exit 1
fi
if [ "$BUILD_PHASE_ROLE" = builder ] && printf '%s' "$BUILDER_BODY" | grep -qF '<!-- FORGE:BUILDER:COMPLETE -->'; then
  mapfile -t VALIDATED_COMMIT_LINES < <(printf '%s' "$BUILDER_BODY" | sed -n 's/^validated_commit: \([a-f0-9]\{40\}\)$/\1/p')
  [ "${#VALIDATED_COMMIT_LINES[@]}" -eq 1 ] || { echo "BUILD_RESULT: status: GATED blocker: completed builder must contain exactly one validated_commit"; exit 1; }
  VALIDATED_COMMIT_SHA="${VALIDATED_COMMIT_LINES[0]}"
  [ -n "$EXPECTED_ISSUE_BRANCH" ] && [ "$(git branch --show-current)" = "$EXPECTED_ISSUE_BRANCH" ] || { echo "BUILD_RESULT: status: GATED blocker: completed builder branch identity invalid"; exit 1; }
  [ "$(git rev-parse HEAD)" = "$VALIDATED_COMMIT_SHA" ] || { echo "BUILD_RESULT: status: GATED blocker: completed builder commit is stale"; exit 1; }
  [ -z "$(git status --porcelain)" ] || { echo "BUILD_RESULT: status: GATED blocker: completed builder worktree is dirty"; exit 1; }
  git merge-base --is-ancestor "$FROZEN_BASE_SHA" "$VALIDATED_COMMIT_SHA" || { echo "BUILD_RESULT: status: GATED blocker: completed builder ancestry invalid"; exit 1; }
  echo "BUILD_RESULT: status: ALREADY_DONE commit_sha: $VALIDATED_COMMIT_SHA"
  exit 0
elif [ "$BUILD_PHASE_ROLE" = builder ] && [ -n "$BUILDER_ID" ] && [ -n "$(git status --porcelain)" ]; then
  echo "Partial pre-commit build preserved; continue directly to B6"
elif [ "$BUILD_PHASE_ROLE" = builder ] && [ -n "$BUILDER_ID" ] && [ "$(git rev-parse HEAD)" != "$FROZEN_BASE_SHA" ]; then
  RESUME_COMMIT_SHA=$(git rev-parse HEAD)
  echo "Partial committed build $RESUME_COMMIT_SHA preserved; rerun verification and ancestry before B6.5"
elif [ "$BUILD_PHASE_ROLE" = builder ] && [ -n "$BUILDER_ID" ]; then
  echo "BUILD_RESULT: status: GATED blocker: partial builder artifact conflicts with frozen-base HEAD"
  exit 1
fi
```

Extract affected files, root cause, recommendation, and task type from the selected
`INVESTIGATOR_BODY`; never from an older or incomplete comment.

---

## Phase B1: Create Worktree & Branch

### B1A: Derive branch name

From issue title: lowercase, hyphenated, max 40 chars (truncate if needed).
- Bug / fix issues → prefix `fix/`
- Feature issues → prefix `feat/`
- Refactor / maintenance → prefix `fix/` or `refactor/`

Append `-{NUMBER}` to ensure uniqueness: e.g. `fix/work-on-build-landing-file-85`.

### B1B: Determine source branch

- Review-finding issue → parse `**Code branch**: \`{branch}\`` from issue body; branch from `origin/{branch}`
  - **Milestone review-finding hybrid lane** (ONLY when Code branch matches `milestone/*`): This is a high-risk lane. The worktree will carry the full milestone history. The PR target is `staging` (or the base specified). **DANGER: Agents MUST NOT use `git merge` to resolve any conflicts in this lane.** Merge-based conflict resolution will pull the entire milestone commit tree onto staging, contaminating it with unapproved code. Use `git rebase` or `git cherry-pick` only. If conflicts cannot be resolved without a merge, post evidence and return automated `GATED`; do not add `needs-human` or perform the merge.
  - **Missing ref fallback**: After parsing, verify the Code branch still exists on remote. If not, fall back to the lane default (`staging` for fast lane, `milestone/{slug}` for feature lane) and note the fallback:
    ```bash
    SOURCE_BRANCH="{CODE_BRANCH_FROM_ISSUE_BODY}"
    if ! git ls-remote --exit-code origin "$SOURCE_BRANCH" >/dev/null 2>&1; then
      echo "WARNING: Code branch '$SOURCE_BRANCH' not found on remote — falling back to lane default '$PR_BASE'"
      SOURCE_BRANCH="$PR_BASE"
    fi
    ```
- Feature lane (has milestone) → branch from `origin/{PR_BASE}`
- Fast lane (no milestone) → branch from `origin/staging`

### B1C: Create worktree

```bash
WORKTREE_ROOT="/path/to/repo/.claude/worktrees"
if [ "${FORGE_RUNTIME:-}" = "opencode" ] ||
   [ -n "${OPENCODE_SESSION_ID:-}" ] ||
   [ -n "${OPENCODE_PID:-}" ] ||
   [ -n "${OPENCODE:-}" ]; then
  WORKTREE_ROOT="/path/to/repo/.opencode/worktrees"
elif [ "${FORGE_RUNTIME:-}" = "codex" ]; then
  WORKTREE_ROOT="/path/to/repo/.codex/worktrees"
fi
WORKTREE_PATH="${WORKTREE_ROOT}/{BRANCH_SLUG}"
git worktree add {WORKTREE_PATH} -b {BRANCH} origin/{SOURCE_BRANCH}
```

If worktree already exists at that path:
```bash
# Reuse existing worktree — verify it's on the correct branch
git -C {WORKTREE_PATH} branch --show-current
```
If wrong branch, remove and recreate:
```bash
git worktree remove {WORKTREE_PATH} --force
git worktree add {WORKTREE_PATH} -b {BRANCH} origin/{SOURCE_BRANCH}
```

### B1D: Set building label

```bash
gh issue edit {NUMBER} {GH_FLAG} \
  --add-label "workflow:building" \
  --remove-label "workflow:ready-to-build"
```

---

## Phase B2: Post Builder Contract

Post `<!-- FORGE:CONTRACT -->` comment documenting what will be built and why:

**Before posting, read the attribution config**:
```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CONTRACT -->
## Builder Contract

**Task type**: {TASK_TYPE}

### Proposed Approach

{BRIEF_APPROACH_DESCRIPTION}

### Deliverables

| File | Change | Why |
|------|--------|-----|
{DELIVERABLES_ROWS}

### Acceptance Criteria

{ACCEPTANCE_CRITERIA_CHECKLIST}

### Execution Path and Proof

`{ACTIVE_PUBLIC_OR_PRODUCTION_ENTRYPOINT}` → `{PRODUCTION_CALLER_AND_ADAPTER}` → `{CHANGED_BOUNDARY}` → `{OBSERVABLE_RESULT}`

### Production Seam Ownership

| Observable effect | Entrypoint | Owning production file/symbol | Deliverable or no-mutation evidence |
|---|---|---|---|
| {EFFECT} | {ENTRYPOINT} | {OWNER_PATH_AND_SYMBOL} | {DELIVERABLE_PATH or exact source evidence behavior already exists} |

### Provider Transaction Proof (include only when investigation says YES)

| Provider operation or fallback | Authority / preconditions | Exact call and failure scope | Required result / readback | Replay / recovery | Deterministic test |
|---|---|---|---|---|---|
| {ACTUAL_OPERATION} | {WHO_MAY_ACT} | {CALL_AND_ONLY_ERRORS_IT_CLASSIFIES} | {FIELDS_REQUIRED_FOR_SUCCESS} | {RECONCILIATION_AFTER_SUCCESS} | {NAMED_TEST} |

**Provider transaction gate**: CLOSED

**Exact behavioral test**: `{COMMAND_OR_NAMED_TEST_THAT_INVOKES_THE_PUBLIC_SEAM}`
**Bug reproduction before fix**: `{FAILING_BEFORE_COMMAND_OR_NOT_APPLICABLE_FOR_NON_BUG}`

Every executable owner of the requested effect must be a deliverable unless source
evidence proves it already performs the requested behavior. An export, prose instruction,
direct import of an otherwise unwired helper, test-local fixture/mock, or broad suite is
not an active execution path. A prompt/spec may be the production owner only when the
investigation proves that exact file is loaded as the runtime surface and no separate
executable owner controls the effect.

### Quality Considerations

{AUTH_MODEL_NEW_ENV_VARS_SQL_SAFETY_SECURITY_SURFACE}

### Out of Scope

{OUT_OF_SCOPE_ITEMS}
${ATTRIBUTION_LINE}"
```

Contract must be grounded in the investigation report. Every deliverable file must appear in the affected files list from the investigator. Adversarially validate the proposed fix against adjacent system layers before posting. The execution path must name the real caller/entrypoint that activates every new helper, command, or configuration boundary and the exact test that invokes that seam. Compare the Production Seam Ownership rows to Deliverables before posting: an owner that controls the requested effect cannot remain related/read-only or be omitted unless its no-mutation evidence proves the behavior already exists. Any mismatch returns to investigation before contract publication. When investigation marks `Irreversible/provider side effect: YES`, require one
substantive proof row per actual mutation or fallback. Each row states authority,
operation-scoped failure handling, required result/readback, replay/recovery, and a
current-transaction test. Do not invent a fixed global scenario list. For a bug, run and record a
safe deterministic failing-before reproduction when one exists.

### B2.1: Post FORGE:CLAIM on coordination issue (conditional — when running under orchestration batch) <!-- Added: forge#1736 -->

**Skip if**: `FORGE_COORD_ISSUE` is not set (agent is not running under an orchestration batch). This step is a no-op outside of `/orchestrate` dispatch — no error, no output.

**When `FORGE_COORD_ISSUE` is set**: Post a `FORGE:CLAIM` annotation on the coordination issue to advertise this agent's active resource reservation to the orchestrator and peer agents. This enables the claims-board Layer-2/4 relaxation sweep (orchestrate Step 4B) to identify issue-pairs with disjoint file sets and downgrade unnecessary serialization edges.

```bash
if [ -n "${FORGE_COORD_ISSUE:-}" ]; then
  COORD_NUM=$(echo "$FORGE_COORD_ISSUE" | grep -oE '[0-9]+$')
  if [ -n "$COORD_NUM" ]; then
    # Extract file paths from the just-posted FORGE:CONTRACT deliverables table
    CLAIMED_FILES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
      --jq '[.[] | select(.body | contains("FORGE:CONTRACT"))] | last | .body' 2>/dev/null \
      | awk '/^### Deliverables/{p=1; next} /^### /{p=0} p' \
      | grep -oP '`[^`]+\.(py|tsx?|jsx?|sql|json|ya?ml|md|mjs|sh)`' \
      | tr -d '`' | sort -u | tr '\n' '\n' | head -20)
    CLAIMED_FILES="${CLAIMED_FILES:-"(files listed in FORGE:CONTRACT deliverables table)"}"

    # Extract preserved interfaces from the FORGE:ARCHITECT affected paths table (if present)
    CLAIMED_INTERFACES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
      --jq '[.[] | select(.body | contains("FORGE:ARCHITECT"))] | last | .body' 2>/dev/null \
      | awk '/^### Affected Paths/{p=1; next} /^### /{p=0} p' \
      | grep -oP 'Function/Class.*\|.*\|' | head -10 || echo "(see FORGE:ARCHITECT for interface details)")
    CLAIMED_INTERFACES="${CLAIMED_INTERFACES:-"(see FORGE:ARCHITECT comment for interface details)"}"

    CLAIM_HOLDER="#${NUMBER} / $(date -u +%Y%m%dT%H%M%S)"
    CLAIM_TTL="terminal state of Holder issue #${NUMBER}"

    gh issue comment "$COORD_NUM" -R {GH_REPO} --body "<!-- FORGE:CLAIM -->
## Resource Claim

**Holder**: ${CLAIM_HOLDER}
**Files**: ${CLAIMED_FILES}
**Interfaces**: ${CLAIMED_INTERFACES}
**TTL**: ${CLAIM_TTL}

<!-- CLAIM:COMPLETE -->" 2>/dev/null || true
    echo "FORGE:CLAIM posted on coordination issue #${COORD_NUM} for #${NUMBER}"
  fi
fi
```

**After posting**: Continue to Phase B2.5. The claim is now visible to the orchestrator and peer agents. The orchestrator's claims-board relaxation sweep (orchestrate Step 4B) will read this claim when determining whether serialized peers can be unblocked.

---

## Phase B2.5: Extract FUNCTION_NAMES from Contract

After posting the Builder Contract, extract the primary function/class names from the contract's deliverables table. These are passed to the context subcommand for Phase C3 caller/importer discovery.

```bash
FUNCTION_NAMES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTRACT")) | .body' \
  | awk '/^### Deliverables/{p=1; next} /^### /{p=0} p' \
  | grep -oE '`[A-Za-z_][A-Za-z0-9_]*`' \
  | tr -d '`' \
  | sort -u \
  | tr '\n' ' ' \
  | xargs)
# Scope is limited to the ### Deliverables section to avoid false matches from FORGE markers,
# phase labels (B2, C3), and identifiers mentioned in Acceptance Criteria or Quality sections.
# Fallback: if extraction yields nothing, FUNCTION_NAMES remains empty string
# context.md Phase C3 skips gracefully when FUNCTION_NAMES is empty (for-loop produces zero iterations)
```

If `FUNCTION_NAMES` is non-empty, it will be passed via `--functions` to the context subcommand. If empty, the `--functions` flag is omitted — Phase C3 will naturally skip with zero iterations and no error.

---

## Phase B3: Context Gathering (MANDATORY for STANDARD/COMPLEX — skip for TRIVIAL)

**Skip if COMPLEXITY_BAND: TRIVIAL** (read from FORGE:FAST_PATH in Phase B0) — skip this phase entirely. Proceed directly to Phase B4.

**For STANDARD and COMPLEX tasks**: Always run. Do NOT skip without a TRIVIAL COMPLEXITY_BAND.

**Execution model**: Run **inline** (see Canonical Build Path above). Read the `commands/work-on/build/context.md` spec and execute its steps directly in this context window. Only spawn a Skill() sub-agent when the Spawn-Decision Table Row (c) applies (≥20 prior Skill invocations or ≥10 files already changed). <!-- Added: forge#1276 -->

Surface historical review findings and bug patterns for the affected files. The full step-by-step logic is defined in `commands/work-on/build/context.md`. Key steps: search closed issues with `review-finding` label on the affected files; check git log for past bug patterns; synthesize a `FORGE:CONTEXT` annotation and post it as a GitHub comment.

**Spawn exception** (only when Row (c) applies):
```
Skill("work-on:build:context", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --repo-path {WORKTREE_PATH} {AFFECTED_FILES} --functions {FUNCTION_NAMES}")
```
If `FUNCTION_NAMES` is empty, omit `--functions`. The Skill() form above is the exception path — not the default. <!-- Added: forge#1276 -->

**After context gathering**:
- Structured context briefing produced (or no relevant history found) → continue to B4
- Context gathering timed out or errored → log warning, continue to B4 with empty context (non-blocking)
# MUST CONTINUE to Phase B4 — context result is intermediate, NOT terminal.

---

## Phase B4: Architecture Planning (MANDATORY for STANDARD/COMPLEX — skip for TRIVIAL)

**If COMPLEXITY_BAND: TRIVIAL**: load `commands/work-on/build/architect.md`, execute its entrypoint/caller trace and mandatory A2.1 Production Seam Ownership Gate, then use the ownership-bearing Skip Marker for remaining planning work. Do not emit an empty completion artifact or bypass ownership reconciliation.

**For STANDARD and COMPLEX tasks**: Always run. Even a 1-file STANDARD fix benefits from cross-path consistency checks. Do NOT skip without a TRIVIAL COMPLEXITY_BAND. Implementation cannot start until a same-issue `FORGE:ARCHITECT:COMPLETE` artifact exists. A legitimate skip still posts the explicit completed skip artifact defined by `build/architect.md`; an absent artifact is never a skip.

**Execution model**: Run **inline** (see Canonical Build Path above). Read the `commands/work-on/build/architect.md` spec and execute its steps directly in this context window. Only spawn a Skill() sub-agent when the Spawn-Decision Table Row (c) applies. <!-- Added: forge#1276 -->

Trace all affected code paths and produce an ordered implementation plan. The full step-by-step logic is defined in `commands/work-on/build/architect.md`. Key steps: map all callers and importers of changed functions; check consistency rules across paths; post a `FORGE:ARCHITECT` annotation with the ordered plan and a risk table.

**Spawn exception** (only when Row (c) applies):
```
Skill("work-on:build:architect", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --repo-path {WORKTREE_PATH} --files {AFFECTED_FILES}")
```
The Skill() form above is the exception path — not the default. <!-- Added: forge#1276 -->

**After architecture planning**:
- If any Risk Assessment row is HIGH, require a matching substantive `HIGH-Risk Verification` row with a concrete failure scenario, discriminating inputs or full state sequence, named executable test, and exact `**HIGH-risk gate**: CLOSED`; otherwise return `GATED` before B5
- Returns ordered implementation plan → continue to B5
- BLOCKED (conflicting constraints that cannot be resolved inline) → post comment, add `needs-human`, return `BUILD_RESULT: status: BLOCKED`
# MUST CONTINUE to Phase B5 — architect result is intermediate, NOT terminal.

---

## Phase B5: Implementation (Subcommand)

Invoke the implement subcommand to write code, stage, and post the builder comment:

```
Skill("work-on:build:implement", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --worktree {WORKTREE_PATH} --branch {BRANCH} --base-sha {FROZEN_BASE_SHA}")
```

**After subcommand returns**:
- `IMPLEMENT_RESULT: status: COMPLETE` → continue to B6
- `IMPLEMENT_RESULT: status: ALREADY_DONE` with a clean partial-build commit → use the B0 recovery route: do not run V5 or create another commit; rerun configured verification and the V5 ancestry audit against base..HEAD, set `VALIDATED_COMMIT_SHA` only after both pass, then execute B6.5
- `IMPLEMENT_RESULT: status: INVESTIGATION_COMPLETE` → issues created as deliverables; return `BUILD_RESULT: status: INVESTIGATION_COMPLETE`
- `IMPLEMENT_RESULT: status: GATED | BLOCKED` → return the same fail-closed status with blocker evidence; mechanical scope/phase failures are `GATED`, not `needs-human`
# MUST CONTINUE to Phase B6 — implement result is intermediate, NOT terminal (validation still required).

---

## Phase B6: Validation (Subcommand)

Invoke the validate subcommand to run the quality gate loop, formatting, and deploy checks:

```
Skill("work-on:build:validate", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --worktree {WORKTREE_PATH} --base-sha {FROZEN_BASE_SHA} --files {CHANGED_FILES}")
```

Where `{CHANGED_FILES}` is the space-separated list of files changed by the implement subcommand (read from `IMPLEMENT_RESULT` or from the `<!-- FORGE:BUILDER -->` comment).

**After subcommand returns**:
- `VALIDATE_RESULT: status: COMPLETE`, `gate_passed: true`, and a non-empty exact `validated_commit_sha` → set `VALIDATED_COMMIT_SHA` to that returned field and continue to B6.5
- missing/invalid commit evidence or `gate_passed: false` → return `BUILD_RESULT: status: GATED`; never infer validation success from current `HEAD`

---

## Phase B6.5: Acceptance Gate (MANDATORY — cannot be silently skipped) <!-- Added: forge#1315 -->

**Goal**: Execute the machine-checkable acceptance spec emitted by investigate Phase 1C and block merge if any check fails. This is a hard gate — not advisory.

**Read acceptance spec from FORGE:INVESTIGATOR comment**:

```bash
INVESTIGATOR_BODY=$(gh api --paginate repos/{GH_REPO}/issues/{NUMBER}/comments \
  --slurp | jq -r 'flatten | map(select(.body | contains("<!-- FORGE:INVESTIGATOR -->") and contains("<!-- INVESTIGATION:COMPLETE -->"))) | last | .body // ""')
ACCEPTANCE_CHECKS=$(printf '%s\n' "$INVESTIGATOR_BODY" | grep '^ACCEPTANCE_CHECK:' || true)
```

**If `ACCEPTANCE_CHECKS` is empty** (investigation predates this feature or comment was deleted): post a warning comment and **block** — do not silently pass:

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — No Spec Found

No \`ACCEPTANCE_CHECK:\` lines found in the FORGE:INVESTIGATOR comment. This may mean:
- The investigation was run before acceptance spec emission was added (re-run investigate to generate the spec), or
- The investigator comment was deleted.

**Gate result: BLOCKED** — re-run \`/work-on:investigate {NUMBER}\` to regenerate the acceptance spec, then retry the build.

<!-- FORGE:ACCEPTANCE_GATE:BLOCKED -->"
```
Return `BUILD_RESULT: status: GATED`, blocker: "No acceptance spec — re-run investigation to emit ACCEPTANCE_CHECK lines". Do not add `needs-human`; this is mechanically recoverable.

**Before executing checks — cardinality and type fidelity gate (MANDATORY)**:

When the issue contains an `## Acceptance Criteria` section, count its actionable
checkbox items (`- [ ]` or `- [x]`) and require exactly the same number of
`ACCEPTANCE_CHECK` lines
with the exact ordered IDs `ac-1..ac-N`. For each criterion marked `[type:e2e]`, require
the corresponding check to be `type=command` or `type=behavior` and to execute the active
public/production seam named in the Builder Contract. `contains`, grep-only prose checks,
a direct leaf-helper import, or an unnamed broad suite is a hard mismatch. On any count,
ID, or type mismatch, post `FORGE:ACCEPTANCE_GATE:FAILED` and return automated `GATED`;
do not rewrite, combine, or silently bless the checks during build.

**If all checks are `type=skipped`**: post a pass comment noting human review is required, then continue to the checkpoint (non-blocking — skip was deliberate):

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — Skipped (No Machine-Checkable Criteria)

The acceptance spec contains only a skip sentinel (\`type=skipped\`). No automated checks were run. Human review is required before merge.

<!-- FORGE:ACCEPTANCE_GATE:PASSED -->"
```

**Otherwise — execute each check**: <!-- Added: forge#1829 -->

```bash
GATE_PASS=true
FAILED_CHECKS=""

while IFS= read -r check_line; do
  # Fields are extracted by anchoring each sed pattern to `^ACCEPTANCE_CHECK:` and walking
  # through the fixed field order from investigate.md (id= type= target="..." matcher="..."
  # description=<free text to EOL>) instead of truncating the line before extraction. This
  # is deliberate: description= is unconstrained free text and can legitimately contain
  # key="value"-shaped substrings (e.g. `description=works when target="prod"`), while
  # target=/matcher= are themselves free-form shell commands/regexes and can legitimately
  # contain the literal substring "description=" (e.g. `target="grep -c description= file"`).
  # A prior fix truncated the line at the first description= to keep free text from being
  # mistaken for a real field — but that truncation then broke whenever a *real* target=/
  # matcher= value contained "description=" text, cutting mid-quote. Anchoring from the start
  # of the line through each preceding field in order avoids truncation entirely: every
  # anchored pattern matches only the one fixed position where that field can occur, so
  # neither direction of collision (fake fields inside description=, or description=-like
  # text inside target=/matcher=) can hijack extraction. Falls back to the full line
  # unchanged if a field is absent (no-op, safe for malformed lines).
  ID=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=\([^ ]*\) type=.*/\1/p')
  TYPE=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=\([^ ]*\) target=.*/\1/p')
  # target=/matcher= are quoted (target="..." matcher="...") per the investigate.md wire format —
  # quoting is required so multi-word/piped shell-command values (e.g. `target="grep -qE '...' file"`)
  # survive extraction instead of being truncated at the first space. The quote-bounded pattern
  # (`"\([^"]*\)"`) captures everything up to the next literal quote verbatim, including a literal
  # "description=" substring inside the value. Fall back to the legacy unquoted [^ ]* extraction
  # only for older ACCEPTANCE_CHECK comments emitted before this fix (still correct for
  # single-token exists/contains targets; multi-word legacy targets remain truncated until the
  # issue's investigation is re-run to emit the quoted format).
  TARGET=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target="\([^"]*\)".*/\1/p')
  [ -z "$TARGET" ] && TARGET=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target=\([^ ]*\).*/\1/p')
  MATCHER=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target="[^"]*" matcher="\([^"]*\)".*/\1/p')
  [ -z "$MATCHER" ] && MATCHER=$(echo "$check_line" | sed -n 's/^ACCEPTANCE_CHECK: id=[^ ]* type=[^ ]* target=[^ ]* matcher=\([^ ]*\).*/\1/p')
  DESC=$(echo "$check_line"  | sed -n 's/.*description=\(.*\)/\1/p')

  [ "$TYPE" = "skipped" ] && continue

  RESULT="PASS"
  DETAIL=""

  case "$TYPE" in
    exists)
      [ -e "$TARGET" ] || { RESULT="FAIL"; DETAIL="path not found: $TARGET"; }
      ;;
    contains)
      grep -qE "$MATCHER" "$TARGET" 2>/dev/null || { RESULT="FAIL"; DETAIL="'$MATCHER' not found in $TARGET"; }
      ;;
    command|behavior)
      if [ "$MATCHER" = "exit_0" ]; then
        eval "$TARGET" >/dev/null 2>&1 || { RESULT="FAIL"; DETAIL="command exited non-zero: $TARGET"; }
      else
        OUTPUT=$(eval "$TARGET" 2>&1)
        echo "$OUTPUT" | grep -qE "$MATCHER" || { RESULT="FAIL"; DETAIL="output did not match '$MATCHER'. Got: $(echo "$OUTPUT" | head -3)"; }
      fi
      ;;
    *)
      RESULT="FAIL"; DETAIL="unknown check type: $TYPE"
      ;;
  esac

  if [ "$RESULT" = "FAIL" ]; then
    GATE_PASS=false
    FAILED_CHECKS="${FAILED_CHECKS}\n- **$ID** ($DESC): $DETAIL"
  fi
done <<< "$ACCEPTANCE_CHECKS"
```

**Post gate result comment**:

```bash
if [ "$GATE_PASS" = "true" ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — PASSED

All machine-checkable acceptance criteria verified against real behavior.

<!-- FORGE:ACCEPTANCE_GATE:PASSED -->"
else
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — FAILED

The following acceptance checks did not pass:

$(echo -e "$FAILED_CHECKS")

Merge is blocked. Fix the failing criteria and re-run the validate phase.

<!-- FORGE:ACCEPTANCE_GATE:FAILED -->"
  # Return automated GATED — merge gate failed
fi
```

If `GATE_PASS = false`: return `BUILD_RESULT: status: GATED`, blocker: "Acceptance gate failed — see FORGE:ACCEPTANCE_GATE comment".

If `GATE_PASS = true`: bind completion to the exact commit returned by
`build/validate.md`, then write the phase checkpoint. This is the only build path that
may append `FORGE:BUILDER:COMPLETE`.

**When gate_passed is true — bind completion and write checkpoint (MANDATORY)**:
```bash
[ -n "${VALIDATED_COMMIT_SHA:-}" ] || {
  echo "BUILD_RESULT: status: GATED blocker: validated_commit_sha missing from VALIDATE_RESULT"
  exit 1
}
[ "$(git rev-parse HEAD)" = "$VALIDATED_COMMIT_SHA" ] || {
  echo "BUILD_RESULT: status: GATED blocker: validated commit does not equal HEAD"
  exit 1
}
[ -z "$(git status --porcelain)" ] || {
  echo "BUILD_RESULT: status: GATED blocker: validated worktree is not clean"
  exit 1
}
EXPECTED_ISSUE_BRANCH="{EXPECTED_ISSUE_BRANCH_FROM_HANDOFF}"
[ -n "$EXPECTED_ISSUE_BRANCH" ] && [ "$(git branch --show-current)" = "$EXPECTED_ISSUE_BRANCH" ] || {
  echo "BUILD_RESULT: status: GATED blocker: validated branch identity invalid"
  exit 1
}

BUILDER_COMMENT_ID=$(gh api --paginate repos/{GH_REPO}/issues/{NUMBER}/comments --slurp \
  | jq -r 'flatten | map(select(.body | contains("<!-- FORGE:BUILDER -->") and (contains("<!-- FORGE:BUILDER:COMPLETE -->") | not))) | last | .id // ""')
[ -n "$BUILDER_COMMENT_ID" ] || {
  echo "BUILD_RESULT: status: GATED blocker: partial FORGE:BUILDER comment missing"
  exit 1
}
CURRENT_BODY=$(gh api repos/{GH_REPO}/issues/comments/$BUILDER_COMMENT_ID --jq '.body')
UPDATED_BODY="${CURRENT_BODY}

validated_commit: ${VALIDATED_COMMIT_SHA}
<!-- FORGE:BUILDER:COMPLETE -->"
gh api repos/{GH_REPO}/issues/comments/$BUILDER_COMMENT_ID \
  -X PATCH --field body="$UPDATED_BODY" || exit 1
READBACK=$(gh api repos/{GH_REPO}/issues/comments/$BUILDER_COMMENT_ID --jq '.body') || exit 1
printf '%s' "$READBACK" | grep -qF "validated_commit: ${VALIDATED_COMMIT_SHA}" || exit 1
printf '%s' "$READBACK" | grep -qF '<!-- FORGE:BUILDER:COMPLETE -->' || exit 1

CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
\`\`\`json
{\"phase\": \"BUILD\", \"status\": \"COMPLETE\", \"next_phase\": \"REVIEW\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\", \"commit\": \"${VALIDATED_COMMIT_SHA}\"}
\`\`\`"
```

---

## Controlled staging refresh during validation

Validation is evaluated against an exact target identity. Immediately before the first
validation command and again before returning `gate_passed: true`, fetch the configured
`refs/heads/staging` and compare its SHA with the current review base. A changed target
is not an unconditional failure: continue only if the new SHA is an authorized,
reachable sibling merge in the active orchestration batch. Publish a
`FORGE:BASE_REFRESH` record containing immutable launch SHA, old/new base SHAs, target
ref, sibling merge SHA, merge-base SHA, and refresh attempt before changing the lane.

For a verified advance, preserve all issue commits and the existing owned branch. Before
push/PR, synchronize onto the new target with a guarded operation. If a PR already
exists, do not reset or overwrite it: integrate the verified target non-destructively
using the expected remote-head lease. Conflicts, ambiguous/non-fast-forward movement,
or lease mismatch are automated `GATED` outcomes.

After synchronization, rerun every configured verification command and every acceptance
check from the beginning; pre-refresh output is historical only. Recompute the exact
review base and merge-base, and hand off only a refreshed identity to review. The review
phase must invalidate prior receipts and run a fresh complete panel. This refresh does
not repeat investigation, planning, or implementation, and does not widen the claim.
See `specs/qualitative-review-protocol.md`.

## Output

Output this structured block — the routing loop in `work-on.md` will read this result, re-evaluate state, and continue to the next phase. This subcommand is complete; control returns to the router's loop iteration.

```
BUILD_RESULT:
  status: COMPLETE | ALREADY_DONE | INVESTIGATION_COMPLETE | GATED | BLOCKED
  branch: {BRANCH}
  worktree: {WORKTREE_PATH}
  commit_sha: {exact validated commit when status=COMPLETE or ALREADY_DONE}
  changed_files: [{every changed path}]
  tests: [{named tests added or updated}]
  commands: [{command and outcome}]
  validation: {quality gate, configured verification, acceptance, ancestry, and clean-status evidence}
  blocker: {description if status=GATED or BLOCKED}
```

---

## Integration Point in work-on.md

This module runs during **Phase 3** of the work-on.md pipeline (label: `workflow:ready-to-build` or `workflow:building`). The full sequence is defined by the Universal Phase Dispatcher in work-on.md:

```
Phase 3 (Build)   → [THIS MODULE] worktree + contract + context + architect + implement + validate + acceptance-gate
                  → posts FORGE:BUILDER comment + FORGE:ACCEPTANCE_GATE comment, writes FORGE:CHECKPOINT next_phase=REVIEW
Phase 4 (PR)      → work-on:review — push branch, create PR, set workflow:in-review
Phase 5 (Review)  → work-on:review — invoke /review-pr --auto-merge
Phase 6 (Close)   → work-on:close — trajectory + parent tracker + summary + worktree cleanup
```

After this module posts `FORGE:BUILDER` and returns, work-on.md's Universal continuation rule re-reads the issue labels. Since the label is not yet terminal (`workflow:merged` / `workflow:invalid` / `needs-human`), it proceeds immediately to Phase 4 (PR Creation) and then Phase 5 (Auto-Review).
