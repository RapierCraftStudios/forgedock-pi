# Disposable driver correction

The original attempt-4 driver consumed `for line in p.stdout` until EOF even
after `agent_end`, so a terminal parent result could be retained while the
outer wrapper waited indefinitely. The corrected disposable observers retain
three separate facts: prompt acceptance/terminal parent event, process cleanup,
and stream closure. They stop reading after a conclusive response or
`agent_end`, close stdin, wait 30 seconds, then terminate/kill only the owned
Pi host if needed, and record cleanup separately.

- Variant A recovery observer: `variant-a/parent-recovery-revision1/rpc-observer.py`
- Variant A route-correction observer: `variant-a/parent-recovery-revision2/rpc-observer.py`
- Variant B observer: `variant-b/qualification/rpc-runner.py`

The original outer timeout and the initial no-auth setup rejection remain
preserved as separate artifacts; neither is treated as a reviewer/provider
failure.
