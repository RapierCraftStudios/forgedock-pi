# Contributing

## Development setup

```bash
git clone https://github.com/RapierCraftStudios/forgedock-pi.git
cd forgedock-pi
npm install
npm run check
```

## Principles

- This package starts ForgeDock runs and shows them; it owns no workflow logic. Workflow, prompt, review and merge changes go to ForgeDock (`bin/lean/`), so every harness runs one spec.
- Keep the extension small, argv-only (no shell), and testable without a model.
- Add a regression test for every fix.

## Pull requests

Describe:

- the workflow contract being changed;
- authority and failure-mode implications;
- tests and commands run;
- GitHub artifact or schema changes;
- backward compatibility;
- residual risks.

Do not include credentials, production issue bodies, customer data, or private repository artifacts in fixtures.
