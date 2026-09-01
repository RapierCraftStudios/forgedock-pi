## Problem

ForgeDock's active Pi review path joins reviewer results in the coordinator and can synthesize findings before each selected reviewer's exact result is durably visible on the PR. It can also create one issue per line-level finding even when multiple reviewer occurrences describe the same root cause and cohesive fix.

## Root Cause

The original review specification requires reviewer-specific PR comments and a complete-panel marker count, but the compact packaged review/coordinator/Pi contracts emphasize joined in-memory receipts and occurrence deduplication without an explicit durable per-reviewer comment barrier. Finding synthesis also deduplicates occurrences but does not clearly cluster them into one issue per shared invariant, production owner, and cohesive patch.

## Affected Files

Candidate investigation starting points (not mutation authority):

1. `skills/forgedock-review-pr/SKILL.md` — require separate exact reviewer-result comments and a complete barrier before synthesis.
2. `agents/forgedock-work-on-coordinator.md` — publish/read back reviewer results while keeping reviewer children read-only.
3. `specs/pi-adapter.md` — define Pi publication ownership and exact-head/attempt reviewer comment identity.
4. `specs/qualitative-review-protocol.md` — make reviewer-specific durable evidence precede deduplication, issue creation, verdict, and merge.
5. `specs/original/commands/review-pr.md` — clarify clustering from reviewer occurrences to safe issue surfaces rather than one issue per symptom.
6. `specs/original/SHA256SUMS` and `test/smoke/spec-package.test.ts` — preserve packaged integrity and regression coverage.

## Expected Behavior

Every selected fresh reviewer remains read-only and returns one complete exact-head/attempt result. The coordinator publishes each result verbatim as a separate PR comment with reviewer identity and verifies its readback. Only after every selected reviewer comment is present and valid may the coordinator deduplicate occurrences, cluster findings into safe issue surfaces, create issues, synthesize the review verdict, or merge. Findings sharing one root cause/invariant, production owner, cohesive patch, and acceptance surface become one canonical issue referencing all reviewer occurrences. Independent fixes remain separate issues.

## Acceptance Criteria

- [ ] Every selected reviewer has one separate durable PR comment bound to repository, PR, head, base, merge-base, attempt, worker, bundle, files, and units. [type:e2e]
- [ ] Reviewer children remain read-only; the coordinator publishes their exact returned bodies and verifies readback. [type:unit]
- [ ] Missing, malformed, stale, duplicate, or unpublished reviewer comments gate synthesis and merge. [type:e2e]
- [ ] Deduplication, issue creation, verdict, and merge occur only after the complete reviewer-comment barrier. [type:e2e]
- [ ] Multiple occurrences sharing one root cause/invariant, production owner, cohesive patch, and acceptance surface create one canonical finding issue. [type:e2e]
- [ ] Findings requiring independent owners, fixes, release paths, or acceptance criteria remain separate issues. [type:unit]
- [ ] The final review summary references every reviewer comment and every occurrence-to-issue cluster. [type:unit]

<!-- FORGE:BODY-INTEGRITY:reviewer-comment-barrier_385_872855 -->
