import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OBSERVATION = Type.Object({
  id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*:F[1-9][0-9]*$" }),
  kind: Type.String({ pattern: "^(?:code-defect|improvement|verification-authority-prerequisite)$" }),
  summary: Type.String({ minLength: 1 }),
  affectedBehavior: Type.String({ minLength: 1 }),
  location: Type.Optional(Type.String({ minLength: 1 })),
  evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  trigger: Type.String({ minLength: 1 }),
  consequence: Type.String({ minLength: 1 }),
  whyThisChange: Type.String({ minLength: 1 }),
  stage: Type.String({ minLength: 1 }),
  proposedDisposition: Type.String({ pattern: "^(?:IMMEDIATE REPAIR|NON-BLOCKING FOLLOW-UP|REJECTED/NOT APPLICABLE|EVIDENCE/AUTHORITY PREREQUISITE)$" }),
});

const BODY = Type.Object({
  repository: Type.String(),
  pullRequest: Type.Integer({ minimum: 1 }),
  head: Type.String(),
  baseRef: Type.String(),
  baseSha: Type.String(),
  role: Type.String(),
  body: Type.String({ description: "Four substantive review sections without an identity marker" }),
  bodyPath: Type.String(),
  reportPath: Type.String(),
  reviewRoot: Type.String(),
  authorizationPath: Type.String(),
  artifactKey: Type.String(),
  publish: Type.Boolean(),
  observations: Type.Optional(Type.Array(OBSERVATION)),
});

type ReviewerPublication = {
  repository: string;
  pullRequest: number;
  head: string;
  baseRef: string;
  baseSha: string;
  role: string;
  body: string;
  bodyPath: string;
  reportPath: string;
  reviewRoot: string;
  authorizationPath: string;
  artifactKey: string;
  publish: boolean;
  observations?: readonly Observation[];
};

type Observation = {
  id: string;
  kind: string;
  summary: string;
  affectedBehavior: string;
  location?: string;
  evidence: readonly string[];
  trigger: string;
  consequence: string;
  whyThisChange: string;
  stage: string;
  proposedDisposition: string;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validatePath(value: string, label: string): string {
  const path = resolve(value);
  if (path.includes("\0")) throw new Error(`${label} contains NUL`);
  return path;
}

function assertUnderRoot(root: string, path: string, label: string): void {
  const canonicalRoot = realpathSync(root);
  const distance = relative(canonicalRoot, path);
  if (!distance || distance === ".." || distance.startsWith("../") || resolve(canonicalRoot, distance) !== path) {
    throw new Error(`${label} must remain under the prepared review artifact root`);
  }
  const parent = dirname(path);
  if (!existsSync(parent) || realpathSync(parent) !== parent) {
    throw new Error(`${label} has a symlinked or missing parent`);
  }
  if (existsSync(path) && realpathSync(path) !== path) {
    throw new Error(`${label} is a symlink`);
  }
}

function validateObservations(role: string, values: readonly Observation[] | undefined): Observation[] {
  const observations = [...(values ?? [])];
  const seen = new Set<string>();
  for (const observation of observations) {
    if (!observation.id.startsWith(`${role}:F`) || seen.has(observation.id)) throw new Error("Reviewer observations must have unique role-scoped IDs");
    seen.add(observation.id);
    if (!/^(?:code-defect|improvement|verification-authority-prerequisite)$/.test(observation.kind)) throw new Error(`Unsupported reviewer observation kind: ${observation.kind}`);
    if (!/^(?:IMMEDIATE REPAIR|NON-BLOCKING FOLLOW-UP|REJECTED\/NOT APPLICABLE|EVIDENCE\/AUTHORITY PREREQUISITE)$/.test(observation.proposedDisposition)) throw new Error(`Unsupported reviewer observation disposition: ${observation.proposedDisposition}`);
    if (!observation.summary.trim() || !observation.affectedBehavior.trim() || !observation.trigger.trim() || !observation.consequence.trim() || !observation.whyThisChange.trim() || !observation.stage.trim() || observation.evidence.length === 0) throw new Error(`Reviewer observation ${observation.id} is incomplete`);
  }
  return observations;
}

/** Child-only publication capability: it cannot edit source or invoke arbitrary shell. */
export default function registerReviewerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "forge_publish_reviewer",
    label: "Publish reviewer report",
    description: "Save and optionally publish this exact frozen-head review report; no source mutation is available.",
    parameters: BODY,
    async execute(_toolCallId, params, _signal) {
      const input = params as ReviewerPublication;
      if (input.body.trim().length < 32 || /^<!-- FORGE:/m.test(input.body)) {
        throw new Error("Reviewer body must contain substantive sections without a generated marker");
      }
      const observations = validateObservations(input.role, input.observations);
      const bodyPath = validatePath(input.bodyPath, "Reviewer body path");
      const reportPath = validatePath(input.reportPath, "Reviewer report path");
      const reviewRoot = validatePath(input.reviewRoot, "Reviewer artifact root");
      assertUnderRoot(reviewRoot, bodyPath, "Reviewer body path");
      assertUnderRoot(reviewRoot, reportPath, "Reviewer report path");
      if (bodyPath === reportPath) throw new Error("Reviewer body and report paths must differ");
      const authorizationPath = validatePath(input.authorizationPath, "Reviewer role authorization path");
      assertUnderRoot(reviewRoot, authorizationPath, "Reviewer role authorization path");
      const commonPath = resolve(reviewRoot, "review.json");
      assertUnderRoot(reviewRoot, commonPath, "Reviewer authorization path");
      const workflowPath = resolve(reviewRoot, "workflow.js");
      assertUnderRoot(reviewRoot, workflowPath, "Reviewer workflow path");
      let common: { schema?: unknown; artifactRoot?: unknown; artifactKey?: unknown; repository?: unknown; pullRequest?: unknown; head?: unknown; baseRef?: unknown; baseSha?: unknown; publish?: unknown; workflowPath?: unknown; workflowSha256?: unknown };
      let authorization: { schema?: unknown; artifactRoot?: unknown; artifactKey?: unknown; role?: unknown; repository?: unknown; pullRequest?: unknown; head?: unknown; baseRef?: unknown; baseSha?: unknown; publish?: unknown };
      try {
        common = JSON.parse(await readFile(commonPath, "utf8")) as typeof common;
        authorization = JSON.parse(await readFile(authorizationPath, "utf8")) as typeof authorization;
      } catch {
        throw new Error("Reviewer artifact root is missing its prepared authorization");
      }
      if (common.schema !== "forgedock.candidate-review/v1" || common.artifactRoot !== reviewRoot || common.workflowPath !== workflowPath || common.workflowSha256 !== digest(await readFile(workflowPath, "utf8")) || common.repository !== input.repository || common.pullRequest !== input.pullRequest || common.head !== input.head || common.baseRef !== input.baseRef || common.baseSha !== input.baseSha || common.publish !== input.publish || authorization.schema !== "forgedock.candidate-review-role/v1" || authorization.artifactRoot !== reviewRoot || authorization.artifactKey !== input.artifactKey || authorization.role !== input.role || authorization.repository !== input.repository || authorization.pullRequest !== input.pullRequest || authorization.head !== input.head || authorization.baseRef !== input.baseRef || authorization.baseSha !== input.baseSha || authorization.publish !== input.publish) {
        throw new Error("Reviewer publication authorization does not match the prepared frozen role");
      }
      await writeFile(bodyPath, `${input.body.trim()}\n`, { flag: "wx", mode: 0o600 }).catch(async (error) => {
        const existing = await readFile(bodyPath, "utf8");
        if (existing !== `${input.body.trim()}\n`) throw error;
      });
      const observationsPath = resolve(reviewRoot, `${input.role}.observations.json`);
      assertUnderRoot(reviewRoot, observationsPath, "Reviewer observations path");
      const observationsJson = `${JSON.stringify(observations, null, 2)}\n`;
      await writeFile(observationsPath, observationsJson, { flag: "wx", mode: 0o600 }).catch(async (error) => {
        const existing = await readFile(observationsPath, "utf8");
        if (existing !== observationsJson) throw error;
      });
      const helper = process.env.FORGEDOCK_CANDIDATE_BIN ?? resolve(dirname(fileURLToPath(import.meta.url)), "../bin/forgedock-candidate.mjs");
      const args = [
        helper,
        "record",
        "reviewer",
        "--repo",
        input.repository,
        "--pr",
        String(input.pullRequest),
        "--head",
        input.head,
        "--base-ref",
        input.baseRef,
        "--base-sha",
        input.baseSha,
        "--role",
        input.role,
        "--report-id",
        input.artifactKey,
        "--body-file",
        bodyPath,
        "--report-file",
        reportPath,
        "--observations-file",
        observationsPath,
      ];
      if (input.publish) args.push("--publish");
      const result = await pi.exec("node", args, { timeout: 120_000 });
      if (result.code !== 0) throw new Error(`Reviewer publication helper failed: ${result.stderr.trim().slice(-500)}`);
      return {
        content: [{ type: "text", text: result.stdout.trim() }],
        details: { bodyPath, reportPath, publication: input.publish ? "published" : "saved" },
      };
    },
  });
}
