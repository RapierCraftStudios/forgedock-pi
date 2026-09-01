## Problem

The successful portions of the #318 orchestration exceeded 30 minutes, causing headless Pi to emit `Auto-drain timed out after 1800000ms` while the coordinator and reviewer were still healthy. The children continued, but the top-level orchestrator could no longer reliably reconcile the batch or close its coordination issue.

## Root Cause

ForgeDock launches its orchestration workflow asynchronously and lets the headless parent end. Pi-subagents then applies its fixed 30-minute agent-end auto-drain deadline. The compact orchestrate contract configures child attention windows but does not explicitly wait for the exact async workflow with a deadline long enough for one-hour reviewers and closure.

## Affected Files

Candidate investigation starting points (not mutation authority):

1. `skills/forgedock-orchestrate/SKILL.md` — require an explicit exact-run headless wait after async workflow launch.
2. `specs/pi-adapter.md` — map run-to-completion orchestration to the blocking wait tool with a deadline exceeding reviewer timeout plus lifecycle grace.
3. `test/smoke/spec-package.test.ts` — assert the explicit wait identity, timeout, and attention behavior.

## Expected Behavior

ForgeDock continues to launch one async orchestration workflow, preserving bounded concurrent issue lanes. In run-to-completion/headless execution, the parent immediately waits on that exact workflow run with `stopOnAttention: false` and an explicit deadline of at least two hours. Healthy one-hour reviewers do not hit Pi-subagents' default 30-minute agent-end auto-drain. Interactive runs requested to complete also use the exact wait; unrelated background work is not drained accidentally.

## Acceptance Criteria

- [ ] Orchestrate still uses exactly one top-level asynchronous workflow launch. [type:unit]
- [ ] Headless/run-to-completion execution waits on the exact returned workflow run ID rather than ending and relying on default auto-drain. [type:e2e]
- [ ] The explicit wait timeout is at least 7,200,000 ms and uses `stopOnAttention: false`. [type:unit]
- [ ] The wait covers builder, one-hour review, merge, closure, and cleanup without reducing child timeouts or concurrency. [type:e2e]
- [ ] Timeout or terminal failure remains visible and actionable; the parent does not report successful orchestration while work remains active. [type:e2e]
- [ ] Add the #318 regression where a healthy coordinator remained active beyond 1,800,000 ms and the parent auto-drain failed. [type:e2e]

<!-- FORGE:BODY-INTEGRITY:headless-wait_372_872855 -->
