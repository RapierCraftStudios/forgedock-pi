import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

type Criterion = { id: string; sourceOrdinal: number; text: string; textHash: string; proofType: string; affectedBoundaries: string[] };
type Mapping = { schema: string; issue: number; sourceBodySha256: string; criteria: Criterion[] };
type MappedIssue = { number: number; body: string; acceptance: string[]; acceptanceMapping: Mapping; mutationFiles: string[] };
const acceptanceModule = await import(new URL("../../candidate/acceptance.mjs", import.meta.url).href);
const mapIssueAcceptance = acceptanceModule.mapIssueAcceptance as (issueNumber: number, body: string, affectedBoundaries?: string[]) => Mapping;
const validateIssueAcceptanceMapping = acceptanceModule.validateIssueAcceptanceMapping as (issue: MappedIssue) => Mapping;

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("acceptance map preserves multiline HTML/comments and proof annotations while excluding only trailing Forge metadata", () => {
  const body = [
    "## Problem",
    "A source-bound example.",
    "## Acceptance Criteria",
    "- [ ] Keep literal <em>HTML</em> and the following line",
    "  including this author comment: <!-- a literal comment -->.",
    "- [ ] Preserve the typed criterion [type:unit]",
    "<!-- FORGE:BATCHABLE -->",
    "<!-- FORGE:BODY-INTEGRITY:source-fixture -->",
    "<!-- issue-create-token:source-fixture-token -->",
    "## Affected Files",
    "- `src/example.ts`",
  ].join("\n");
  const mapping = mapIssueAcceptance(42, body, ["src/example.ts"]);

  assert.equal(mapping.schema, "forgedock.candidate-acceptance-map/v1");
  assert.equal(mapping.sourceBodySha256, sha256(body));
  assert.deepEqual(mapping.criteria.map(({ text, proofType, sourceOrdinal }) => ({ text, proofType, sourceOrdinal })), [
    {
      text: "Keep literal <em>HTML</em> and the following line\n  including this author comment: <!-- a literal comment -->.",
      proofType: "behavioral",
      sourceOrdinal: 1,
    },
    { text: "Preserve the typed criterion", proofType: "unit", sourceOrdinal: 2 },
  ]);
  assert.ok(mapping.criteria.every((criterion) => criterion.affectedBoundaries.includes("src/example.ts")));
  assert.ok(mapping.criteria.every((criterion) => criterion.textHash === sha256(criterion.text)));
  assert.equal(mapping.criteria.some((criterion) => criterion.text.includes("BODY-INTEGRITY")), false);
  assert.equal(mapping.criteria.some((criterion) => criterion.text.includes("issue-create-token")), false);
});

test("integration and other explicit proof annotations survive trailing metadata without rewriting criterion text", () => {
  const body = [
    "## Acceptance Criteria",
    "- [ ] Verify the real consumer through the local integration path [type:integration]",
    "<!-- FORGE:BATCHABLE -->",
    "<!-- FORGE:BODY-INTEGRITY:integration-fixture -->",
    "<!-- issue-create-token:integration-fixture-token -->",
    "- [ ] Keep the existing unit annotation [type:unit]",
    "- [ ] Preserve other explicit proof labels [type:property-based]",
    "- [ ] An unannotated criterion keeps the default behavior proof.",
  ].join("\n");
  const mapping = mapIssueAcceptance(89, body, ["src/consumer.ts", "test/consumer.test.ts"]);
  assert.deepEqual(mapping.criteria.map((criterion) => [criterion.text, criterion.proofType]), [
    ["Verify the real consumer through the local integration path", "integration"],
    ["Keep the existing unit annotation", "unit"],
    ["Preserve other explicit proof labels", "property-based"],
    ["An unannotated criterion keeps the default behavior proof.", "behavioral"],
  ]);
  assert.ok(mapping.criteria.every((criterion) => criterion.affectedBoundaries.includes("test/consumer.test.ts")));
  assert.equal(mapping.sourceBodySha256, sha256(body));
});

test("acceptance mapping verifies exact criterion-to-captured-body identity without rewriting input", () => {
  const body = "## Acceptance Criteria\n- [ ] A real criterion.\n<!-- FORGE:BODY-INTEGRITY:fixture -->\n";
  const mapping = mapIssueAcceptance(77, body, ["src/file.ts"]);
  const issue = { number: 77, body, acceptance: mapping.criteria.map((criterion) => criterion.text), acceptanceMapping: mapping, mutationFiles: ["src/file.ts"] };
  const before = JSON.stringify(issue);
  assert.deepEqual(validateIssueAcceptanceMapping(issue), mapping);
  assert.equal(JSON.stringify(issue), before);

  assert.throws(() => validateIssueAcceptanceMapping({
    ...issue,
    body: `${body}\nchanged source`,
  }), /does not match the captured source body/);
  assert.throws(() => validateIssueAcceptanceMapping({
    ...issue,
    acceptance: ["generic replacement"],
  }), /acceptance text does not match its source mapping/);
});

test("ordinary HTML comments and unrelated FORGE-like prose remain acceptance content", () => {
  const body = [
    "## Acceptance Criteria",
    "- [ ] Preserve <!-- comment example --> as literal output.",
    "- [ ] Preserve the text `FORGE:OTHER:EXAMPLE` and <span>markup</span>.",
  ].join("\n");
  const mapping = mapIssueAcceptance(88, body);
  assert.equal(mapping.criteria[0]?.text, "Preserve <!-- comment example --> as literal output.");
  assert.equal(mapping.criteria[1]?.text, "Preserve the text `FORGE:OTHER:EXAMPLE` and <span>markup</span>.");
});
