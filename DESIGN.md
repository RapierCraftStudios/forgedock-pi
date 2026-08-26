# ForgeDock for Pi — architecture and delivery contract

## Objective

Rebuild the `work-on`, `orchestrate`, and `review-pr` workflows as a portable, production-oriented Pi package. This is not a prompt-level port of the retained command specs. The specs are evidence for workflow intent; tested TypeScript code owns control flow, state, safety, and side effects.

The first milestone supports one issue through:

```text
resolve → investigate → plan → isolated implementation → verification
        → fresh review → integration-branch merge → close → cleanup
```

Multi-issue orchestration is added only after the single-issue lifecycle survives crash, restart, and machine handoff.

## Approved product decisions

- `pi-subagents` is the execution substrate and is consumed through its public APIs first.
- A fork of `pi-subagents` is allowed only after a failing integration test proves a missing load-bearing seam.
- Repository policy is tracked in `.forge/config.json`.
- Machine-local overrides may live in `.pi/forge.local.json`; they cannot weaken tracked safety policy.
- Runs must resume on another machine.
- GitHub-native typed state is authoritative; local state is a cache.
- Exactly one orchestrator owns a repository run. Automatic failover is out of scope for v1.
- Lease takeover after expiry requires explicit human authorization and starts a new lease epoch.
- Automatic merge is allowed only for configured integration branches after all typed gates pass.
- The protected/default production branch remains human-only.

## Boundaries

### Deterministic core owns

- run and phase state machines;
- legal transitions and terminal-state rules;
- event schemas, validation, hashes, sequence numbers, and idempotency keys;
- repository/run leases, epochs, expiry, heartbeat, and takeover;
- review blocking policy and merge authorization;
- dependency graph and ready-queue computation;
- worktree, branch, commit, PR, merge, close, and cleanup policy;
- safe verification command execution;
- GitHub state persistence and audit projections.

The core must be testable without Pi, an LLM, a checkout, or network access.

### `pi-subagents` owns

- child process/session execution;
- fresh or forked context construction;
- runtime agent discovery and registration;
- structured child output collection;
- async lifecycle, status, stop, steer, resume, and artifacts;
- model selection and usage accounting.

`pi-subagents` is never the ForgeDock state machine. A child result is evidence submitted to the core. A child may request a checkpoint through a narrow Forge tool, but the deterministic core validates and persists the transition; the model never gains direct transition, push, merge, label, comment, or close authority.

### Required delegation hierarchy

The work-on pipeline is itself a top-level subagent and must preserve nested review fanout:

```text
Pi session / Forge extension
└── forge-work-on agent (single issue, single writer, nesting enabled)
    ├── forge-reviewer-correctness (fresh, read-only, no recursion)
    ├── forge-reviewer-security    (fresh, read-only, no recursion)
    └── optional domain reviewers  (fresh, read-only, no recursion)
```

`forge-work-on` owns the issue-level reasoning loop from investigation through implementation and review. At the review phase it invokes `pi-subagents` itself, waits for the complete required panel, synthesizes the structured results, applies accepted fixes in its own worktree when authorized, and may repeat a bounded fix/re-review loop. The target depth is two child levels: work-on at depth 1 and reviewers at depth 2. Nested reviewers never receive the `subagent` tool.

Later, `/forge:orchestrate` launches multiple independent `forge-work-on` children. Each work-on child retains the same nested reviewer fanout; orchestration does not replace review with a parent-side shortcut.

The runtime definition for `forge-work-on` must therefore load the `pi-subagents` extension/tool in the child, set an explicit nesting/spawn budget, and restrict nested launches to registered Forge reviewer roles. This hierarchy is a tested contract, not a prompt convention.

### Subagents may

- investigate repository code and history with read-only tools;
- produce a schema-valid plan;
- modify only their assigned isolated worktree when acting as the single writer;
- run approved verification through controlled tools;
- have the `forge-work-on` role spawn the registered fresh reviewer panel;
- request typed phase checkpoints through the constrained `forge_checkpoint` tool;
- review a frozen diff from fresh context;
- return structured evidence and findings.

### Subagents may not

- write arbitrary GitHub issues, comments, labels, projects, or PR metadata;
- push branches or merge PRs;
- close issues;
- mutate another worktree or paths outside the assigned root;
- invent verification commands;
- bypass core validation when requesting a workflow transition;
- receive general GitHub credentials or raw `gh` write capability.

The parent extension performs authority-sensitive GitHub operations. A child-side Forge checkpoint extension may hold only the narrowly scoped ability to submit schema-valid events for its run and lease epoch; it exposes no general GitHub or merge primitive to the model.

## Package shape

```text
src/
  index.ts                    Pi extension entrypoint
  core/
    events.ts                 versioned event schemas
    state.ts                  reducer and legal transitions
    lease.ts                  lease/epoch rules
    policy.ts                 config and authority evaluation
    review.ts                 finding and blocking matrix
    dag.ts                    dependency graph and ready queue
  adapters/
    github-state.ts           state branch, CAS append/replay/snapshot
    github.ts                 issues, PRs, labels, projections
    git.ts                    worktrees, ancestry, commits, cleanup
    subagents.ts              public pi-subagents integration
    verification.ts           safe argv execution
  agents/
    register.ts               runtime role registration
    child-guard.ts            worktree and side-effect containment
    prompts/                  compact role contracts
  workflows/
    work-on.ts                single-issue controller
    review.ts                 frozen-SHA review controller
    orchestrate.ts            later multi-issue scheduler
  ui/
    commands.ts               /forge:* commands
    tools.ts                  model-callable Forge tools
    status.ts                 widgets and run rendering
test/
  core/
  adapters/
  integration/
```

## GitHub-native state authority

### State branch

Use a dedicated branch, defaulting to `forgedock/state/v1`. It contains only workflow state, never source code.

```text
.forgedock/
  repository.json
  locks/repository.json
  runs/<run-id>/events.ndjson
  runs/<run-id>/snapshot.json
```

Create commits through the GitHub Git Data API. Every update:

1. reads the current state-branch ref;
2. creates blobs/tree/commit whose parent is that exact ref;
3. updates the ref without force;
4. treats a non-fast-forward response as a compare-and-set conflict;
5. refetches, reduces current state, and either retries an idempotent append or stops on competing ownership.

### Event envelope

Every event contains at least:

```json
{
  "schema": "forgedock.run-event/v1",
  "eventId": "uuid",
  "runId": "uuid",
  "repository": "owner/name",
  "sequence": 42,
  "previousEventHash": "sha256:...",
  "type": "phase.completed",
  "actor": {
    "kind": "extension",
    "sessionId": "...",
    "leaseEpoch": 3
  },
  "occurredAt": "RFC3339 timestamp",
  "idempotencyKey": "...",
  "payload": {}
}
```

The reducer rejects sequence gaps, hash-chain breaks, stale lease epochs, illegal transitions, duplicate non-idempotent effects, and unknown required fields.

### Lease

The repository lease contains:

```json
{
  "schema": "forgedock.repository-lease/v1",
  "repository": "owner/name",
  "ownerRunId": "uuid",
  "ownerSessionId": "uuid",
  "epoch": 3,
  "acquiredAt": "...",
  "lastHeartbeatAt": "...",
  "expiresAt": "...",
  "takeoverRequired": false
}
```

Expiry never transfers ownership automatically. A different machine may inspect and resume only after a user confirms takeover. Takeover appends an audit event, increments `epoch`, and marks the old active attempt `abandoned` before a fresh idempotent attempt begins.

### GitHub projections

Issue comments and labels are human-readable projections. Every projection includes `runId`, `eventId`, schema version, and phase. Projection failure never converts a failed state transition into success. Projection retry is idempotent.

## Typed phase model

A phase attempt has one of:

```text
queued | running | completed | failed | blocked | needs-human | abandoned
```

Each attempt records:

- phase and attempt number;
- input artifact hash;
- `pi-subagents` run ID and logical node ID;
- assigned worktree, branch, base SHA, and current commit;
- output artifact hash;
- verification evidence;
- restart action;
- timestamps and lease epoch.

Machine handoff never blindly resumes an old local child. The old attempt is reconciled from durable evidence. If its terminal result cannot be proven, takeover abandons it and starts a new idempotent attempt from the last completed checkpoint.

## Work-on lifecycle

1. **Resolve** — validate `.forge/config.json`, repository identity, issue, policy, GitHub auth, base branch, clean control checkout, and lease.
2. **Investigate** — launch a read-only structured investigator; independently verify cited files and evidence before accepting its result.
3. **Plan** — produce a bounded file/symbol contract, acceptance criteria, risk, and allowed paths. A material product or architecture choice becomes `needs-human`.
4. **Prepare worktree** — the parent creates an explicit worktree from the policy-selected base SHA. The child does not create or select branches.
5. **Implement** — one writer child edits only the assigned worktree and returns a structured handoff. The parent verifies the actual diff rather than trusting the handoff.
6. **Verify** — run operator-approved named checks as argv arrays in a scrubbed environment with timeout and preserved exit status. Unknown or malformed results fail closed.
7. **Review** — freeze repository, PR/diff, run ID, head SHA, base SHA, and roster; launch fresh read-only reviewers in parallel; validate all findings and panel completion.
8. **Merge** — immediately recheck head SHA, base policy, required checks, reviewer roster, blocking matrix, and lease. Auto-merge only to a configured integration branch.
9. **Close** — verify merge first, then update issue state and projections exactly once.
10. **Cleanup** — remove only owned clean worktrees/temporary branches. Residue is reported, not concealed.

## Review contract

Review identity is the tuple:

```text
(repository, PR number, run ID, head SHA, base SHA, roster version)
```

A reviewer result is invalid if any identity field differs. Stale comments cannot satisfy a current panel.

Confidence and severity are orthogonal. One versioned matrix decides whether a finding blocks. Required verification failure, incomplete required panel, malformed gate result, stale head, merge conflict, or missing merge authority always blocks.

Before merge the core requires:

1. current head SHA equals reviewed SHA;
2. base SHA and branch policy are still valid;
3. every required reviewer completed for this run;
4. every required verification check passed;
5. no blocking finding remains;
6. the current lease epoch still owns the run;
7. integration-branch auto-merge is enabled by tracked policy.

The production/default branch is never auto-merged.

## Verification trust boundary

`.forge/config.json` stores commands as argv arrays, for example:

```json
{
  "verification": {
    "commands": {
      "test": { "argv": ["npm", "test"], "workingDirectory": ".", "required": true, "timeoutMs": 600000 },
      "typecheck": { "argv": ["npm", "run", "typecheck"], "workingDirectory": ".", "required": true, "timeoutMs": 300000 }
    }
  }
}
```

The run snapshots policy from the trusted base commit. A PR/worktree modification to policy cannot change the active run. Each command may specify a repository-relative `workingDirectory`, such as `web` for a monorepo package. Models request checks by name and cannot supply shell source. Before a writer launches, required local commands are preflighted through executable lookup, filesystem metadata, and package-manifest parsing only; no repository script is executed as a probe. The runner uses argv spawning from the bound package directory, scrubs secrets, preserves the child exit code separately from truncated output, records hashes/artifacts, and fails closed for required checks. An empty local command map explicitly delegates verification to GitHub CI.

Executing repository code is still a security boundary. Production writer/verification runs require a containment mode. The first implementation must at minimum provide child environment scrubbing, worktree-root enforcement, no GitHub credentials, and a child-side guard against GitHub writes/push/merge. A stronger container/sandbox backend remains an explicit production-hardening option.

## Pi and plugin integration

### `pi-subagents`

Use its public surfaces:

- in-process RPC for async `spawn`, `status`, `steer`, `resume`, and `stop`;
- exact async completion event advertised by `ping`;
- `pi-subagents/agents` for runtime `forge-work-on` and reviewer registration;
- a `forge-work-on` runtime definition that includes the `subagent` tool, loads the child runtime, permits depth-2 reviewer fanout, and restricts nested launches to Forge reviewer roles;
- reviewer runtime definitions that are fresh, read-only, schema-bound, and have no `subagent` tool;
- structured delegation/output schemas for both the work-on handoff and every nested review result;
- preflight to prove effective tools, nesting depth, model, context, skills, extensions, and artifacts;
- capability ceilings and child-only guard/checkpoint extensions;
- mission/artifact receipts as local execution evidence.

Fork only if an integration test proves that a required logical node identity, structured completion, stop/reconcile operation, child-only extension, or capability boundary cannot be expressed through these APIs.

### Other installed capabilities

- `pi-lens`: optional code navigation, diagnostics, and structural review evidence.
- `rpiv-ask-user-question`: authority and takeover decisions.
- `rpiv-todo`: local implementation progress only, never workflow authority.
- `pi-background-tasks`: test/build execution where background process lifecycle is useful; not the agent scheduler.
- `pi-hermes-memory`: durable user/project lessons; not run state.

## Initial command surface

```text
/forge:init
/forge:work-on <issue>
/forge:review <pr>
/forge:status [run]
/forge:resume <run>
/forge:takeover <run>
/forge:cancel <run>
```

`/forge:orchestrate` remains disabled until the single-issue milestone passes its recovery contract.

A model-callable `forge` tool exposes typed actions for inspect, plan, launch, status, and request-approval. It does not expose raw merge/close primitives without policy and authority checks.

## First-milestone validation contract

### Functional

- Resolve one configured GitHub issue.
- Produce a schema-valid investigation and plan.
- Create an isolated branch/worktree from the configured integration base.
- Run one top-level `forge-work-on` writer/orchestrator through `pi-subagents`.
- Run required verification by trusted command name.
- Have that work-on child spawn at least correctness and security reviewers in fresh nested contexts, wait for them, and return the complete panel result.
- Create or update one PR against an allowed integration branch.
- Auto-merge only after every typed gate passes.
- Verify merge, close the issue once, and clean owned worktree state.

### Recovery

At every phase boundary and during each active child:

- terminate Pi;
- start Pi on the same machine and reconcile;
- start Pi on another machine with no local run cache;
- reconstruct the run from the GitHub state branch;
- require takeover when the prior lease has expired;
- never duplicate a completed external effect.

### Safety

- A child cannot push, merge, close, label, comment, or access GitHub credentials.
- A child cannot mutate outside its assigned worktree.
- Policy modified by the worktree cannot alter the active run.
- Unknown event, gate, reviewer result, or state transition fails closed.
- A stale reviewed SHA cannot merge.
- A changed base or conflicting branch cannot merge silently.
- The default/production branch cannot auto-merge.
- CAS conflict or competing lease ownership stops the run.
- Cleanup never deletes uncommitted or unowned work.

### Evidence

The milestone is complete only with:

- unit tests for reducer, lease, review matrix, and DAG primitives;
- adapter tests for CAS conflict, replay, idempotency, and projection retry;
- integration tests against a disposable GitHub repository or deterministic fake;
- `pi-subagents` preflight and structured-completion integration tests;
- crash-point recovery tests;
- a final diff review and documented residual risks.

## Explicit non-goals for v1

- multi-runner high availability or automatic failover;
- multi-issue orchestration;
- decomposition and review-finding cascades;
- staging-to-production bundle review;
- autonomous production/default-branch merge;
- autonomous post-merge ADR, memory, dossier, or documentation commits;
- compatibility with Claude/OpenCode `Skill`, `Task`, or `Agent` syntax;
- parsing the retained Markdown specs at runtime.
