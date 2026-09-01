---
name: forgedock-review-pr-staging
description: Run the authoritative non-merging staging-to-protected-target deployment review, including bundle findings, builds, CI/runtime gates, fresh reviewers, and one terminal gate marker.
---

# ForgeDock Staging Review

## Required loading

1. Read `../../specs/pi-adapter.md` completely.
2. Read `../../specs/original/commands/review-pr-staging.md` completely in bounded chunks.
3. Read the shared reviewer protocols and only the persona files selected by the
   staging specification.
4. Parse the arguments appended to this skill invocation. Exact PR numbers are valid.

## Execution contract

Use direct Bash with `gh` and `git` commands for all review operations; verify `gh`
authentication and repository access first. The original staging specification is
authoritative for bundle discovery, gates, reviewer panels, finding triage, and the
deployment checklist; follow its phases and hard rules.

Use complete fresh-context reviewer panels and fail closed on any missing reviewer.
Translate nested `Skill("issue", ...)` calls to the packaged `forgedock-issue` skill
and nested `Skill("test-gate", ...)` calls to the packaged `forgedock-test-gate` skill,
requiring its `FORGE:TEST_GATE:RESULT=BLOCK|PASS|SKIP` marker. Emit exactly one
authoritative terminal gate pass or failure for the reviewed SHA. Never merge, approve,
deploy, close the source issue, or clean a work-on-owned tree.
