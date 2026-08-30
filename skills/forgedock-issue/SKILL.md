---
name: forgedock-issue
description: Create or deduplicate a ForgeDock issue through the original issue specification.
---

# ForgeDock Issue Hook

This is the Pi-native translation of mandatory nested `issue` calls from the
packaged workflow specifications. Read `../../specs/pi-adapter.md`, then execute
`../../specs/original/commands/issue.md` in the current coordinator context.

This hook owns every new public issue created by ForgeDock, including review findings,
decomposition children, test failures, and pipeline follow-ups. Preserve the original
programmatic invocation contract, body-integrity checks, deduplication rules, labels, and
machine-readable create result. Specialized metadata is additive to the exact canonical
H2 sequence: Problem, Root Cause, Affected Files, Expected Behavior, Acceptance Criteria.
Affected Files are investigation starting points, not mutation authority.

Do not replace this hook with raw issue creation, invent workflow transitions, or
silently swallow a failed create/read-back. A missing or failed hook is a hard failure of
the creator, not a successful empty result. This is not an admission gate for user or
legacy issues; work-on investigation accepts and normalizes imperfect intake.
