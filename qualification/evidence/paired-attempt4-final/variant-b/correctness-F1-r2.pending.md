<!-- FORGE:REVIEW_FOLLOW_UP repository=example/product pr=7 head=4eae364aee63e3bab1244fb6992b563f0af9af7a concern=correctness-F1 -->
<!-- FORGE:REVIEW_FOLLOW_UP_FINGERPRINT sha256:38ba9e097227767e687be879a1578867341ba53a02f312c3445c71f630717155 -->
## Problem

The restore function drops the input marker and returns only the payload.

## Root Cause

src/restore.mjs removes marker: input.marker from the returned object.

## Affected Files

- `src/restore.mjs`

## Expected Behavior

restore preserves both input.marker and input.payload in its result.

## Acceptance Criteria

- [ ] restore({marker:'m',payload:'p'}) returns {marker:'m',payload:'p'} or an equivalent object preserving both fields.
- [ ] Add or run verification covering marker and payload preservation.
- [ ] Submit the repaired head for re-review.

### Evidence and stage

Required stage: pre-merge correctness review
- Frozen PR #7 diff changes the return value from { marker: input.marker, payload: input.payload } to { payload: input.payload }.
- Reviewer report c2ca5e34-84c9-48e1-9f61-8f42f7ff3138 confirms marker loss at the frozen head.

### Review references

- https://github.com/example/product/pull/7
