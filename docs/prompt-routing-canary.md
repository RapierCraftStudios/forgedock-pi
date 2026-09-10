# Prompt-Routed `/work-on` Canary

This document is the live repository canary for ForgeDock's prompt-routed issue lifecycle.

Pi lexically rewrites the friendly command to the native skill invocation:

```text
/work-on <arguments> → /skill:forgedock-work-on <arguments>
```

The `forgedock-work-on` skill coordinates the issue lifecycle from the packaged specifications. GitHub is the durable workflow state: `workflow:*` labels identify the current route, while completed `FORGE:*` issue and pull-request artifacts preserve the evidence required to resume in a new session.

No hidden local phase state is required to continue the workflow.

## Stabilization baseline

The reachable route is `package.json` Pi metadata → `src/index.ts` → lexical prompt router →
public skills → packaged specifications/helpers. Retained `src/workflows/` and `src/agents/`
controller code is not registered. Review delegates return structured evidence to the owning
parent, which publishes one consolidated panel/gate record; the candidate package is always
packed and installed in a disposable Pi/project location for smoke validation rather than
replacing the package running the repair.
