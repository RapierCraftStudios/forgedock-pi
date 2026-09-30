# Authorized PR #583 native closeout

**Assessment: PASS WITH SELF-RECOVERY**, based on saved run `b64ae7db7`. The tested ForgeDock code was exactly `392daed1a178e9081d86ec6c85430ba893cb0f9c`; this file and its accompanying evaluation are evidence-only and do not alter that tested code. The target was disposable `example/product#7` through local fake GitHub, not a live repository.

## Preflight

- Corrected fixture: base `16e4e51e3f24a44c882e929c577b717461d09599`, head `93fa2ca98f47cacaa44d5dbf0f7d1ac936b85d1f`. Its actual `npm test` passed **1/1** on a pristine detached worktree. Preflight did not invoke `forge_run_check` or create a ForgeDock receipt.
- A fresh Pi 0.87.1 process reported the candidate extension, parent/staging skills, prompt templates, reviewer profile and `candidate/reviewer-tools.ts`; `PI_SUBAGENT_EXTRA_AGENT_DIRS` selected the source reviewer profile. The helper resolved to the candidate `bin/forgedock-candidate.mjs`. The isolated settings had no package sources, so the installed `a58675de` ForgeDock resources were not visible.
- Provider auth was ready via the isolated OAuth copy. Parent defaults remained `openai-codex/gpt-6-luna`/`max`; reviewer availability was `openai-codex/gpt-5.6-luna`/`medium`. Ordinary settings and auth were unchanged.
- The corrected evaluator was exercised offline against the retained September 29 output. It reconstructed that historical check-order failure and `sourceCommitAtLaunch` launcher error; that result remains historical and unchanged.

## New native run and check receipt

- Parent session: `01a0f071-7e27-711e-af1f-e1121bd353ba`.
- Reviewer workflow: `call_WlorcWYu99QRlhpIBPQXHglo|fc_07b8fc6f8fa8aa3a016abc87f688cc87d0955bbdc0e3604c02`.
- Reviewer run: `753c61ab-59fc-4b53-ae4e-bac154c4d71c`, role `correctness`, terminal `completed`, exit code 0; actual runtime metadata records `openai-codex/gpt-5.6-luna:medium`, 42,548 ms. Parent session elapsed **288.971 seconds** and exited 0.
- `forge_prepare_review` froze head `93fa2ca9…` and base `main@16e4e51e…`. `forge_run_check` then executed `npm test` before the actual reviewer workflow. It passed **1 test, 0 failures** and retained a bound receipt at `native-runs/2026-09-30T03-52-43-764Z/prepared-review/checks/test.json` (`status=passed`, exact head and config SHA `532318d1b31c9f853cbddcf242f2c655ab609920d1da3e6e4a98c07ab8f84a2b`).
- The earlier `subagent {action:"list"}` at 03:54:22 was management enumeration, not a reviewer launch. The actual workflow call at 03:54:35 launched the one correctness reviewer after the check.

## Review, recovery, and publication

The reviewer published one clean report, fake comment #1000, with no findings. The parent published `APPROVE`; the controlled provisional-panel GET for comment #1001 failed once with the injected TLS timeout and then succeeded on a retry of that **same** comment. Final panel #1002 and gate #1003 were read back; the gate’s parent permalink equals the final panel URL.

The corrected offline evaluator at `evaluation.json` completed against this saved run only: **PASS WITH SELF-RECOVERY**, with no unresolved terminal failures. It distinguishes the management-only agent listing from the single actual reviewer workflow.

Two intermediate parent tool errors were resolved without evaluator intervention. First, a post-prepare Bash inspection was blocked by the staging guard; no shell command ran, and the parent continued with permitted reads and the configured check. Later, the first `forge_publish_record` passed `checks:["CI","test"]` and was rejected because CI had no local ForgeDock receipt. The parent corrected its own call to `checks:["test"]`; the prepared exact-head policy evidence independently showed required CI `SUCCESS`, and the final gate published/read back as `PASS`. No external evaluator repaired arguments, created receipts, or published anything.

Final response excerpt:

> PR #7 (`93fa2ca`, base `main` at `16e4e51`): **APPROVE — STAGING_GATE PASS**.
>
> No findings or unresolved prerequisites. Required CI succeeded, and the configured test passed (1/1).
>
> - [Reviewer report](https://github.com/example/product/pull/7#issuecomment-1000)
> - [REVIEW-PANEL](https://github.com/example/product/pull/7#issuecomment-1002)
> - [STAGING_GATE](https://github.com/example/product/pull/7#issuecomment-1003)
>
> The reviewer did not run commands; the configured test was run by the parent. This gate is promotion evidence, not authorization to merge or deploy.

## Preserved harness failures and boundaries

- The first launch task, `b0490a858`, failed **before Pi spawn** because an over-escaped whitespace regex misparsed the local mirror’s `git ls-remote` output. No parent/session/model or publication occurred. The failure and correction are preserved in `pre-spawn-parser-failure.json`; the actual corrected run is the separate `b64ae7db7` above.
- The new Pi parent itself reached `agent_end` and exited 0. The outer background task exited 1 because its inline postconditions looked for reviewer artifacts under the source worktree and required zero intermediate finalizer errors. Reviewer artifacts were retained under `sessions/subagent-artifacts`; the one gate-call error was corrected by the parent. The offline corrected evaluation accounts for the actual locations and resolved error without changing the original harness result.
- All report/panel/gate comments were in the local fake-GitHub state; issue writes and unsupported calls were zero. Git transport used a local mirror with pushes blocked. No live GitHub/AlterLab action, merge, deployment, or CI dispatch occurred. No further model/reviewer run was launched.
