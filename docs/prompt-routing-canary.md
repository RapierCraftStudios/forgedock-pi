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

No hidden local phase state is required to continue the workflow.

## Smoke-suite verification

Run the focused smoke suite without executing the full test corpus:

```bash
npm run test:smoke
```
