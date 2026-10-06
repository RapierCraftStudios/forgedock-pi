import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
  observations: Type.Array(OBSERVATION),
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
  observations: readonly Observation[];
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

async function saveRecoveryInput(path: string, input: Record<string, unknown>): Promise<void> {
  const content = `${JSON.stringify(input, null, 2)}\n`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, path);
    } catch (error) {
      let existing: Record<string, unknown>;
      try { existing = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
      catch { throw error; }
      if (existing.schema !== input.schema || existing.nativeRunId !== input.nativeRunId || existing.bodySha256 !== input.bodySha256 || existing.observationsSha256 !== input.observationsSha256) {
        throw new Error("A different reviewer publication recovery input already exists for this role");
      }
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function updateRecoveryInput(path: string, input: Record<string, unknown>): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(input, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
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
      if (input.observations === undefined) throw new Error("Reviewer observations array is required; use [] for a clean report");
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
      const expectedBodyPath = resolve(reviewRoot, `${input.role}.body.md`);
      const expectedReportPath = resolve(reviewRoot, `${input.role}.report.md`);
      const expectedAuthorizationPath = resolve(reviewRoot, `${input.role}.authorization.json`);
      const observationsPath = resolve(reviewRoot, `${input.role}.observations.json`);
      const recoveryPath = resolve(reviewRoot, `${input.role}.publication-recovery.json`);
      if (bodyPath !== expectedBodyPath || reportPath !== expectedReportPath || authorizationPath !== expectedAuthorizationPath) {
        throw new Error("Reviewer publication paths must match the prepared role's exact report destinations");
      }
      assertUnderRoot(reviewRoot, observationsPath, "Reviewer observations path");
      assertUnderRoot(reviewRoot, recoveryPath, "Reviewer recovery input path");
      let common: { schema?: unknown; artifactRoot?: unknown; artifactKey?: unknown; repository?: unknown; pullRequest?: unknown; head?: unknown; baseRef?: unknown; baseSha?: unknown; publish?: unknown; workflowPath?: unknown; workflowSha256?: unknown; roles?: unknown; roleArtifactKeys?: unknown };
      let authorization: { schema?: unknown; artifactRoot?: unknown; artifactKey?: unknown; role?: unknown; repository?: unknown; pullRequest?: unknown; head?: unknown; baseRef?: unknown; baseSha?: unknown; publish?: unknown };
      try {
        common = JSON.parse(await readFile(commonPath, "utf8")) as typeof common;
        authorization = JSON.parse(await readFile(authorizationPath, "utf8")) as typeof authorization;
      } catch {
        throw new Error("Reviewer artifact root is missing its prepared authorization");
      }
      const commonMatches = common.schema === "forgedock.candidate-review/v1" && common.artifactRoot === reviewRoot && common.workflowPath === workflowPath && common.workflowSha256 === digest(await readFile(workflowPath, "utf8")) && common.repository === input.repository && common.pullRequest === input.pullRequest && common.head === input.head && common.baseRef === input.baseRef && common.baseSha === input.baseSha && common.publish === input.publish;
      const roleMatches = authorization.schema === "forgedock.candidate-review-role/v1" && authorization.artifactRoot === reviewRoot && authorization.role === input.role && authorization.repository === input.repository && authorization.pullRequest === input.pullRequest && authorization.head === input.head && authorization.baseRef === input.baseRef && authorization.baseSha === input.baseSha && authorization.publish === input.publish && Array.isArray(common.roles) && common.roles.includes(input.role) && Boolean(common.roleArtifactKeys && typeof common.roleArtifactKeys === "object" && (common.roleArtifactKeys as Record<string, unknown>)[input.role] === authorization.artifactKey);
      if (!commonMatches || !roleMatches) throw new Error("Reviewer publication authorization does not match the prepared frozen role");
      const nativeRunId = process.env.PI_SUBAGENT_RUN_ID;
      if (typeof nativeRunId !== "string" || !nativeRunId.trim()) throw new Error("Reviewer publication requires its native run identity; no report was written");
      const body = input.body.trim();
      const bodyBytes = `${body}\n`;
      const observationsJson = `${JSON.stringify(observations, null, 2)}\n`;
      const recoveryInput: Record<string, unknown> = {
        schema: "forgedock.candidate-review-publication-recovery/v1",
        state: "publication-attempted",
        recoveryAttempts: 0,
        nativeRunId,
        reviewArtifactKey: common.artifactKey,
        roleArtifactKey: authorization.artifactKey,
        suppliedArtifactKey: input.artifactKey,
        repository: input.repository,
        pullRequest: input.pullRequest,
        head: input.head,
        baseRef: input.baseRef,
        baseSha: input.baseSha,
        role: input.role,
        publish: input.publish,
        bodyPath,
        reportPath,
        observationsPath,
        body,
        observations,
        bodySha256: digest(bodyBytes),
        observationsSha256: digest(observationsJson),
      };
      if (input.artifactKey !== authorization.artifactKey) {
        if (input.artifactKey !== common.artifactKey) throw new Error("Reviewer publication authorization does not match the prepared frozen role");
        recoveryInput.state = "recovery-available";
        recoveryInput.error = "The common review artifact key was supplied where this role's authorization key was required; no publisher transport or report-file write was attempted.";
        await saveRecoveryInput(recoveryPath, recoveryInput);
        throw new Error(`Reviewer publication used the common review key instead of the prepared ${input.role} role key. No report was written or published. Authored input is retained at ${recoveryPath} for one exact-run, role-only parent recovery.`);
      }
      await saveRecoveryInput(recoveryPath, recoveryInput);
      try {
        await writeFile(bodyPath, bodyBytes, { flag: "wx", mode: 0o600 }).catch(async (error) => {
          const existing = await readFile(bodyPath, "utf8");
          if (existing !== bodyBytes) throw error;
        });
        await writeFile(observationsPath, observationsJson, { flag: "wx", mode: 0o600 }).catch(async (error) => {
          const existing = await readFile(observationsPath, "utf8");
          if (existing !== observationsJson) throw error;
        });
        const helper = process.env.FORGEDOCK_CANDIDATE_BIN ?? resolve(dirname(fileURLToPath(import.meta.url)), "../bin/forgedock-candidate.mjs");
        const args = [helper, "record", "reviewer", "--repo", input.repository, "--pr", String(input.pullRequest), "--head", input.head, "--base-ref", input.baseRef, "--base-sha", input.baseSha, "--role", input.role, "--report-id", String(authorization.artifactKey), "--body-file", bodyPath, "--report-file", reportPath, "--observations-file", observationsPath];
        if (input.publish) args.push("--publish");
        const result = await pi.exec("node", args, { timeout: 120_000 });
        if (result.code !== 0) throw new Error(result.stderr.trim().slice(-500) || `helper exited ${result.code}`);
        const receipt = { ...recoveryInput, state: input.publish ? "published" : "saved", publication: input.publish ? "published" : "saved", publicationResult: result.stdout.trim() };
        await updateRecoveryInput(recoveryPath, receipt);
        return {
          content: [{ type: "text", text: result.stdout.trim() }],
          details: { bodyPath, reportPath, recoveryPath, nativeRunId, reportId: authorization.artifactKey, publication: input.publish ? "published" : "saved" },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await updateRecoveryInput(recoveryPath, { ...recoveryInput, state: "recovery-available", error: message });
        throw new Error(`Reviewer publication failed after analysis. The exact authored input is retained at ${recoveryPath}; the report must be read back or recovered before adjudication. ${message}`);
      }
    },
  });
}
