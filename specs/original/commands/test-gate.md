---
description: Run the configured runtime proof gate for an integration bundle
argument-hint: "[--prs <numbers>] [--base <branch>]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ForgeDock Runtime Test Gate

This is the Pi-native nested test gate used only when the staging route requires runtime or
integration proof. It returns exactly one machine-readable result:

`FORGE:TEST_GATE:RESULT=BLOCK|PASS|SKIP`

The gate is a verifier, not a workflow engine. It does not choose issue scope, invent findings,
launch another coordinator, merge, deploy, or turn a missing capability into a successful skip.

## Resolve and freeze

Read canonical `forge.yaml` once and resolve repository, configured base/integration branches,
verification commands, integration-test catalog, and test-gate posture. Resolve the caller's
frozen bundle PRs and exact head/base identity once. The owner supplies the original acceptance,
criterion IDs/text hashes when available, proof types, active paths, and contract/source identity.
Do not infer required proof from a severity label or from a structural string match.

Before any test-or-skip decision, compile the required capability set from the bound criteria and
changed behavior. Each capability names:

- criterion ID and exact criterion-text hash;
- source head and contract digest (when a bound contract exists);
- semantic boundary (`unit`, `runtime`, `integration`, `e2e`, `browser`, `database`, `queue`,
  `credential`, or another explicitly configured boundary);
- exact check/command and input identity; and
- state, evidence, and wake condition.

## Fail closed on required proof

A required capability is PASS only when its identity matches the frozen route and its evidence
proves the named semantic boundary. `MISSING`, `SKIPPED`, `UNKNOWN`, `CONTRADICTED`, malformed,
stale, unavailable, or structural-only proof is not PASS. Emit a durable blocked report before
returning BLOCK:

`FORGE:VERIFICATION_BLOCKED capability=<name> criterion=<id> source_head=<sha> contract=<digest> state=<state> wake=<exact-condition>`

Use a file-backed/artifact record for the full evidence; never place untrusted command or report
text in an executable shell expression. A required runtime/integration/browser/database/queue or
credential criterion cannot be satisfied by a source assertion, YAML check, optional skip, or
mock that bypasses the boundary. If a required service is irrelevant to the bound criteria, it is
not a required capability and its absence does not gate this change.

## Execute applicable checks

Run trusted configured checks once for the frozen head, reusing exact-SHA evidence only when the
content and relevant environment inputs are unchanged. Use the real producer/consumer boundary
and its callers; keep external services at the boundary and do not call destructive production
operations. Record command, input/head, environment, result, and limitation. A failed required
check is BLOCK with its concrete failure. A passed structural check supplements but cannot replace
missing semantic proof.

Only an explicitly non-required gate may SKIP. The valid SKIP cases are a deliberate no-required-
runtime-proof result, such as a bundle with no executable changes and no runtime/integration
criteria, or a configuration that is genuinely irrelevant to the changed behavior. Emit a reason
annotation before the result:

`FORGE:TEST_GATE:SKIP|reason=<bounded-reason>`

Never emit SKIP merely because the configured test service, credential, browser, database, queue,
runner, or integration environment is unavailable when the bound acceptance requires it. That
case is BLOCK plus the exact wake condition.

## Result contract

- `PASS` only when every required capability and configured applicable check is complete, identity
  bound, semantically appropriate, and passing.
- `BLOCK` for a failed check, incomplete panel input, missing/invalid required proof, stale identity,
  structural substitute, or unavailable required capability. Preserve the exact next action.
- `SKIP` only for the explicit non-required cases above, with a reason; it is not evidence of
  runtime delivery.

Return the result marker and a concise evidence summary to the staging owner. The owner publishes
the single consolidated staging gate record. Use `Skill("issue", ...)` only for a confirmed,
actionable, independently valuable follow-up under existing authorization; do not create an issue
for a missing capability or a speculative failure.
