---
name: forgedock-test-gate
description: Execute the authoritative ForgeDock runtime test gate and return its machine-readable result.
---

# ForgeDock Test Gate

This is the Pi-native translation of the mandatory nested `test-gate` call. Read
`../../specs/pi-adapter.md` and then execute
`../../specs/original/commands/test-gate.md` in the current coordinator context.

The original specification remains authoritative. Return every structured
`FORGE:TEST_GATE:CAPABILITY={...}` row, then
`FORGE:TEST_GATE:CAPABILITIES_COMPLETE count=<N>`, followed by its exact
`FORGE:TEST_GATE:RESULT=BLOCK|PASS|SKIP` marker. Each row must retain the bound criterion
ID/text hash, capability/type/boundary/command, repository/target/head/tree, required state,
proof kind/evidence, and wake condition. An explicit `SKIP` is valid only for a complete report
with no required capabilities. Missing, malformed, or unavailable required proof is `BLOCK`,
not `SKIP`; capability blocks are never overrideable. If this skill cannot be loaded or
executed, return `FORGE:TEST_GATE:RESULT=BLOCK` with a setup-failure reason.

Do not create a workflow engine, dispatch another coordinator, or reinterpret
acceptance criteria. Nested issue creation must use the packaged
`forgedock-issue` translation when the original test-gate specification requests
`Skill(skill="issue", ...)`.
