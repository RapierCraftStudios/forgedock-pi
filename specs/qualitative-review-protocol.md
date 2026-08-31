# ForgeDock Qualitative Review Protocol

This protocol applies to an issue lane whose integration target can move while the
lane is being validated or reviewed. It is a review-safety contract, not a workflow
engine. The production caller/adapter seam owns publication; this protocol does not
replace executable wiring with prose or test-local fixtures.

## Identity vocabulary

- **Launch base** is the exact dispatch-time target SHA recorded by `FORGE:BASE`. It is
  immutable launch attribution evidence and is never replaced.
- **Current base** is the exact SHA read from the authoritative target ref at a guarded
  refresh point.
- **Review base** is the current base used to compute the reviewed patch. After a
  refresh it is distinct from launch base and must be recorded in `FORGE:BASE_REFRESH`.
- **Review head** is the exact remote PR head SHA. **Merge base** is the exact
  `git merge-base review-base review-head` SHA. The tuple `(review base, review head,
  merge base)` identifies one review attempt.

A review or verification result is authorization only for its exact identity tuple.
No result from a previous base, head, or tuple may authorize a later one.

## Official review publication

Semantic approval and GitHub review events are separate facts. After the complete
frozen-head panel, checks, findings, mergeability, lease, and policy gates produce
`APPROVED` (or `APPROVED_WITH_FOLLOWUPS`), the coordinator publishes exactly one
review for the frozen head. It first attempts a pinned `APPROVE` request with
`commit_id=review_head_sha`, then reads the review back and requires its durable URL.

If and only if the authenticated actor equals the pull-request owner and GitHub
returns HTTP 422 with the exact normalized message `Review cannot be approved by
pull request author.`, ForgeDock makes one pinned `COMMENT` request using the same
body and frozen identity. The body records semantic `APPROVED`, repository/PR,
head/base/merge-base, complete reviewer coverage, checks, and finding IDs. The
COMMENT URL is audit evidence and never satisfies an independent protected-branch
approval. Generic provider errors, stale or malformed identity, and readback
failures remain gated; mutations are never blindly retried.

## Controlled refresh transaction

At the boundary before validation, before review fan-out, and immediately before merge:

1. Re-fetch the authoritative target ref and read its exact SHA. Never infer movement
   from a comment, issue title, commit subject, or stale local ref.
2. If the SHA differs from the recorded current/review base, prove that the movement is
   an authorized sibling merge: the new target is reachable from the old target, the
   target ref is the configured ref, and GitHub identifies the intervening merge as a
   verified sibling in the active orchestration batch. Unexpected, ambiguous, or
   non-fast-forward movement is `GATED`.
3. Publish immutable old/new evidence before mutating the lane:
   `FORGE:BASE_REFRESH` records launch SHA, old current/review base, new target SHA,
   target ref, sibling PR/merge SHA, actor/time, and refresh attempt.
4. Preserve the owned branch, its issue commits, and the existing PR. Before a PR is
   pushed, synchronize the owned branch onto the verified new target with a guarded
   operation. After a PR exists, integrate the verified target non-destructively and
   push with the expected remote-head lease. Never reset, overwrite, or force-push an
   unverified remote head. Conflicts are `GATED`.
5. Set the new review base to the verified target and recompute the merge-base. Rerun
   every required verification and acceptance check; pre-refresh output is retained as
   history but cannot authorize merge.
6. Update the same PR, freeze its exact new head/base/merge-base tuple, invalidate all
   older reviewer receipts and approvals for merge purposes, and launch one fresh
   complete qualitative panel. A partial, mixed-head, stale, or missing panel is
   `review-degraded`/`GATED`.
7. Recheck the exact tuple, target ref, clean tree, remote lease, mergeability, and
   protected-branch policy immediately before merge. Any mismatch remains `GATED`.

A refresh is continuation of the same lane, not a new issue, claim, implementation,
or PR. It must not repeat investigation or widen the Builder Contract. The original
launch base remains in every subsequent report and trajectory.

## Durable evidence

A complete refresh record contains machine-readable fields equivalent to:

```text
FORGE:BASE_REFRESH launch_sha=<immutable> old_base_sha=<exact> new_base_sha=<exact>
target_ref=refs/heads/staging sibling_merge_sha=<exact> merge_base_sha=<exact>
owned_branch=<branch> pr=<number> attempt=<positive integer>
```

The subsequent review record contains `review_base_sha`, `review_head_sha`, and
`merge_base_sha` plus the panel attempt. Evidence is valid only when all hashes are
full, reachable, and mutually consistent with the PR patch.

## Failure policy

Conflicts, target movement without verified sibling provenance, target/ref ambiguity,
remote lease mismatch, failed post-refresh verification, incomplete/degraded review,
unknown mergeability, or exact-head/base/merge-base mismatch are automated `GATED`
results with actionable evidence. They do not become `needs-human` unless a genuine
human authority decision is required. Protected `staging → main` approval rules are
unchanged.

Single-issue lanes with no target movement, overlap serialization, exact-head merge,
and existing protected-branch behavior remain unchanged.
