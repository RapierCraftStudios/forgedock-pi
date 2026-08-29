---
name: forgedock-test-gate
description: Execute the authoritative ForgeDock runtime test gate and return its machine-readable result.
---

# ForgeDock Test Gate

This is the Pi-native translation of the mandatory nested `test-gate` call. Read
`../../specs/pi-adapter.md` and then execute
`../../specs/original/commands/test-gate.md` in the current coordinator context.

The original specification remains authoritative. Return its exact
`FORGE:TEST_GATE:RESULT=BLOCK|PASS|SKIP` marker. An explicit `SKIP` is valid only
when the loaded specification emits it with a reason. If this skill cannot be
loaded or executed, return `FORGE:TEST_GATE:RESULT=BLOCK` with a setup-failure
reason; never invent `SKIP` for a missing execution.

Do not create a workflow engine, dispatch another coordinator, or reinterpret
acceptance criteria. Nested issue creation must use the packaged
`forgedock-issue` translation when the original test-gate specification requests
`Skill(skill="issue", ...)`.
