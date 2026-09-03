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

Before route discovery, use direct Bash to read `forge.yaml` and verify `gh`
authentication and repository access. Use direct `gh` and `git` commands for all review
operations; do not use custom workflow runtime tools.

This is a deployment/bundle strategy, not thorough standard review. Preserve included
PR discovery, prior open-finding gates across the bundle, automated build and CI gates,
material-change analysis, service/domain bug hunting, regression assessment, runtime
test gate, finding triage, and deployment checklist.

Use complete fresh-context reviewer panels and fail closed on any missing reviewer.
Every published reviewer artifact must include a specific qualitative summary, 2–8
`path:line` evidence entries describing verified behaviors, and residual limitations even
when findings are empty. Reject marker-only, file-list-only, and generic clean output.
Before the open-finding gate, freeze the staging PR base/head SHAs and call the
exported `resolveStagingBundle` safety leaf with paginated, all-state GitHub PR
metadata plus commit-graph reachability evidence. Never derive membership from commit
subjects or lexical `#N` references. The resolver accepts only same-repository PRs with
merge/head/patch commits reachable from frozen head and not frozen base, and returns
`forgedock.staging-bundle-resolution/v1` evidence for the open-finding gate and Phase
6.5; ambiguous metadata fails closed. At Phase 6.5, translate the original nested
`Skill("test-gate", ...)` call to `forgedock-test-gate` and require its
`FORGE:TEST_GATE:RESULT=BLOCK|PASS|SKIP` marker. Translate mandatory finding creation
calls to `forgedock-issue`; every new finding extends the global canonical Problem, Root
Cause, Affected Files, Expected Behavior, and Acceptance Criteria sections with staging
metadata. A missing marker or failed read-back for a newly created issue is a hard
creator failure, never a skipped gate. Preserve a deduplicated legacy issue unchanged;
investigation normalizes it, and formatting is not a reuse/admission gate. Emit exactly one authoritative terminal gate pass or
failure for the reviewed SHA.
Never merge, approve, deploy, close the source issue, or clean a work-on-owned tree.
