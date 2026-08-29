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

This is a deployment/bundle strategy, not thorough standard review. Preserve included
PR discovery, prior open-finding gates across the bundle, automated build and CI gates,
material-change analysis, service/domain bug hunting, regression assessment, runtime
test gate, finding triage, and deployment checklist.

Use complete fresh-context reviewer panels and fail closed on any missing reviewer.
Emit exactly one authoritative terminal gate pass or failure for the reviewed SHA.
Never merge, approve, deploy, close the source issue, or clean a work-on-owned tree.
