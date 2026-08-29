# Agent Instructions

## No overengineering

- Never overengineer. Use the smallest direct solution that satisfies the current requirement.
- Prefer visible specifications and direct Bash, `gh`, and `git` commands over custom runtime tools, wrappers, state machines, credential layers, helper frameworks, or speculative abstractions.
- Do not add infrastructure for hypothetical future needs. Add a new abstraction only when the user explicitly requests it and the task cannot be solved safely with existing primitives.
- ForgeDock's Pi extension must remain a simple prompt/spec router. Workflow decisions and execution stay visible in agents and skills.
- If an implementation starts expanding beyond the immediate fix, stop, remove the extra machinery, and simplify before continuing.
