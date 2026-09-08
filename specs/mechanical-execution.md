# Bound execution inputs and mechanical preparation

Use these packaged leaf scripts for data preparation and record transport. They do not
choose issues, phases, findings or merges, and they launch no agents. The extension stays
a prompt router; native Pi runs execute the generated requests. Do not rewrite the rolling
workflow in each conversation or debug native internals to repair a JSON nesting mistake.

## Canonical policy once

Run preparation from the operator's canonical repository root containing `forge.yaml`.
The helper reads that exact file, verifies its repository identity, and derives model and
remediation limit from it (default one only when absent). It never searches other worktrees.
It stores small read-only per-lane policy inputs outside clean target bases. It records
canonical config path/digest, but does not copy or print the complete secret-bearing file.

The policy binds repository, issue, target, configured model, remediation allowance and
verification input. Native `extensionBindings` carries its path/digest into the owner as
`forgedock.execution/1`; task text carries the same descriptor for visibility. The owner
uses `helpers/dispatch.mjs context` to read that binding. A local index such as child 0 is
not issue identity. Local/missing/sibling forge.yaml files and historical comments cannot
change bound execution policy. If binding/input is absent or corrupt, report the exact
handoff failure; never borrow another checkout's configuration. The prepared lane worktree
is a separate exact binding: pass it as the child `cwd` with `worktree: false`, and treat a
stale or wrong Pi workspace as an internal launch-binding failure for rebind/retry, never a
human-facing issue gate.

Additional settings may be read selectively from the canonical config path after verifying
its recorded digest, never neighbouring files. A changed source requires parent clarification,
not silent replacement of bound model/cap. Never print complete secret-bearing configuration.
The prepared verification catalog remains a separate read-only input. A policy change or
legacy-resume input needs explicit parent authority and a newly prepared descriptor; native
retained bindings cannot silently be overwritten or enlarged by a child.

## Prepare an orchestration

Write approved data—not JavaScript—to a plan file:

```json
{
  "activeOwners": 2,
  "launchAllowance": 24,
  "requestStartedAt": "<actual original request timestamp>",
  "issues": [
    {"number": 42, "target": "staging", "baseCwd": "/actual/clean/target/base", "predecessors": [], "contract": {"path": "/retained/issue-42-contract.json", "sha256": "<descriptor-bytes-sha256>"}},
    {"number": 43, "target": "staging", "baseCwd": "/actual/clean/target/base", "predecessors": [42], "contract": {"path": "/retained/issue-43-contract.json", "sha256": "<descriptor-bytes-sha256>"}}
  ]
}
```

The issue list is already confirmed/topologically ordered; bases are prepared by existing
worktree rules. Each issue must carry a retained `contract` descriptor. The referenced
`forgedock.issue-contract/v1` JSON is canonical and versioned: it contains the issue number,
revision, optional predecessor digest, and a non-empty exact criterion list. Every criterion
has a stable ID, `sha256:<text>` hash, required proof type, and one or more affected
boundaries; `digest` is the SHA-256 of the canonical contract content excluding `digest`.
The helper validates both descriptor bytes and the internal digest before publishing a
request, and emits `contract` plus `contractDigest` in every lane policy. Missing, stale,
tampered, wrong-issue, or superseded descriptors fail before launch. Child-local config,
issue prose, or a generic `criterion-1` cannot replace the bound input.

`verification` is the prepared catalog path/SHA descriptor. If omitted, the helper snapshots
current configured commands; an empty catalog is not PASS and does not excuse missing
required verification.

Run `node <package>/specs/helpers/dispatch.mjs batch <plan.json> <new-empty-output-dir>`.
Read its `request.json` and invoke `subagent` with those exact fields, including the generated
`workflowScriptPath`, active limit and cumulative allowance. Do not copy or rewrite the
workflow body. Preparation rejects malformed data before publishing a runnable request;
fix the named plan/config field, not the native runner. Keep inputs while lanes may resume.

For standalone work-on, before leaving the canonical root use `single` with a plan containing
`number`, `target`, `requestStartedAt`, and the retained `contract` descriptor (plus optional
`verification`). Retain the returned input
descriptor and pass it explicitly to subsequent helpers; do not dispatch its own coordinator.

## Prepare a review

The owner writes a review plan containing `head`, `round` (0 initial, 1 first remediation),
and selected `roles`, each with `role`, `task` and `thinking`. Review input must also carry
the bound `contractDigest` and exact criterion IDs; a stale contract blocks reviewer launch.
Role tasks contain the frozen
diff/graph context; they cannot provide a different model. Use optional `input` only for an
explicit standalone/legacy descriptor; it must match the native binding when one exists.

Run `node <package>/specs/helpers/dispatch.mjs review <review.json> <new-empty-output-dir>`.
Invoke the exact generated request. The model and maximum round come from bound policy;
`general` aliases correctness and cannot duplicate it. Explicit configured thinking wins;
otherwise the role's risk-calibrated thinking suffix is added. Native budget and complete
panel requirements still apply. The helper validates requested rounds, not semantic history:
the owner must recover actual usage from the graph and cannot relabel another fix as round 1.

## Resolve supervisor identity before acting

Use the exact owner run ID from the native request:

`node <package>/specs/helpers/dispatch.mjs identify <batch.json> <native-status.json> <owner-run-id>`

Each generated native workflow key includes the full lane-input digest; that input contains
a fresh batch nonce. Resolution validates this digest/nonce and repository/issue/target,
associating data with the native run without a mutable side ledger. Only one matching native
step and original or documented `-recovery` workflow key may resolve. Use the returned
repository/issue/key in the response and operator prompt; never infer it from child index,
last-mentioned issue or a commit string. Unknown/ambiguous IDs stop action. Native nested
reviewer requests must first be resolved to their owner through native status. Confirm PR/
head separately before authorizing any continuation, and do not resize a run allowance
merely because the child asks.

## Publish knowledge safely

Write Markdown content sections with the native `write` tool, not interpolating shell
heredocs. Write a small draft JSON with `kind`, actual `inputs`, optional `supersedes`,
optional frozen `head`, `round` for REMEDIATION, and `pr` for REVIEW-PANEL. The bound policy
(or explicit standalone `input`) supplies identity/model/limit; never type those headers.

`node <package>/specs/helpers/record.mjs <draft.json> <body.md> <output.md> [--publish]`

The renderer obtains/validates the Git source commit, generates matching machine/human
headers and writes literal Markdown safely, including backticks. `--publish` uses existing
`gh` authentication with argument arrays, reuses an exact existing body on retry, and reads
back the exact server comment. Review publication checks the current PR head/target.
It never edits or deletes earlier records and never creates an issue. Standalone PR reviews
without a bound work-on issue use the explicit direct file-backed exception in
`knowledge-records.md`, not a fabricated issue policy. Publication still
requires the current stage's authority; direct CLI access is not a new permission grant.

These helpers reduce accidental policy/shape/identity/quoting mistakes. They are not an OS
sandbox or proof that an LLM cannot bypass instructions. Canary evaluation must verify their
actual use as well as code quality; source-level test success is not delivery evidence.
