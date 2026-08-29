# ForgeDock Pi — prompt-routed architecture

## Product objective

Restore ForgeDock's original command behavior in Pi without rebuilding the workflow as
a hidden TypeScript state machine.

The authoritative product loop is:

```text
/orchestrate
  → one /work-on coordinator per issue
      → investigate
      → [decompose | contract → implement → verify → PR]
      → /review-pr
          → [remediate → fresh re-review]
          → merge
      → close issue → trajectory → cleanup
```

A single ordinary issue must complete this entire route reliably before additional
execution machinery is considered valuable.

## Behavioral authority

The original ForgeDock command specifications are packaged unchanged under
`specs/original/commands/`. Their hashes are recorded in
`specs/original/SHA256SUMS`.

`specs/pi-adapter.md` translates Claude/OpenCode runtime mechanics to Pi. It may map
tool names, skill loading, and subagent fan-out, but it may not alter:

- phase ordering or terminal conditions;
- command routing;
- GitHub labels and required `FORGE:*` artifacts;
- verification requirements;
- review selection, evidence, or blocking policy;
- remediation and re-review behavior;
- merge, closure, or cleanup ownership;
- staging deployment-gate semantics.

## Pi command architecture

Pi skills hold workflow specifications and references. A packaged, depth-bounded
work-on coordinator agent gives orchestrated issue lanes the one nested capability they
need for fresh review fanout:

```text
agents/
  forgedock-work-on-coordinator.md
skills/
  forgedock-orchestrate/
  forgedock-work-on/
  forgedock-review-pr/
  forgedock-review-pr-staging/
  forgedock-quality-gate/
```

Prompt templates expose discoverable `/orchestrate`, `/work-on`, `/review-pr`, and
`/review-pr-staging` entries. The extension performs one lexical transformation:

```text
/work-on 42  →  /skill:forgedock-work-on 42
```

The transform performs no GitHub access, parsing, confirmation, state recovery,
dispatch, or side effect. The expanded skill and visible Pi coordinator own the route.

`/forge:*` compatibility aliases map to the same skills.

## State and recovery

GitHub is the durable state layer:

- issue and PR state;
- `workflow:*`, `needs-human`, and review labels;
- completed `FORGE:*` comments;
- PR reviews, checks, commits, and merge state.

A new session must reconstruct the next phase from GitHub. Private journals, leases,
state branches, reducers, and controller-owned phase records are not workflow authority.
A completed phase artifact is idempotently skipped; a partial artifact is repaired or
restarted according to its specification.

## Coordinator ownership

### Work-on

The visible work-on coordinator owns one issue through terminal closure. It loads the
next phase specification progressively and continues until invalid, decomposed,
human-gated/awaiting-merge, or fully merged and closed.

Review may merge the PR but never closes the issue. Work-on close verifies the merge,
closes the issue explicitly, updates labels and parents, cleans the worktree, posts the
trajectory, and only then reports terminal success.

### Review

Standard review freezes the PR route, runs configured and integration verification,
derives a risk-based reviewer roster, and joins one complete fresh-context panel.
Reviewers start from the diff but may read/search the repository to trace callers,
imports, registration points, and cross-service behavior.

Every finding becomes a deduplicated issue before summary publication. Merge requires
an explicit request, a current reviewed SHA, the original blocking policy, and an
authorized non-production base.

A PR targeting the protected/default branch routes automatically to the staging review
strategy.

### Staging review

Staging review is a deployment/bundle gate, not a larger standard panel. It accepts an
exact PR, discovers included PRs, checks prior findings across the bundle, runs build,
CI, runtime and regression gates, and emits one terminal gate result. It never merges,
deploys, closes source issues, or cleans work-on trees.

### Orchestrate

Orchestrate is a dispatcher, never a builder. It resolves a confirmed issue set, filters
active/terminal work, establishes explicit/file/database ordering, detects cycles, and
launches exactly one work-on skill per ready issue with bounded concurrency.

It observes each lane as DONE, GATED, FAILED, or IN_PROGRESS. GATED is not FAILED.
It does not implement a second issue lifecycle.

## Subagents

Fork only for:

- independent parallel issue lanes;
- fresh-context load-bearing reviews;
- genuinely long isolated quality-gate work.

Orchestrate launches the packaged `forgedock-work-on-coordinator`, not the generic
builtin worker. That coordinator owns one issue and is explicitly authorized to launch
only its mandatory fresh read-only reviewer panel. Review coordination stays in the
work-on child, producing the bounded nesting shape:

```text
visible orchestrator → work-on coordinator → fresh reviewers
```

It never recursively launches another work-on lifecycle or writer. Every writer owns
one isolated worktree. Required reviewer panels are complete or fail closed; inline
self-review never substitutes for a missing reviewer.

Pi-subagents supplies execution and isolation. It is not the workflow state machine.

## Deterministic code boundary

TypeScript may make one leaf operation safe and deterministic, for example:

- resolving trusted configuration;
- running a named bounded verification command;
- taking a frozen PR snapshot;
- exact-head guarded merge.

It must not decide the next phase, synthesize a review verdict, dispatch a workflow,
close an issue, or reconcile a private run.

The active extension currently contains only the lexical command router. The previous
controllers remain temporarily as dormant migration code and must not be registered.
They should be deleted after the prompt-routed acceptance path is proven.

## Configuration

`forge.yaml` is the authoritative project configuration, matching original ForgeDock.
`.forge/config.json` belongs to the retired controller architecture and is not silently
interpreted as equivalent.

Pi may read YAML directly when `yq` is unavailable. Missing or malformed required
configuration still fails before workflow side effects.

## Acceptance gates

### Single issue

1. `/work-on N` resolves an ordinary open issue.
2. Investigation writes evidence and acceptance checks.
3. Implementation occurs in an isolated worktree.
4. Quality and configured verification pass.
5. A PR targets the correct non-production base.
6. Context-aware fresh review runs at the frozen head.
7. Blocking findings route through bounded remediation and fresh re-review.
8. The clean PR merges.
9. Work-on explicitly closes the issue, posts trajectory, and cleans the worktree.
10. Re-running the command is an idempotent no-op.
11. Interrupting at a phase boundary resumes from GitHub alone.

### Full command surface

- standalone standard review routes and completes correctly;
- exact-PR staging review emits a non-merging gate;
- orchestrate dispatches two independent issues concurrently;
- a dependent issue launches immediately after its predecessor succeeds;
- a human-gated predecessor pauses rather than failing its dependents.

## Deferred complexity

Until these acceptance gates pass repeatedly, do not reintroduce:

- TypeScript workflow controllers or phase reducers;
- private GitHub state branches and CAS journals;
- leases, takeover protocols, claims boards, or hidden run adoption;
- engine/OpenCode-specific execution paths;
- cost/value scheduling, telemetry, knowledge indexes, or cascade economics;
- automatic multi-machine recovery;
- additional command surfaces unrelated to the closed loop.
