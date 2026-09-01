# Prompt-Routed ForgeDock Command Canary

This document is the live repository canary for ForgeDock's prompt-routed issue lifecycle.

Pi lexically rewrites each friendly command to its native skill invocation:

```text
/orchestrate <arguments> → /skill:forgedock-orchestrate <arguments>
/work-on <arguments> → /skill:forgedock-work-on <arguments>
/review-pr <arguments> → /skill:forgedock-review-pr <arguments>
/review-pr-staging <arguments> → /skill:forgedock-review-pr-staging <arguments>
```

Each friendly command also accepts the `/forge:` compatibility prefix (for example,
`/forge:work-on <arguments>` routes identically to `/work-on <arguments>`).

The `forgedock-work-on` skill coordinates the issue lifecycle from the packaged specifications.
GitHub is the durable workflow state: `workflow:*` labels identify the current route, while
completed `FORGE:*` issue and pull-request artifacts preserve the evidence required to resume in
a new session.

## Two-tier review and promotion

The prompt-routed flow has two review tiers:

1. **Per-issue review** — run `/review-pr <PR>` before an issue change lands on
   `staging`. This reviews the individual frozen pull request and records its findings.
2. **Staging bundle review** — after the batch has accumulated on `staging`, the
   staging bundle review runs with `/review-pr staging`. This loads
   `forgedock-review-pr-staging` and reviews the staging-to-main bundle before
   promotion.

Staging bundle discovery uses the packaged resolver's frozen commit-graph
reachability. A merge, head, or patch commit must be reachable from the frozen
staging head and not from the frozen base; commit subjects and arbitrary issue/PR
references do not establish membership. The terminal staging gate names every
included PR and any open review-finding issue that blocks, together with build/CI and
runtime gate results. A passing gate is a visible promotion decision for the operator;
the staging review does not merge or deploy automatically.

No hidden local phase state is required to continue the workflow.

## Smoke-suite verification

Run the focused smoke suite without executing the full test corpus:

```bash
npm run test:smoke
```
