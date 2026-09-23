# Reviewer report-delivery recovery qualification

## Scope and safety

This is a sanitized, remotely reviewable record for the existing ForgeDock PR #583 correction. It does not include reviewer bodies, authentication, or raw common/role keys. The real AlterLab panel and comments were not rerun or modified; no live GitHub write, issue, replacement PR, CI dispatch, merge, deployment, or ordinary-install replacement occurred.

## Original specialist publication failure

- AlterLab PR #33800 was frozen at head `bbf883b83a58ab464b9dd518d43be4a4e75f5fbc` against `main@4e71d8a4db03950212873ebe7769348ce3f6c3fb`.
- The specialist native run completed (exit code 0; 19 turns; 174,397 ms; `openai-codex/gpt-5.6-luna:medium`). Its report body and empty observations array were retained inline in the native transcript, but the specialist body/report files were absent.
- The single `forge_publish_reviewer` call supplied the common review key instead of the distinct prepared specialist role key. The role authorization matched the prepared role-key map. The old publisher rejected the mismatch with `Reviewer publication authorization does not match the prepared frozen role` before writing the report or invoking the publication helper. The original cause is established; this was not a GitHub transport failure.
- Existing correctness/security reports were preserved. The relevant raw artifacts remain local. Their sanitized digests are in `original-failure.json`; raw body and key values are omitted.

## Corrected ordinary-command exercise

One model invocation used the unmodified acceptance input `/review-pr 33800`, with no supplemental recovery directions, on a disposable local fixture. It ran Pi 0.87.1, Node v26.7.0, and pi-subagents 0.60.0 at `0931cbbb98ab253177b181bd334fe02dd919dca5`, using the configured `openai-codex/gpt-5.6-luna` owner (high) and reviewer (medium).

The prepared protected-route request selected **correctness, security, specialist** at **concurrency two**, with reviewer timeout 240,000 ms, panel deadline 600,000 ms, and publication timeout 120,000 ms. The panel deadline met the helper’s minimum. The parent completed in 313,742 ms. Exact per-role native run IDs, terminal states, report IDs/hashes, publication order, and adjudication are in `model-exercise.json`.

The fake GitHub transport rejected the first security-report POST before commit. That reviewer still completed; the parent reused its same run and authored content in one exact-role recovery. Readback verified the exact report bytes and permalink; no reviewer was relaunched. The final fixture has one report comment per role. The injected fixture defect (arbitrary nonblank issuer accepted) was correctly deduplicated to one `IMMEDIATE REPAIR`; the parent completed `CHANGES_REQUESTED` with `STAGING_GATE:FAIL` and a pending draft only. No issue was created. The configured `node --test` check passed 3/3. All PR/comment/policy APIs were fake and local.

The run recorded one non-impacting staging-guard rejection for read-only `subagent action:list` and two expected Bash blocks after preparation. The final patch now permits only read-only agent listing while preserving the one-shot prepared-workflow boundary; the updated guard test passes.

## Preserved setup failures

- The first disposable model invocation reached preflight but stopped because its fixture used `panel_timeout_ms:480000`, below the accepted 600,000 minimum. It performed no review preparation, reviewer launch, or publication; the v1 `RESULT.md` is retained locally.
- Two corrected-fixture launchers then failed while writing their start-time files with `Disk quota exceeded`, before Pi started. Their task logs and setup notes are retained locally; neither launched reviewers or posted fake comments.
- The `/dev/shm` cache-backed invocation above is the only corrected bare-command model run. It is not being repeated for a more favorable result.

## Final validation

- `npm run typecheck`: passed after the final authored-report and direct-CLI safeguards.
- Focused recovery, staging, adjudication, reviewer-tool, and knowledge-publication tests: **68/68 passed**.
- Complete serial suite: `node --test --test-concurrency=1 --import tsx "test/**/*.test.ts"` passed **492/498**, failed **0**, skipped **6**. The six skips require the optional pi-subagents test-support adapter seam.
- `npm run pack:check`: passed with **68 files**, including all four diagnostics bundle files. The generated tarball was kept outside the worktree.
- The earlier **484/490** serial-suite result was from before the final review remediations and is historical, not the final validation result. Earlier parallel attempts hit temporary-storage `EDQUOT`; a runner attempt incorrectly put `--test-concurrency` in `NODE_OPTIONS` and stopped before tests.
- The final independent read-only review accepted the code after requesting this evidence-summary correction. This delivery does not include merge or deployment.
