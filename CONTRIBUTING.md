# Contributing

## Development setup

```bash
git clone https://github.com/RapierCraftStudios/forgedock-pi.git
cd forgedock-pi
npm install
npm run check
```

## Principles

- Keep workflow authority deterministic and testable without an LLM.
- Use `pi-subagents` public APIs before considering a fork.
- Preserve canonical ForgeDock GitHub artifact formats.
- Keep one writer per worktree.
- Fail closed for identity, lease, verification, review, audit, and merge ambiguity.
- Never add domain-specific bypasses to satisfy one production ticket.
- Add regression tests for every safety or recovery fix.

## Pull requests

Describe:

- the workflow contract being changed;
- authority and failure-mode implications;
- tests and commands run;
- GitHub artifact or schema changes;
- backward compatibility;
- residual risks.

Do not include credentials, production issue bodies, customer data, or private repository artifacts in fixtures.
