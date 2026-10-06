# Archived ambiguous fixture contract

This directory preserves the original disposable #101/#102 issue input and display-boundary decision from the `eb16bbbc2a651aaf00bde28000bb0176da939db2` trial. Do not use it for the next qualification run.

The original #102 acceptance asked for a “profile team label” but specified neither an input field nor an output representation. The owner correctly returned GATED after #101 had delivered locally. No #102 source edits or review were made. The original native root remains an immutable WAITING/detached snapshot; the later child GATED marker does not rewrite it.

`issue-102-gated.record.md` is copied byte-for-byte from:
`/tmp/forgedock-gpt6-orchestration-eb16bbbc/candidate-artifacts/issue-102-gated.record.md`

SHA-256: `efdacc337a922b770f8842f0f4e38baf233dd025013ada4ad7d247359dfb2299`.

`issue-102-context.record.md` is the exact local CONTEXT record from that attempt; its SHA-256 is `2fc44edcb50fec08541aaaecc6d3a24e8e832fd1923a77fb24bcdf8083e5d4e4`. `native-events.jsonl` contains byte-exact launch, native wait/status, supervisor-reply, and GATED readback events selected by their original tool-call identities; its SHA-256 is `7737ae2b02d4a789251411cd9e2bffa51336263b0e87f1bdc7e72d0f931c90c1`.

The copied issue input and decision are exact snapshots of the files used in that run; their hashes matched the originals at archive time:

- `orchestrate-issues.json`: `41f92fc940883f4e1e98ed0e031b36c927c39df5f825a10b8bb8bd496c2c4011`
- `display-boundary.md`: `61b214180a9acfb6764f907fe25c03faf23999661a2d7c75d9f6e793350d48a1`

The original runner evidence remains at `/tmp/forgedock-gpt6-orchestration-eb16bbbc/{result.json,parent.jsonl}`. This archive is historical evidence only; it must not be edited to appear successful.
