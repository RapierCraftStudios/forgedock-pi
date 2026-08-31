---
description: Implementation agent — writes code, makes commits, posts builder comment
argument-hint: "[issue number] [--repo GH_REPO] [--gh-flag GH_FLAG] [--worktree PATH] [--branch BRANCH]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build/implement — Implementation Subcommand

**Input**: $ARGUMENTS

**Invoked by**: `work-on.md` Step 3F, after worktree is created and context is gathered.
**Output**: Write code, commit(s), post `<!-- FORGE:BUILDER -->` comment, return result to caller.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/build/implement.md loaded and active. Agent is bound by this spec. -->

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--worktree {WORKTREE_PATH}` — absolute path to the git worktree (set by caller)
- `--branch {BRANCH}` — exact issue branch name (e.g. `feat/my-feature`)
- `--base-sha {FROZEN_BASE_SHA}` — exact frozen base SHA from the verified handoff

---

## Phase I1: Load Context from GitHub

Read the full context chain before writing a single line of code:

```bash
# Issue body and labels
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels

COMMENTS=$(gh api --paginate repos/{GH_REPO}/issues/{NUMBER}/comments --slurp | jq 'flatten')
# Select latest artifacts before checking schema/completion; never fall back to an older
# completed artifact when a newer partial/malformed one exists.
INVESTIGATOR_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:INVESTIGATOR -->") and (contains("<!-- INVESTIGATION:COMPLETE -->") or contains("<!-- INVESTIGATION:INVALID -->")))) | last | .body // ""')
ARCHITECT_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:ARCHITECT -->"))) | last | .body // ""')
CONTRACT_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:CONTRACT -->"))) | last | .body // ""')
CONTEXT_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:CONTEXT -->"))) | last | .body // ""')
BUILDER_BODY=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:BUILDER -->"))) | last | .body // ""')
BUILDER_ID=$(printf '%s' "$COMMENTS" | jq -r 'map(select(.body | contains("<!-- FORGE:BUILDER -->"))) | last | .id // ""')
```

Before evaluating any resume shortcut, validate the latest current authority; resume never bypasses current ownership. Task Type
`Investigation` alone uses its coordinator-owned no-mutation exception. Every mutation
task requires current-schema investigation/contract plus a latest completed architecture
with substantive closed ownership:

```bash
TASK_TYPE=$(printf '%s\n' "$INVESTIGATOR_BODY" | sed -n 's/^\*\*Task Type\*\*: //p' | tail -1)
if [ "$TASK_TYPE" != Investigation ]; then
  printf '%s' "$INVESTIGATOR_BODY" | grep -qF '### Production Execution Seam' || { echo "IMPLEMENT_RESULT: status: GATED blocker: current production investigation missing"; exit 1; }
  printf '%s' "$CONTRACT_BODY" | grep -qF '### Production Seam Ownership' || { echo "IMPLEMENT_RESULT: status: GATED blocker: current ownership contract missing"; exit 1; }
  printf '%s' "$ARCHITECT_BODY" | grep -qF '<!-- FORGE:ARCHITECT:COMPLETE -->' || { echo "IMPLEMENT_RESULT: status: GATED blocker: latest architecture is incomplete"; exit 1; }
  printf '%s' "$ARCHITECT_BODY" | grep -qF '**Ownership gate**: CLOSED' || { echo "IMPLEMENT_RESULT: status: GATED blocker: latest architecture ownership is not exactly CLOSED"; exit 1; }
  ARCHITECT_ROWS=$(printf '%s\n' "$ARCHITECT_BODY" | awk '/^### Production Seam Ownership/{p=1;next} /^### /{p=0} p' | grep '^|' | grep -vE '^\|[- ]+\||Observable Effect')
  [ -n "$ARCHITECT_ROWS" ] && ! printf '%s\n' "$ARCHITECT_ROWS" | grep -Eqi '\{[^}]*\}|\b(TBD|TODO|UNKNOWN|PLACEHOLDER)\b|\|[[:space:]]*\|' || { echo "IMPLEMENT_RESULT: status: GATED blocker: architecture ownership row missing or placeholder"; exit 1; }
  SIDE_EFFECT=$(printf '%s\n' "$INVESTIGATOR_BODY" | sed -n 's/^\*\*Irreversible\/provider side effect\*\*: \(YES\|NO\)$/\1/p' | tail -1)
  case "$SIDE_EFFECT" in
    NO) ;;
    YES)
      printf '%s' "$ARCHITECT_BODY" | grep -qF '**Provider transaction gate**: CLOSED' || { echo "IMPLEMENT_RESULT: status: GATED blocker: provider transaction gate is not closed"; exit 1; }
      PROVIDER_ROWS=$(printf '%s\n' "$ARCHITECT_BODY" | awk '/^### Provider Transaction Proof/{p=1;next} /^### /{p=0} p' | grep '^|' | grep -vE '^\|[- ]+\||Provider Operation')
      [ -n "$PROVIDER_ROWS" ] && ! printf '%s\n' "$PROVIDER_ROWS" | grep -Eqi '\{[^}]*\}|\b(TBD|TODO|UNKNOWN|PLACEHOLDER)\b|\|[[:space:]]*\|' || { echo "IMPLEMENT_RESULT: status: GATED blocker: provider transaction proof is incomplete"; exit 1; }
      ;;
    *) echo "IMPLEMENT_RESULT: status: GATED blocker: side-effect classification missing"; exit 1 ;;
  esac
  HIGH_RISKS=$(printf '%s\n' "$ARCHITECT_BODY" | awk '/^### Risk Assessment/{p=1;next} /^### /{p=0} p' | grep -E '\|[[:space:]]*HIGH[[:space:]]*\|' || true)
  if [ -n "$HIGH_RISKS" ]; then
    printf '%s' "$ARCHITECT_BODY" | grep -qF '**HIGH-risk gate**: CLOSED' || { echo "IMPLEMENT_RESULT: status: GATED blocker: HIGH-risk gate is not closed"; exit 1; }
    HIGH_PROOFS=$(printf '%s\n' "$ARCHITECT_BODY" | awk '/^### HIGH-Risk Verification/{p=1;next} /^### /{p=0} p' | grep '^|' | grep -vE '^\|[- ]+\||^\| HIGH Risk \|')
    RISK_COUNT=$(printf '%s\n' "$HIGH_RISKS" | grep -c '^|' || true)
    PROOF_COUNT=$(printf '%s\n' "$HIGH_PROOFS" | grep -c '^|' || true)
    [ "$RISK_COUNT" -eq "$PROOF_COUNT" ] && [ "$PROOF_COUNT" -gt 0 ] || { echo "IMPLEMENT_RESULT: status: GATED blocker: every HIGH risk requires exactly one verification row"; exit 1; }
    ! printf '%s\n' "$HIGH_PROOFS" | grep -Eqi '\{[^}]*\}|\b(TBD|TODO|UNKNOWN|PLACEHOLDER)\b|\|[[:space:]]*\|' || { echo "IMPLEMENT_RESULT: status: GATED blocker: HIGH-risk verification row is empty or placeholder"; exit 1; }
  fi
fi
```

**Resume check** — branch only on the latest builder artifact. A clean `HEAD` different from frozen base is an `ALREADY_DONE` candidate only after the current ownership checks above; staged/uncommitted changes return `status: COMPLETE` only after those same checks:
```bash
[ -n "${FROZEN_BASE_SHA:-}" ] && printf '%s' "$FROZEN_BASE_SHA" | grep -Eq '^[a-f0-9]{40}$' || { echo "IMPLEMENT_RESULT: status: GATED blocker: parsed --base-sha missing or malformed"; exit 1; }
if [ -n "$BUILDER_ID" ] && printf '%s' "$BUILDER_BODY" | grep -qF '<!-- FORGE:BUILDER:COMPLETE -->'; then
  mapfile -t VALIDATED_LINES < <(printf '%s\n' "$BUILDER_BODY" | sed -n 's/^validated_commit: \([a-f0-9]\{40\}\)$/\1/p')
  [ "${#VALIDATED_LINES[@]}" -eq 1 ] && [ "${VALIDATED_LINES[0]}" = "$(git rev-parse HEAD)" ] && [ -z "$(git status --porcelain)" ] && [ "$(git branch --show-current)" = "$BRANCH" ] || { echo "IMPLEMENT_RESULT: status: GATED blocker: completed builder identity is stale or ambiguous"; exit 1; }
  echo "IMPLEMENT_RESULT: status: ALREADY_DONE commits: [${VALIDATED_LINES[0]}]"
  exit 0
elif [ -n "$BUILDER_ID" ] && [ -n "$(git status --porcelain)" ]; then
  echo "IMPLEMENT_RESULT: status: COMPLETE files_changed: preserved-worktree-diff"
  exit 0
elif [ -n "$BUILDER_ID" ] && [ "$(git rev-parse HEAD)" != "$FROZEN_BASE_SHA" ]; then
  echo "IMPLEMENT_RESULT: status: ALREADY_DONE commits: [$(git rev-parse HEAD)]"
  exit 0
elif [ -n "$BUILDER_ID" ]; then
  echo "IMPLEMENT_RESULT: status: GATED blocker: partial builder artifact conflicts with frozen-base HEAD"
  exit 1
fi
```

**Primary guide**: First read Task Type from the completed investigation. For Task Type
`Investigation`, skip the architecture prerequisite and execute only the coordinator-owned
Investigation special case in I2; it performs no source mutation. For every mutation task,
a same-issue `<!-- FORGE:ARCHITECT -->` comment containing
`<!-- FORGE:ARCHITECT:COMPLETE -->` is a mandatory implementation precondition and the
**primary implementation input**. Follow its ordered implementation list exactly — it
defines which files change, in what order, and what consistency checks must pass. The
investigation report and contract are secondary context.

A legitimate architecture skip is represented by the explicit completed skip artifact
required by `build/architect.md`. If the completed marker is absent, STOP as automated
`GATED`; never infer a skip or proceed from investigation/contract alone.

Extract from architect plan (when present):
- Production Seam Ownership rows (every observable effect, public entrypoint, production owner, mutation/proof, and public-seam test)
- Ordered implementation list (sequence of file changes to make)
- All affected paths (every file that must change for consistency)
- Consistency checks (invariants the builder must verify before committing)
- Risk assessment (HIGH/MEDIUM/LOW risks to watch for)
- HIGH-Risk Verification rows (failure scenario, discriminating inputs/state sequence, named test, and failing-before evidence)

Before I3, require a current `### Production Seam Ownership` section with at least one
non-header ownership row and require every row to be closed. If an executable
owner of the requested behavior is omitted, marked read-only without source proof, or
represented only by a test-local fixture/mock, return automated `GATED` to investigation
before the first source mutation.

If the architecture contains any HIGH Risk Assessment row, require exactly one
substantive HIGH-Risk Verification row per HIGH risk and `**HIGH-risk gate**: CLOSED`
before I3. Reject placeholder rows. Identity-risk rows must use distinct values for fields
that could be conflated; durable-state rows must name the full transition/replay sequence.
Before staging, run every named test, record its passing-after result, and include the
row-to-test mapping in the Builder report. A missing or failing row is `GATED`. If there
are no HIGH risks, no extra table is required.

For provider work, every proof row must name authority, exact operation/failure scope,
required result/readback, replay/recovery, and a deterministic current-transaction test.
Fallback rows identify the exact failed operation that authorizes them. Run safe
failing-before tests when available and require every named scenario to pass before
staging.

Extract from investigation report:
- Affected files list
- Root cause
- Recommendation

Extract from contract:
- Task type (Bug Fix / Feature / Refactor / Maintenance / UI/UX / Full-Stack)
- Deliverables table (file, change, why)
- Acceptance criteria

**Danger-Zone Rule Cards (BINDING CONSTRAINTS)**: When the FORGE:CONTEXT comment contains a `### Danger-Zone Rule Cards` section, each card is a **binding must-not-violate constraint** with the same authority as devdocs custom instructions. Before writing any code, read all injected cards and internalize them as explicit prohibitions. If the implementation plan requires touching a file listed in a card, the card's rule overrides the plan — choose an implementation path that satisfies the rule, or post a `needs-human` comment explaining the conflict. Do NOT silently proceed past a rule card that the implementation would violate. The quality gate (check 2G.9) will flag violations as `known-pattern-recurrence` (highest embarrassment class). <!-- Added: forge#1744 -->

---

## Phase I2: Route by Task Type

| Task Type | Approach |
|-----------|----------|
| Bug Fix | Implement fix directly in worktree |
| Feature (backend only) | Implement directly |
| Feature (UI/UX) | Invoke `frontend-design` skill + visual verification |
| Full-Stack | Backend first, then invoke `frontend-design` skill for UI |
| Refactor / Maintenance | Implement directly following contract deliverables |
| Investigation | Spawn research agents, create GitHub issues for findings, skip to I5 |

**Investigation task special case**: Research deeply, create GitHub issues for each finding using the Pipeline Issue Template (see `commands/issue.md` § "Pipeline Issue Template"). Each issue MUST include `## Problem`, `## Affected Files`, and `## Acceptance Criteria`. Create each issue via the `/issue` create-hook's programmatic invocation contract (see `commands/issue.md` § "Programmatic Invocation Contract") — `Skill(skill="issue", args="--title \"...\" --body-file <path> --label ...")` — instead of calling the raw issue-creation command directly; this gets dedup and body validation for free. Post a deliverables comment listing the created issues, close the original issue, return `IMPLEMENT_RESULT: status: INVESTIGATION_COMPLETE`.

---

## Phase I3: Implement

Work in `{WORKTREE_PATH}`. Follow the contract deliverables table exactly — implement each file change listed, in the order that resolves dependencies first.

**Implementation rules**:
- Read the current file before modifying it — never assume its state
- Read related files identified in the context briefing before touching the changed code
- For each acceptance criterion in the contract: implement it, then verify it through the named public production seam
- A test-local helper, fixture, mock, unwired export, or prose contract cannot substitute for production wiring; require the public caller to invoke the changed implementation
- Do NOT add unrequested scope — contract out-of-scope items stay out of scope
- **Library callback verification**: When writing a lambda or callable that will be passed to a library/framework parameter (e.g., `prepared_statement_name_func=lambda: ""`, `key=lambda x: ...`), you MUST verify the expected calling convention BEFORE writing it. Check the library's default value for that parameter, its documentation, or its source code. A lambda with wrong arity causes `TypeError` at runtime — this is invisible to static analysis and linting. The P0 incident from PR #14391 was caused by `lambda _: ""` (1 arg) passed where SQLAlchemy expects 0 args.
- **Worktree-aware path derivation**: When writing shell code that derives repository paths, ALWAYS use `git rev-parse --show-toplevel` for the repo root in regular checkouts, or `git rev-parse --git-common-dir` (then `dirname`) to get the shared `.git` directory when the context may be a linked worktree. For worktree cleanup code specifically, ALWAYS use `--git-common-dir` — `--show-toplevel` returns the worktree path itself, NOT the main repo root. NEVER use `pwd`, relative paths, or `dirname` chains on `--show-toplevel` output for repo root derivation. Test path logic for both regular checkouts and linked worktrees. (Ref: review-findings #104, #105 — 4 PATH_DERIVATION defects, 15% of all review findings)
- **State machine completeness verification**: When implementing routing logic, state transition tables, or phase dispatch code (e.g., adding a `Skill()` call in a routing loop, adding a new phase to a state machine, creating a new subcommand file), you MUST run three checks BEFORE staging: (1) **Routing target existence** — for each `Skill("subcommand", ...)` call or file reference in routing logic, verify the target file exists at `commands/{subcommand-path}.md`; (2) **State reachability** — for each declared state or phase, verify at least one prior state or entry condition in the router routes to it; (3) **Subcommand invocation wiring** — for each `commands/work-on/*.md` file that declares its invocation condition (e.g., `Invoked by work-on.md routing loop, when X`), verify that condition is actually handled in the router. A missing target file, an unreachable state, or a declared-but-unwired subcommand will not surface until review. (Ref: review-findings #85, #116, #137 — 4 ROUTING defects, 15% of all review findings)
- **Migration safety checklist** *(trigger: diff includes `*.sql` files or files under a `migrations/` path)*: When any migration file is in the diff, verify ALL of the following BEFORE staging. Fix each violation inline — do not defer to review or the quality gate: (a) **Rollback file**: a corresponding down/rollback migration file exists (e.g. `0042_down_*.sql`, `rollback_*.sql`) or the migration is explicitly self-reversing (DROP of a previously-added column); (b) **NOT NULL safety**: any `ADD COLUMN ... NOT NULL` either includes a `DEFAULT` clause or is preceded by a backfill step — a NOT NULL column without DEFAULT locks the table and fails on existing rows; (c) **Constraint name consistency**: constraint names in the migration match ORM model declarations — a mismatch causes `alembic stamp` and FK introspection to silently diverge; (d) **CREATE TRIGGER idempotency**: every `CREATE TRIGGER` uses `CREATE OR REPLACE TRIGGER` or is preceded by `DROP TRIGGER IF EXISTS` — a bare `CREATE TRIGGER` fails on re-run in test and CI environments; (e) **Migration prefix uniqueness**: confirm the new file's numeric prefix does not already exist in the `infra/migrations/` tree (`ls infra/migrations/*.sql | grep -oP '^\d+' | sort | uniq -d` prints duplicates) — a duplicate prefix hard-fails the deploy gate regardless of file content. <!-- Added: forge#373 -->
- If you discover the contract is wrong (e.g. a file doesn't exist, a function has a different signature): STOP, post the discrepancy, and return automated `GATED` for coordinator-led reinvestigation/contract revision; do not add `needs-human`

**Worktree working directory**:
```bash
cd {WORKTREE_PATH}
# all file reads, writes, and git operations happen here
```

---

## Phase I3.5: Env/Config Completeness Check

**Run this BEFORE Phase I4.** This phase is read-only — it scans the working changes for INFRA-class gaps that would otherwise surface as review findings. Do NOT run `git add` or `git commit` here.

**Trigger**: Run this phase whenever the diff introduces env vars, touches infra/deploy configs, or adds literal IP addresses.

### Check 1 — New env var documentation sync

Scan changed files for newly introduced env var references:

```bash
cd {WORKTREE_PATH}
# Collect all env var names referenced in changed files
NEW_ENV_VARS=$(grep -rnE "os\.getenv\(|process\.env\." {CHANGED_FILES} 2>/dev/null \
  | grep -oP "(os\.getenv\(['\"]|process\.env\.)(\w+)" \
  | sed "s/os\.getenv\(['\"]//; s/process\.env\.//" \
  | sort -u)

if [ -n "$NEW_ENV_VARS" ]; then
    for var in $NEW_ENV_VARS; do
        grep -q "$var" .env.example 2>/dev/null \
            || echo "MISSING: $var not in .env.example — add it before staging"
        [ -f ENV_VARS.md ] \
            && { grep -q "$var" ENV_VARS.md \
                || echo "MISSING: $var not in ENV_VARS.md — add it before staging"; }
        [ -f env_validation.py ] \
            && { grep -q "$var" env_validation.py \
                || echo "MISSING: $var not in env_validation.py — add it before staging"; }
    done
fi
```

**If any MISSING line is printed**: add the var to the missing location before proceeding to Phase I4. If a file listed above doesn't exist in this repo (e.g. `ENV_VARS.md` or `env_validation.py` may not be present in all projects), skip that check silently.

### Check 2 — Deploy/infra restart risk

```bash
cd {WORKTREE_PATH}
INFRA_FILES=$(echo "{CHANGED_FILES}" | tr ' ' '\n' \
  | grep -E "docker-compose.*\.yml|deploy/|infra/")

if [ -n "$INFRA_FILES" ]; then
    echo "INFRA CHANGE DETECTED in: $INFRA_FILES"
    # Check for restart-inducing changes
    RESTART_LINES=$(while IFS= read -r f; do grep -n "" "$f"; done <<< "$INFRA_FILES" \
      | grep -E "^\+.*(image:|resources:|mem_limit|cpus:|restart:|depends_on:)" \
      | grep -v "^---" || true)
    if [ -n "$RESTART_LINES" ]; then
        echo "RESTART RISK: the following lines may force container restarts on next deploy:"
        echo "$RESTART_LINES"
        echo "ACTION: annotate your commit message with [restart: <service_name>]"
    fi
fi
```

**If RESTART RISK is printed**: annotate the commit message (in Phase V5) with `[restart: <service>]` so operators know to plan downtime.

### Check 3 — Hardcoded IPs and credentials

```bash
cd {WORKTREE_PATH}
# Scan for bare IPv4 literals not inside env var lookups
grep -rnE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" {CHANGED_FILES} 2>/dev/null \
  | grep -vE "os\.getenv|process\.env|\.env\.example|example|placeholder|test|mock|localhost|127\.0\.0\.1|0\.0\.0\.0" \
  && echo "HARDCODED IP: replace with a config reference (env var or config file) before staging"

# Scan for credential-like assignments with literal values
grep -rnE "(api_key|secret|password|token|credential)\s*=\s*(f?['\"]|\`)[^{'\"\`]" {CHANGED_FILES} 2>/dev/null \
  | grep -vE "os\.getenv|process\.env|example|placeholder|test|mock" \
  && echo "HARDCODED CREDENTIAL: replace with env var before staging"
```

**If HARDCODED IP or HARDCODED CREDENTIAL is printed**: replace the literal value with a config reference before proceeding to Phase I4. This is a hard blocker — do not stage hardcoded secrets or IPs.

---

## Phase I4: Stage Changes

**Precondition**: Do NOT commit yet — the validate subcommand (validate.md) runs AFTER implement and will make the commit in Phase V5 after the gate passes. Commit will happen in validate.md Phase V5 after the gate passes.

### Exact contract/claim path gate

Before staging, load the latest completed Builder Contract and, under orchestration, the
active coordination claim, then enumerate every modified, deleted, renamed, and untracked
non-ignored path in the assigned worktree. Every resulting path must be listed literally
in the contract and, when present, the claim. If a
required path is absent, STOP before staging and return automated `GATED` so investigation
and the durable contract/claim can be revised. Do not edit the newly discovered path,
weaken the comparison, or silently classify it as mechanical. A mechanically coupled
path such as `specs/original/SHA256SUMS` must still have been added to the contract and
claim before staging.

Migration collision check (if applicable):
```bash
git fetch origin
git log --oneline origin/{PR_BASE}..HEAD -- {MIGRATION_PATHS}
```
If a collision is detected, post evidence and return automated `GATED` before staging; do not add `needs-human`.

Stage the changed files:
```bash
cd {WORKTREE_PATH}
git add {CHANGED_FILES}
```

Do NOT run `git commit` here. The commit (with conventional commit message and issue reference) is made by validate.md Phase V5 after `GATE_PASSED=true`.

---

## Phase I5: Update Issue Body

Check off each acceptance criterion that has been implemented:
```bash
gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body'
# Edit the body: check off completed items, add PR reference if known
gh issue edit {NUMBER} {GH_FLAG} --body "{UPDATED_BODY}"
```

---

## Phase I6: Post FORGE:BUILDER Comment

Post the implementation summary comment. **Do NOT include `<!-- FORGE:BUILDER:COMPLETE -->` here**. Validation V5 commits and returns `validated_commit_sha`; only build.md Phase B6.5 appends the marker after every acceptance check passes and binds it to that exact commit.

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:BUILDER -->
## Implementation Complete

**Branch**: \`{BRANCH}\`
**Commits**: {COMMIT_SHA(S)}
**Files changed**: {COUNT}

### Approach
{One paragraph: what was built, key decisions, why this approach over alternatives}

### Changes
{Bulleted list of each file changed and what was done}

### Acceptance Criteria Status
{Checklist of each criterion from the contract, marked ✅ or ❌}

### Testing Checklist
- [ ] {Test scenario 1} [type:api]
- [ ] {Test scenario 2} [type:unit]
- [ ] {Test scenario 3} [type:e2e]

> **Test-type annotation** (optional): Append `[type:api]`, `[type:unit]`, `[type:e2e]`, or `[type:manual]` to each checklist item. The test gate reads this annotation directly and skips regex inference. Omit it to rely on regex classification fallback."
```

**Note**: `<!-- FORGE:BUILDER:COMPLETE -->` is intentionally absent from this comment. Build.md Phase B6.5 appends it only after validate.md returns an exact clean commit and every acceptance check passes. A commit alone is not build completion.

---

## Output

The subcommand writes its results to GitHub (FORGE:BUILDER comment). Return structured output to the caller:

```
IMPLEMENT_RESULT:
  status: COMPLETE | ALREADY_DONE | INVESTIGATION_COMPLETE | GATED | BLOCKED
  branch: {BRANCH}
  commits: [{SHA}, ...]
  files_changed: [{file}, ...]
  tests_changed: [{file or named scenario}, ...]
  comment_url: {url of FORGE:BUILDER comment}
  blocker: {description if status=GATED or BLOCKED}
```

---

## Integration Point in work-on.md

This module runs at **Step 3F** — after worktree creation and context gathering, before validate:

```
3E  → Worktree created (by router)
3C.5 → Context gathered (by context.md)
3F  → [THIS MODULE] Implement — code written, staged (not committed)
3F.5 → Validate (by validate.md) — gate loop runs; V5 commit happens here after GATE_PASSED=true
```

The validate subcommand reads the staged diff produced by this module, runs the gate, and commits only after the gate passes.
