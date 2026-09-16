import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
  artifactKey: Type.String(),
  publish: Type.Boolean(),
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
  artifactKey: string;
  publish: boolean;
};

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
      const bodyPath = validatePath(input.bodyPath, "Reviewer body path");
      const reportPath = validatePath(input.reportPath, "Reviewer report path");
      const reviewRoot = validatePath(input.reviewRoot, "Reviewer artifact root");
      assertUnderRoot(reviewRoot, bodyPath, "Reviewer body path");
      assertUnderRoot(reviewRoot, reportPath, "Reviewer report path");
      if (bodyPath === reportPath) throw new Error("Reviewer body and report paths must differ");
      let authorization: { schema?: unknown; artifactRoot?: unknown; artifactKey?: unknown; repository?: unknown; pullRequest?: unknown; head?: unknown; baseRef?: unknown; baseSha?: unknown; roles?: unknown; publish?: unknown };
      const authorizationPath = resolve(reviewRoot, "review.json");
      assertUnderRoot(reviewRoot, authorizationPath, "Reviewer authorization path");
      try {
        authorization = JSON.parse(await readFile(authorizationPath, "utf8")) as typeof authorization;
      } catch {
        throw new Error("Reviewer artifact root is missing its prepared authorization");
      }
      if (authorization.schema !== "forgedock.candidate-review/v1" || authorization.artifactRoot !== reviewRoot || authorization.artifactKey !== input.artifactKey || authorization.repository !== input.repository || authorization.pullRequest !== input.pullRequest || authorization.head !== input.head || authorization.baseRef !== input.baseRef || authorization.baseSha !== input.baseSha || authorization.publish !== input.publish || !Array.isArray(authorization.roles) || !authorization.roles.includes(input.role)) {
        throw new Error("Reviewer publication authorization does not match the prepared frozen review");
      }
      await writeFile(bodyPath, `${input.body.trim()}\n`, { flag: "wx", mode: 0o600 }).catch(async (error) => {
        const existing = await readFile(bodyPath, "utf8");
        if (existing !== `${input.body.trim()}\n`) throw error;
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
        "--body-file",
        bodyPath,
        "--report-file",
        reportPath,
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
