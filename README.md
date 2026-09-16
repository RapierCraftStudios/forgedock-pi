# ForgeDock Pi — thin first-pass candidate

A small Pi package for an evidence-first GitHub issue workflow. The candidate keeps three
semantic responsibilities visible:

- **Dispatcher:** resolves a bounded issue set, computes only real ordering, prepares inputs,
  and admits one owner per ready issue.
- **Issue owner:** investigates, uses targeted history, implements and proves the complete
  outcome, prepares the PR, obtains independent review, adjudicates findings, and delivers
  only with the configured authority.
- **Independent reviewer:** reviews a frozen patch and relevant consumers, publishes its own
  evidence, and never edits source, creates issues, merges, or deploys.

The extension is deliberately lexical. Workflow decisions are in four small candidate skills;
deterministic setup, request generation, publication/readback, and installation are in
`bin/forgedock-candidate.mjs` and `scripts/`.

## Commands

```text
/work-on <issue>
/orchestrate <selector>
/review-pr <PR>
/review-pr-staging <promotion PR>
```

`/forge:<command>` aliases resolve to the same candidate route. An ordinary issue PR targeting
the integration branch uses standard review. Only an explicit integration-to-protected
promotion uses staging review, which never repairs, merges, deploys, or closes issues.

## Install and use

See [`docs/candidate.md`](docs/candidate.md) for the isolated installer, launcher, doctor,
mechanical request flow, opt-in replacement, rollback, and evidence boundaries.

The package is intended for Pi 0.85.1 with the pinned `pi-subagents` package installed in the
same candidate configuration. Configure the target repository's `forge.yaml` with a full
`provider/model` identifier; model and reasoning settings remain configuration, not code.

```bash
npm run check
./scripts/install-candidate.sh \
  --subagents-source /home/dev/.pi/agent/git/github.com/RapierCraftStudios/pi-subagents
```

The installer snapshots the reviewed Git heads into an isolated cache and never changes the
operator's default Pi registration. Use the printed `launch.sh` and `doctor.sh` paths.

## Repository history

The original ForgeDock specifications and controllers remain in the repository as historical
source for deliberate comparison. They are not listed by this package's `pi` manifest and are
not loaded as candidate workflow authority.

## License

ForgeDock Pi is licensed under [AGPL-3.0-or-later](LICENSE).
