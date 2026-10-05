import { createHash } from "node:crypto";

const GENERATED_METADATA = [
  /^\s*<!--\s*FORGE:BODY-INTEGRITY:[^>]*-->\s*$/i,
  /^\s*<!--\s*FORGE:BATCHABLE\s*-->\s*$/i,
  /^\s*<!--\s*issue-create-token:[^>]*-->\s*$/i,
];
const INLINE_GENERATED_METADATA = /\s*<!--\s*(?:FORGE:BODY-INTEGRITY:[^>]*|FORGE:BATCHABLE|issue-create-token:[^>]*)-->\s*$/i;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function normalizedLines(body) {
  return body.replace(/\r\n?/g, "\n").split("\n");
}

function isHeading(line) {
  return /^\s*#{2,6}\s+\S/.test(line);
}

export function sectionLines(body, heading) {
  const lines = normalizedLines(body);
  const headingPattern = new RegExp(`^\\s*#{2,6}\\s+${heading}\\s*:?[ \\t]*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start < 0) return [];
  let end = start + 1;
  while (end < lines.length && !isHeading(lines[end])) end += 1;
  return lines.slice(start + 1, end);
}

function isGeneratedMetadata(line) {
  return GENERATED_METADATA.some((pattern) => pattern.test(line));
}

function stripTrailingGeneratedMetadata(lines) {
  const retained = [...lines];
  while (retained.length > 0) {
    const last = retained[retained.length - 1];
    if (!last?.trim() || isGeneratedMetadata(last)) retained.pop();
    else break;
  }
  let text = retained.join("\n");
  for (;;) {
    const match = text.match(INLINE_GENERATED_METADATA);
    if (!match || match.index === undefined) break;
    text = text.slice(0, match.index).replace(/[ \t]+$/, "");
  }
  return text.replace(/[ \t\n]+$/, "");
}

function sourceItems(body) {
  const lines = sectionLines(body, "Acceptance Criteria");
  if (lines.length === 0) return [];
  const result = [];
  let current = [];
  let currentIndent = 0;
  const flush = () => {
    const text = stripTrailingGeneratedMetadata(current);
    if (text.trim()) result.push(text);
    current = [];
  };
  for (const line of lines) {
    const item = line.match(/^(\s*)(?:[-*+] |\d+[.)]\s+)(?:\[([ xX])\]\s*)?(.*?)[ \t]*$/);
    if (item && item[3]?.trim()) {
      const indent = item[1].length;
      if (current.length === 0 || indent <= currentIndent) {
        flush();
        currentIndent = indent;
        current.push(item[3]);
      } else {
        current.push(line.trimEnd());
      }
    } else if (current.length > 0) {
      current.push(line.trimEnd());
    } else if (line.trim()) {
      // Preserve legacy unstructured text in the section; it remains issue data,
      // never a reason to invent a generic or empty acceptance item.
      current.push(line.trim());
      currentIndent = 0;
    }
  }
  flush();
  return result;
}

/** Exact source-bound acceptance map; only recognized generated Forge suffix markers are omitted. */
export function mapIssueAcceptance(issueNumber, body, affectedBoundaries = []) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("Acceptance issue number is invalid");
  if (typeof body !== "string") throw new Error("Issue body must be a string");
  if (!Array.isArray(affectedBoundaries) || affectedBoundaries.some((value) => typeof value !== "string")) throw new Error("Acceptance affected boundaries must be a string array");
  const sourceBodySha256 = `sha256:${sha256(Buffer.from(body, "utf8"))}`;
  const boundaries = [...new Set(affectedBoundaries.map((value) => value.trim()).filter(Boolean))];
  const duplicateOrdinals = new Map();
  const criteria = sourceItems(body).map((sourceText, index) => {
    const annotation = sourceText.match(/\s+\[type:(api|unit|e2e|manual)\]\s*$/i);
    const text = annotation ? sourceText.slice(0, annotation.index).replace(/[ \t\n]+$/, "") : sourceText;
    const proofType = annotation ? annotation[1].toLowerCase() : "behavioral";
    const textHash = `sha256:${sha256(Buffer.from(text, "utf8"))}`;
    const baseId = `I${issueNumber}-AC-${textHash.slice(7, 19)}`;
    const duplicateOrdinal = duplicateOrdinals.get(baseId) ?? 0;
    duplicateOrdinals.set(baseId, duplicateOrdinal + 1);
    return {
      id: duplicateOrdinal === 0 ? baseId : `${baseId}-${duplicateOrdinal + 1}`,
      sourceOrdinal: index + 1,
      text,
      textHash,
      proofType,
      affectedBoundaries: boundaries,
    };
  });
  return { schema: "forgedock.candidate-acceptance-map/v1", issue: issueNumber, sourceBodySha256, criteria };
}

export function validateIssueAcceptanceMapping(issue) {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) throw new Error("Issue acceptance input is invalid");
  const expected = mapIssueAcceptance(issue.number, issue.body ?? "", issue.mutationFiles ?? []);
  if (JSON.stringify(issue.acceptanceMapping) !== JSON.stringify(expected)) throw new Error(`Issue #${issue.number} acceptance mapping does not match the captured source body`);
  if (JSON.stringify(issue.acceptance) !== JSON.stringify(expected.criteria.map((criterion) => criterion.text))) throw new Error(`Issue #${issue.number} acceptance text does not match its source mapping`);
  return expected;
}
