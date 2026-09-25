# Builder record linkage correction

## Assessment

**Corrected candidate: READY FOR BOUNDED USE for normal published Builder/Trajectory lineage.** The prior three-issue measured run's delivery/review evidence is reused, not repeated. Its original result remains **NOT READY as executed**: the original fixture #103 record is unchanged and still has `inputs: []`. The earlier [closeout report](./release-closeout-correction-20260925.md) remains historical evidence and was not rewritten. This qualification adds no claim about cross-session duplicate-owner prevention.

## Established cause from the retained #103 run

The retained `/tmp/issue103-records.json` contains an ordered pre-build batch: INVESTIGATOR; CLASSIFICATION and CONTEXT linked to INVESTIGATOR; CONTRACT linked to CLASSIFICATION and CONTEXT; and ARCHITECT linked to CONTRACT. The normal command was:

```bash
FORGEDOCK_CANDIDATE_ARTIFACT_ROOT=/tmp/issue103-record-artifacts \
  "$FORGEDOCK_CANDIDATE_BIN" record batch --input /tmp/issue103-records.json --publish
```

Its actual stdout result returned the five published permalinks (fixture-local comments `1010`–`1014`). It was not saved as a receipt file. The later Builder command omitted `--inputs-file`:

```bash
FORGEDOCK_CANDIDATE_ARTIFACT_ROOT=/tmp/issue103-record-artifacts \
  "$FORGEDOCK_CANDIDATE_BIN" record --kind BUILDER --repo example/product \
  --issue 103 --body-file /tmp/issue103-builder.md --cwd "$PWD" --publish
```

Thus the owner did **not** explicitly supply `[]`, and the helper did **not** lose a provided reference. The old `durableRecordSingle` converted an absent option to `inputs: []`; `durableRecord` then rendered `Inputs: none`. The resulting original Builder comment `1020` has `inputs: []`. The retained terminal input `/tmp/issue103-trajectory-inputs.json` explicitly selected the Builder, and trajectory comment `1028` links only to it, so the missing edge was not repaired downstream.

Original evidence remains untouched. SHA-256 references: pre-build input `94a139bbfbfd1d2f9afe83dda2abbd1a76ef7fc83a350bd1393f03823fc0698a`; authored Builder body `6d85ac52e719e3ffc8e6d67be6b664193f266b44ce670a7b79d54e7f6e9e24fa`; terminal inputs `161140b5e4fd20250142e4b301b0363a2af37c292ac89c9d9c33fc1512cdd177`; retained owner session `a7deb6d944d0843ace3c8920891b4fe19c42bfcd5d87c2ff136b5fea75940d6d`.

## Correction

Code commit: `c2b4edec28ae7ee47cc68ee9055bf28243c6e7d3` on the existing PR #583 branch.

- Single and batch issue-record publication now persist exact server-read-back receipts, including repository/workspace/issue, record identity, source head, returned URL, inputs, and supersession. Receipt paths and record identities are stable on exact retry.
- Published Builder publication no longer converts omitted inputs into an empty successful record. It resolves one applicable ARCHITECT from the same-workspace receipt, uses explicit supersession rather than recency, and verifies exact comment readbacks along ARCHITECT → CONTRACT → CONTEXT. When a receipt is unavailable, the helper uses only an unambiguous issue-local linked history whose plan head is reachable from the Builder head; competing leaves block publication.
- Builder metadata and rendered Markdown link the exact ARCHITECT permalink. Trajectory publication resolves the exact Builder receipt and links it, preserving the traversable chain. Missing/corrupt/ambiguous lineage returns a publication error naming the retained authored body; it does not publish `Inputs: none`.
- Local `publish:false` replay remains local: it writes no publication receipt and invents no HTTPS permalink.

## Controlled publication qualification

`test/candidate/knowledge-publication.test.ts` invokes the actual helper through the existing single and batch CLI entrypoints using isolated temporary Git repositories and a fake `gh` transport. It does not use the original fixture, live GitHub, an owner model, or a reviewer. The 16-test focused file passed. Its added cases verify:

1. Publish the five-record pre-build batch; call single-record Builder without `--inputs-file`; verify receipt creation, exact Builder machine inputs and rendered source link, then publish Trajectory with the existing Builder selector and verify its exact input.
2. Start at the discovered Trajectory and follow its link to Builder, Builder to ARCHITECT, ARCHITECT to CONTRACT, and CONTRACT to CONTEXT; every linked fake-server comment is read back.
3. Repeat pre-build, Builder, and Trajectory publication: stable receipt paths/record identities, `existing-identity` reconciliation, and no duplicate comments.
4. Publish Builder and Trajectory inside a batch, with Builder `inputs: []`; the shared publication path resolves the same chain.
5. Advance the source head after planning; the pre-build and Builder SHAs differ, while ancestry and exact receipts still resolve the right plan.
6. Competing plans with explicit supersession select the successor; two unsuperseded plans block in both receipt and issue-history fallback cases, retain the authored body, and publish no Builder. Missing lineage also blocks. Local non-publishing replay creates no HTTPS receipts.

## Validation and delivery boundary

- `npm run check`: typecheck passed; 507 tests total, 501 passed, 0 failed, 6 optional skips.
- `npm run pack:check`: passed; 68 files; shasum `7950e17b711b465473350ec119f09310848eb3c0`; integrity `sha512-AOWoPp9bZ3Qh9dpS0WuAtoxEwBkI49ZFSJbeoleSBHZKoIJqMpiRfFnjLfXAMZ/wXeNeeUlBODIVqaTZm72PMQ==`.
- An initial check caught a TypeScript strict-narrowing error in the new test metadata parser (`match[1]` could be undefined). The test helper now explicitly guards the capture; the final typecheck and suite above passed.
- No full orchestration, owner, reviewer, merge, original-record edit, live fixture write, ordinary-install replacement, or deployment was performed. The earlier #101/#102/#103 implementation, test, review, and simulated-delivery results remain the evidence for those stages.

The original run's NOT READY disposition is preserved as historical evidence; this targeted qualification establishes the corrected candidate's automatic publication behavior without rewriting that run or rerunning its already-delivered work.
