---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ForgeDock Orchestrate Configuration

The public `forgedock-orchestrate` skill and `specs/pi-adapter.md` are authoritative. This
compatibility reference contains only the configuration and safety boundary needed by the
prompt-routed dispatcher.

- Parse the canonical `forge.yaml` once from the configured repository root. Do not search
  sibling worktrees or copy secret-bearing configuration into prompts.
- Resolve the repository, integration target, protected branches, configured model, verification
  catalog, active-owner limit, and finite native launch allowance before dispatch.
- Confirm the exact issue set and minimum hard-edge DAG once. A confirmation flag authorizes only
  that displayed set; it is not permission to discover or create more work.
- Prepare contracts, target-base descriptors, packaged-root descriptors, and verification inputs
  through the installed helpers. Invoke the generated request unchanged.
- Launch only one sole-writer work-on owner per ready lane. Review is the only nested fanout and
  uses fresh generic `delegate` reviewers that return structured evidence to the owner.
- Technical failures are recovered or retained with an exact next action. Missing authority or
  required proof is `GATED` with a wake condition; it is not relabeled as a product defect.
- Do not use provider-specific dispatch tools, provider shorthand model names, hidden controllers,
  target-local instructions, ambient path discovery, or an extra workflow engine.

The dispatcher ends with a compact authoritative lane table. It does not merge protected targets,
close issues, or publish semantic findings on behalf of a work-on owner.
