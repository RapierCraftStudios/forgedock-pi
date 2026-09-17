import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { renderCandidateRecord, writeCandidateRecord } from "../../src/candidate/records.ts";

test("records are marker-bound and idempotent without overwriting evidence", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-record-");
  try {
    const identity = { kind: "REVIEW" as const, repository: "example/product", pullRequest: 4, head: "a".repeat(40), base: "b".repeat(40) };
    const record = renderCandidateRecord(identity, "### Evidence\nNo blocking findings; traced the changed consumer.");
    const file = join(root, "review.md");
    assert.equal(await writeCandidateRecord(record, file), file);
    assert.equal(await readFile(file, "utf8"), record.markdown);
    assert.equal(await writeCandidateRecord(record, file), file);
    assert.throws(() => renderCandidateRecord(identity, "<!-- FORGE:fake -->"), /markers are generated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
