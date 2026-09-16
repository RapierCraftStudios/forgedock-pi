# ForgeDock thin candidate

This branch packages one active path for Pi 0.85.1 and `pi-subagents` 0.60.0:

```text
/work-on       -> one owner -> one focused fresh review -> parent decision -> delivery
/orchestrate   -> bounded dispatcher -> one owner per admitted issue
/review-pr     -> independent correctness review (+ justified security/specialist)
/review-pr-staging -> non-merging integration-to-protected gate
```

The TypeScript extension only rewrites the four familiar aliases and exposes a harmless
`/forge-status` load probe. Skills own the workflow. The candidate helper performs bounded
configuration/intake/plan/request/record operations; it is not a workflow engine.

## Prerequisites

- Node.js 22+, Pi, Git, and `gh` for live GitHub work.
- A clean candidate checkout and a clean pinned `pi-subagents` checkout.
- A target repository with a canonical `forge.yaml` and a full `provider/model` value.
- Existing provider authentication. The candidate never copies auth files.

## Isolated install

From this checkout:

```bash
PI_SUBAGENTS_SOURCE=/home/dev/.pi/agent/git/github.com/RapierCraftStudios/pi-subagents \
PI_SUBAGENTS_COMMIT=0931cbbb98ab253177b181bd334fe02dd919dca5 \
PI_REQUIRED_VERSION=0.85.1 \
FORGEDOCK_CANDIDATE_INSTALL_ROOT=/home/dev/.cache/forgedock-pi-candidate/<candidate-sha> \
./scripts/install-candidate.sh --reuse-auth
```

`--reuse-auth` is optional; it symlinks an already-authenticated operator `auth.json` into
this disposable config without copying credentials. Omit it to qualify resource loading only.
The installer requires Pi 0.85.1 and pi-subagents commit 0931cbbb98ab253177b181bd334fe02dd919dca5
by default (alternate explicitly pinned values can be supplied). It snapshots both exact Git heads, installs them through Pi into
`<install-root>/pi-agent`, sets `defaultProjectTrust: never`, and does not edit the ordinary
`~/.pi/agent/settings.json`. It writes only package paths, versions, and policy metadata to
`manifest.json`; credentials are not copied or printed.

Launch an interactive candidate session in a target repository:

```bash
/home/dev/.cache/forgedock-pi-candidate/<candidate-sha>/launch.sh \
  --repo /absolute/path/to/target
```

Use `--model provider/id[:thinking]` or `--thinking high` only as an explicit operator
override. Without `--model`, the launcher reads the target's configured model through the
candidate helper. It passes `--no-approve`, so target-local `.pi` workflow settings cannot
change candidate authority; normal `AGENTS.md` coding guidance is still available.

## Doctor/status

```bash
/home/dev/.cache/forgedock-pi-candidate/<candidate-sha>/doctor.sh \
  --cwd /absolute/path/to/target
```

The JSON report includes Pi and package versions, isolated paths, effective non-secret
configuration, verification commands, target/config identity, and a fresh RPC `get_commands`
probe. `loadedResources` is based on the running Pi resource loader, not only settings text.
A readiness result never claims provider/GitHub live success: it reports those limitations.

## Mechanical request flow

Read-only intake:

```bash
$FORGEDOCK_CANDIDATE_BIN prepare --issue 123 --cwd /absolute/path/to/target
```

Dispatcher preparation (the selector can be `#123 #124`, `next 2`, `milestone:name`, or
`open`; `--issues-file` is useful for disposable local fixtures):

```bash
$FORGEDOCK_CANDIDATE_BIN prepare-dispatch \
  --selector 'next 2' --cwd /absolute/path/to/target \
  --out /tmp/forgedock-candidate/dispatch-1
```

The command writes `plan.json`, `workflow.js`, and `request.json`. Before invoking the request,
the dispatcher must query the supported native `subagent({ action: "status" })` boundary and
correlate exact issue/worktree ownership; unavailable or ambiguous ownership gates only that
issue. The dispatcher invokes the request through Pi's supported `subagent` tool; it does not
hand-author a native script.

Review preparation uses a JSON input with the frozen repository, PR, full head/base identities,
source checkout, original acceptance, evidence, and risk selection:

```bash
$FORGEDOCK_CANDIDATE_BIN prepare-review \
  --input /tmp/review-input.json --out /tmp/forgedock-candidate/review-123
```

## File-backed records and publication

Reviewers write body sections to a local file and invoke:

```bash
$FORGEDOCK_CANDIDATE_BIN record reviewer \
  --repo OWNER/REPO --pr 123 --head FULL_HEAD_SHA \
  --base-ref staging --base-sha FULL_BASE_SHA --role correctness \
  --body-file /tmp/review-body.md --report-file /tmp/review.report.md
```

Add `--publish` only when the target and GitHub write authority are explicitly authorized.
Publication lists comments once, reuses one matching stable marker, reconciles an ambiguous
create response by readback, and requires exact saved-byte/permalink readback. A saved report
survives a publication failure; review analysis is not rerun.

## Opt-in replacement

Do not run this during candidate development. After review, replace one exact old ForgeDock
registration, preserving unrelated settings:

```bash
./scripts/replace-candidate.sh \
  --config-dir "$HOME/.pi/agent" \
  --old-source 'git:github.com/RapierCraftStudios/forgedock-pi@OLD_SHA' \
  --candidate-source 'git:github.com/RapierCraftStudios/forgedock-pi@CANDIDATE_SHA'
```

The command backs up the exact settings bytes, installs the candidate through Pi, removes the
named old source, verifies one candidate registration and no old registration, and restores
the backup automatically if any step fails. It refuses to guess an old source.

Rollback with the directory printed by replacement:

```bash
./scripts/rollback-candidate.sh \
  --rollback "$HOME/.pi/agent/forgedock-candidate-rollbacks/<timestamp>"
```

Rollback restores the prior settings bytes, reinstalls the exact old source through Pi, removes
the candidate registration, and verifies the package registration readback. Restart Pi after
replacement or rollback.

## Evidence boundaries

- **Implemented and locally tested:** candidate routes, helper validation, dependency/roster
  rules, record idempotency, and installer/rollback logic.
- **Installed and native-tested:** only when the isolated installer and fresh RPC probe pass;
  the doctor report records exact identities.
- **Live GitHub lifecycle qualified:** requires an authorized disposable repository/issue/PR
  cycle with real comments and readback; this candidate does not create remote test data by
  default.
- **Production release authorized:** not granted by this branch or its scripts.
