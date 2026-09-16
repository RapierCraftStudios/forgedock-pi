import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type CandidateRecordKind =
  | "INVESTIGATION"
  | "PLAN"
  | "BUILD"
  | "REVIEW"
  | "DECISION"
  | "CLOSURE";

export interface CandidateRecordIdentity {
  kind: CandidateRecordKind;
  repository: string;
  issue?: number;
  pullRequest?: number;
  head?: string;
  base?: string;
}

export interface CandidateRecord {
  identity: CandidateRecordIdentity;
  marker: string;
  markdown: string;
  contentSha256: string;
}

const FULL_SHA = /^[a-f0-9]{40,64}$/;
const RECORD_KIND = /^[A-Z]+$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function renderCandidateRecord(identity: CandidateRecordIdentity, body: string): CandidateRecord {
  if (!RECORD_KIND.test(identity.kind)) throw new Error("Record kind is invalid");
  if (!/^[-A-Za-z0-9_.]+\/[A-Za-z0-9_.-]+$/.test(identity.repository)) throw new Error("Record repository is invalid");
  if (identity.issue !== undefined && (!Number.isSafeInteger(identity.issue) || identity.issue < 1)) throw new Error("Record issue is invalid");
  if (identity.pullRequest !== undefined && (!Number.isSafeInteger(identity.pullRequest) || identity.pullRequest < 1)) throw new Error("Record pull request is invalid");
  if (identity.head !== undefined && !FULL_SHA.test(identity.head)) throw new Error("Record head is invalid");
  if (identity.base !== undefined && !FULL_SHA.test(identity.base)) throw new Error("Record base is invalid");
  if (typeof body !== "string" || body.trim().length < 8) throw new Error("Record body must contain substantive evidence");
  if (/^<!-- FORGE:/m.test(body)) throw new Error("Record markers are generated; do not include one in the body");

  const marker = `<!-- FORGE:CANDIDATE:${identity.kind} ${json(identity)} -->`;
  const markdown = `${marker}\n## ForgeDock ${identity.kind.toLowerCase()}\n\n${body.trim()}\n`;
  return { identity, marker, markdown, contentSha256: sha256(markdown) };
}

export function writeCandidateRecord(record: CandidateRecord, outputPath: string): string {
  const output = resolve(outputPath);
  mkdirSync(dirname(output), { recursive: true });
  try {
    writeFileSync(output, record.markdown, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const existing = readFileSync(output, "utf8");
    if (existing !== record.markdown) throw error;
  }
  return output;
}
