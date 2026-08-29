---
name: forgedock-issue
description: Create or deduplicate a ForgeDock issue through the original issue specification.
---

# ForgeDock Issue Hook

This is the Pi-native translation of mandatory nested `issue` calls from the
packaged workflow specifications. Read `../../specs/pi-adapter.md`, then execute
`../../specs/original/commands/issue.md` in the current coordinator context.

Preserve the original programmatic invocation contract, body-integrity checks,
deduplication rules, labels, and machine-readable create result. Do not replace
this with raw issue creation, invent workflow transitions, or silently swallow a
failed create/read-back. A missing or failed issue hook is a hard failure of the
calling phase, not a successful empty result.
