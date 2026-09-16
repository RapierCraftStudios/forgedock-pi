#!/usr/bin/env node
// Render/post an explicitly requested record; no workflow or finding decisions.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createReviewerReportIdentity,
  loadPolicy,
  assertRepo,
  gitHead,
  REVIEWER_PUBLICATION_SCHEMA,
  validateReviewerPublicationAuthorization,
} from "./dispatch.mjs";
import { validateControlPlaneDescriptor } from "./control-plane.mjs";

const titles = { INVESTIGATOR: "Investigation", CLASSIFICATION: "Classification", CONTEXT: "Implementation Context", CONTRACT: "Build Contract", ARCHITECT: "Implementation Plan", BUILDER: "Build Complete", "REVIEW-PANEL": "Review Panel", REMEDIATION: "Remediation Complete", DECOMPOSED: "Decomposition Complete", GATED: "Work-On Gated", TRAJECTORY: "Work-On Outcome" };
const REVIEWER_SECTIONS = ["Scope and decisions considered", "Evidence and findings", "Verification limitations", "Recommendation"];
function check(ok, message) { if (!ok) throw new Error(message); }
const sha256 = value => createHash("sha256").update(value).digest("hex");
const link = value => {
  if (typeof value !== "string" || /[\s<>]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search; } catch { return false; }
};
const defaultGh = (args, options = {}) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 500); }
function callGh(gh, args, timeoutMs) { return gh(args, { timeout: timeoutMs }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function assertInstalledRecordHelper(policy) {
  const expected = policy.controlPlane?.forgeDock?.files?.find(file => file.id === "record")?.path;
  if (!expected || fs.realpathSync(fileURLToPath(import.meta.url)) !== expected) throw new Error(`Untrusted record helper; invoke the parent-installed helper at ${expected ?? "unknown"}`);
}
function assertInstalledDirectHelper(controlPlane) {
  check(controlPlane, "Direct publication requires a parent control-plane binding");
  validateControlPlaneDescriptor(controlPlane);
  const expected = controlPlane.forgeDock?.files?.find(file => file.id === "record")?.path;
  check(expected && fs.realpathSync(fileURLToPath(import.meta.url)) === expected, `Untrusted record helper; invoke the parent-installed helper at ${expected ?? "unknown"}`);
}
function reviewerIdentityFromAuthorization(authorization) {
  return createReviewerReportIdentity({
    repository: authorization.repository,
    pullRequest: authorization.pullRequest,
    reviewedHead: authorization.reviewedHead,
    baseRef: authorization.baseRef,
    baseSha: authorization.baseSha,
    role: authorization.role,
    round: authorization.round,
  });
}
function reviewerMarker(authorization) {
  const identity = reviewerIdentityFromAuthorization(authorization);
  return `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify(identity)} -->`;
}
function reviewerBodyIsComplete(body) {
  const lines = body.trim().split(/\r?\n/);
  for (const section of REVIEWER_SECTIONS) {
    const start = lines.findIndex(line => line.trim() === `### ${section}`);
    check(start >= 0, `Reviewer report must contain the '${section}' section`);
    const end = lines.findIndex((line, index) => index > start && /^###\s+/.test(line.trim()));
    const content = lines.slice(start + 1, end < 0 ? lines.length : end).join("\n").trim();
    check(content.length >= 8, `Reviewer report section '${section}' is empty or too short`);
  }
}
function reviewerBody(draft) {
  check(typeof draft === "string" && draft.trim(), "Reviewer report needs substantive Markdown sections");
  check(!/^<!-- FORGE:|^\*\*(?:Reviewer role|Pull request|Reviewed source|Review base|Review round|Report identity)\*\*:/m.test(draft), "Reviewer report identity headers are generated; supply content sections only");
  reviewerBodyIsComplete(draft);
  return draft.trim();
}

/** Render a complete report without loading issue-owner or replan policy. */
export function renderReviewerReport(draft, body) {
  const authorization = validateReviewerPublicationAuthorization(draft);
  assertInstalledDirectHelper(authorization.controlPlane);
  const content = reviewerBody(body);
  const marker = reviewerMarker(authorization);
  const pullUrl = `https://github.com/${authorization.repository}/pull/${authorization.pullRequest}`;
  const markdown = `${marker}\n## Individual Reviewer Report\n\n**Reviewer role**: \`${authorization.role}\`\n**Pull request**: [#${authorization.pullRequest}](${pullUrl})\n**Reviewed source**: \`${authorization.reviewedHead}\`\n**Review base**: \`${authorization.baseRef}\` at \`${authorization.baseSha}\`\n**Review round**: ${authorization.round}\n**Report identity**: \`${authorization.id}\`\n\n${content}\n`;
  return { authorization, repo: authorization.repository, target: authorization.pullRequest, head: authorization.reviewedHead, baseRef: authorization.baseRef, baseSha: authorization.baseSha, marker, markdown };
}

export function writeReviewerReport(record, outputFile = record.authorization.reportPath) {
  const output = path.resolve(outputFile);
  check(output === record.authorization.reportPath, "Reviewer report path disagrees with its authorization");
  if (fs.existsSync(output)) check(fs.readFileSync(output, "utf8") === record.markdown, "Saved reviewer report differs from the completed report; use the original saved bytes");
  else fs.writeFileSync(output, record.markdown, { flag: "wx", mode: 0o600 });
  return { ...record, outputFile: output };
}
function parseReviewerMarker(body) {
  if (typeof body !== "string") return undefined;
  const first = body.split(/\r?\n/, 1)[0];
  const match = first.match(/^<!-- FORGE:REVIEWER_REPORT (\{.*\}) -->$/);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}
function reviewerCommentMatches(comment, authorization) {
  const marker = parseReviewerMarker(comment?.body);
  if (!marker || marker.v !== 1 || marker.id !== authorization.id) return false;
  const expected = reviewerIdentityFromAuthorization(authorization);
  return ["repository", "pullRequest", "reviewedHead", "baseRef", "baseSha", "role", "round"].every(key => marker[key] === expected[key]);
}
function reportLink(comment, authorization) {
  check(Number.isSafeInteger(comment?.id) && comment.id > 0, "Published reviewer comment is missing its server identity");
  check(link(comment?.html_url), "Published reviewer comment is missing a safe permalink");
  const url = new URL(comment.html_url);
  check(url.pathname.toLowerCase() === `/${authorization.repository}/pull/${authorization.pullRequest}`.toLowerCase() && url.hash === `#issuecomment-${comment.id}`, "Published reviewer link disagrees with destination identity");
  check(typeof comment.body === "string" && comment.body.trim(), "Published reviewer comment has no body");
  reviewerBodyIsComplete(comment.body);
}
function commentPages(raw) {
  const pages = JSON.parse(raw);
  check(Array.isArray(pages), "Unexpected GitHub comment response");
  return pages.flatMap(page => Array.isArray(page) ? page : []);
}
function reviewerMatches(comments, authorization) {
  return comments.filter(comment => reviewerCommentMatches(comment, authorization));
}
function currentPullRequest(authorization, gh) {
  const pull = JSON.parse(callGh(gh, ["pr", "view", String(authorization.pullRequest), "-R", authorization.repository, "--json", "headRefOid,baseRefName,baseRefOid"], authorization.publicationTimeoutMs));
  check(pull.headRefOid === authorization.reviewedHead && pull.baseRefName === authorization.baseRef && pull.baseRefOid === authorization.baseSha, "PR head/base disagrees with bound reviewer identity");
}
function listReviewerComments(authorization, gh) {
  const endpoint = `repos/${authorization.repository}/issues/${authorization.pullRequest}/comments`;
  return commentPages(callGh(gh, ["api", "--paginate", "--slurp", endpoint], authorization.publicationTimeoutMs));
}
function readReviewerComment(authorization, commentId, gh) {
  return JSON.parse(callGh(gh, ["api", `repos/${authorization.repository}/issues/comments/${commentId}`], authorization.publicationTimeoutMs));
}
function publicationReceipt(record, stored, reused, reconciliation) {
  const { authorization } = record;
  check(reviewerCommentMatches(stored, authorization), "Published reviewer comment identity readback mismatch");
  reportLink(stored, authorization);
  return {
    schema: REVIEWER_PUBLICATION_SCHEMA,
    reportId: authorization.id,
    repo: authorization.repository,
    pr: authorization.pullRequest,
    role: authorization.role,
    round: authorization.round,
    reviewedHead: authorization.reviewedHead,
    baseRef: authorization.baseRef,
    baseSha: authorization.baseSha,
    commentId: stored.id,
    url: stored.html_url,
    reportPath: record.outputFile ?? authorization.reportPath,
    contentSha256: sha256(record.markdown),
    serverContentSha256: sha256(stored.body ?? ""),
    contentMatches: stored.body === record.markdown,
    reused,
    reconciliation,
  };
}

/** Publish a saved report with bounded readback/reconciliation on ambiguous create. */
export function publishReviewerReport(record, outputFile, gh = defaultGh) {
  const authorization = validateReviewerPublicationAuthorization(record.authorization);
  assertInstalledDirectHelper(authorization.controlPlane);
  const output = path.resolve(outputFile);
  check(output === authorization.reportPath && fs.readFileSync(output, "utf8") === record.markdown, "Publication file does not match the saved reviewer report");
  currentPullRequest(authorization, gh);
  let comments = listReviewerComments(authorization, gh);
  let existing = reviewerMatches(comments, authorization);
  check(existing.length <= 1, "Duplicate reviewer report identity already exists; reconcile explicitly");
  if (existing.length === 1) return publicationReceipt({ ...record, authorization, outputFile: output }, readReviewerComment(authorization, existing[0].id, gh), true, "existing-identity");

  const endpoint = `repos/${authorization.repository}/issues/${authorization.pullRequest}/comments`;
  let created;
  try {
    created = JSON.parse(callGh(gh, ["api", endpoint, "-F", `body=@${output}`], authorization.publicationTimeoutMs));
  } catch (error) {
    // A successful GitHub create followed by a lost response is an ambiguous delivery.
    // Read back the stable marker before considering a transport retry.
    try {
      comments = listReviewerComments(authorization, gh);
      existing = reviewerMatches(comments, authorization);
      check(existing.length <= 1, "Ambiguous reviewer publication found duplicate identities; reconcile explicitly");
      if (existing.length === 1) return publicationReceipt({ ...record, authorization, outputFile: output }, readReviewerComment(authorization, existing[0].id, gh), true, "ambiguous-create-reconciled");
    } catch (reconciliationError) {
      throw new Error(`Reviewer publication create failed and reconciliation failed: ${safeError(error)}; ${safeError(reconciliationError)}`);
    }
    throw new Error(`Reviewer publication create failed: ${safeError(error)}`);
  }
  if (!Number.isSafeInteger(created?.id) || created.id <= 0) {
    comments = listReviewerComments(authorization, gh);
    existing = reviewerMatches(comments, authorization);
    check(existing.length <= 1, "Invalid create response found duplicate reviewer identities; reconcile explicitly");
    if (existing.length === 1) return publicationReceipt({ ...record, authorization, outputFile: output }, readReviewerComment(authorization, existing[0].id, gh), true, "invalid-create-response-reconciled");
    throw new Error("Reviewer publication create returned no server comment identity");
  }
  return publicationReceipt({ ...record, authorization, outputFile: output }, readReviewerComment(authorization, created.id, gh), false, "created");
}

function reviewerReportReferences(value, head, round, repo, pr) {
  check(Array.isArray(value) && value.length > 0, "Review record requires every individual reviewer report reference");
  const roles = new Set();
  const ids = new Set();
  return value.map((report, index) => {
    check(report && typeof report === "object" && !Array.isArray(report), `Reviewer report reference ${index} is invalid`);
    const allowed = ["role", "url", "id", "head", "round", "reportId"];
    check(Object.keys(report).every(key => allowed.includes(key)), `Unknown reviewer report reference field: ${Object.keys(report).find(key => !allowed.includes(key))}`);
    check(typeof report.role === "string" && /^[a-z][a-z0-9-]*$/.test(report.role) && !roles.has(report.role), `Reviewer report reference ${index} has a duplicate or invalid role`);
    check(link(report.url), `Reviewer report reference ${index} needs a safe URL`);
    const url = new URL(report.url);
    check(url.pathname.toLowerCase() === `/${repo}/pull/${pr}`.toLowerCase() && url.hash === `#issuecomment-${report.id}`, `Reviewer report reference ${index} points outside the reviewed PR`);
    check(Number.isSafeInteger(report.id) && report.id > 0 && !ids.has(report.id), `Reviewer report reference ${index} needs a unique comment id`);
    check(report.head === head, `Reviewer report reference ${index} is not bound to the current head`);
    check(Number.isSafeInteger(report.round) && report.round === round, `Reviewer report reference ${index} is not bound to the current round`);
    if (report.reportId !== undefined) check(typeof report.reportId === "string" && /^sha256:[a-f0-9]{64}$/.test(report.reportId), `Reviewer report reference ${index} has an invalid stable identity`);
    roles.add(report.role);
    ids.add(report.id);
    return { role: report.role, url: report.url, id: report.id, head: report.head, round: report.round, ...(report.reportId ? { reportId: report.reportId } : {}) };
  });
}

function renderStandaloneReviewPanel(draft, body, options = {}) {
  const allowed = ["kind", "repo", "pr", "baseRef", "baseSha", "head", "round", "inputs", "supersedes", "reviewerReports", "controlPlane"];
  check(Object.keys(draft).every(key => allowed.includes(key)), `Unknown standalone review field: ${Object.keys(draft).find(key => !allowed.includes(key))}`);
  check(draft.kind === "REVIEW-PANEL", "Unsupported standalone record kind");
  assertInstalledDirectHelper(draft.controlPlane);
  const cwd = options.cwd ?? process.cwd();
  assertRepo(draft.repo, cwd);
  check(typeof body === "string" && body.trim(), "Record needs substantive Markdown sections");
  check(!/^<!-- FORGE:|^\*\*(?:Head|Source head|Issue|Target|Model|Inputs|Supersedes|Remediation round)\*\*:/m.test(body), "Supply content sections only; common identity headers are generated");
  check(typeof draft.head === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(draft.head), "Standalone review needs a full source commit");
  check(Number.isSafeInteger(draft.pr) && draft.pr > 0, "Standalone review record requires its exact PR");
  check(Number.isSafeInteger(draft.round) && draft.round >= 0, "Standalone review record requires its round");
  check(typeof draft.baseRef === "string" && draft.baseRef.trim() && !/[\s\0]/.test(draft.baseRef), "Standalone review record requires its base ref");
  check(typeof draft.baseSha === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(draft.baseSha), "Standalone review record requires its base SHA");
  execFileSync("git", ["cat-file", "-e", `${draft.head}^{commit}`], { cwd, stdio: "pipe" });
  check(Array.isArray(draft.inputs) && draft.inputs.every(link), "Inputs must be actual HTTPS permalinks");
  check(draft.supersedes == null || link(draft.supersedes), "Supersedes must be a permalink or null");
  const reports = reviewerReportReferences(draft.reviewerReports, draft.head, draft.round, draft.repo, draft.pr);
  const metadata = { v: 1, source_head: draft.head, inputs: draft.inputs, supersedes: draft.supersedes ?? null,
    review: { repository: draft.repo, pull_request: draft.pr, base_ref: draft.baseRef, base_sha: draft.baseSha, round: draft.round, reports } };
  const markdown = `<!-- FORGE:REVIEW-PANEL -->\n<!-- FORGE:RECORD ${JSON.stringify(metadata)} -->\n## Review Panel\n\n**Pull request**: [#${draft.pr}](https://github.com/${draft.repo}/pull/${draft.pr})\n**Base**: \`${draft.baseRef}\` at \`${draft.baseSha}\`\n**Source head**: \`${draft.head}\`\n**Individual reviewer reports**:\n${reports.map(report => `- ${report.role}: [comment #${report.id}](${report.url})`).join("\n")}\n**Inputs**: ${draft.inputs.length ? draft.inputs.map((url, i) => `[source ${i + 1}](${url})`).join(", ") : "none"}\n**Supersedes**: ${draft.supersedes ? `[previous record](${draft.supersedes})` : "none"}\n\n${body.trim()}\n`;
  return { policy: undefined, controlPlane: draft.controlPlane, repo: draft.repo, target: draft.pr, head: draft.head, baseRef: draft.baseRef, baseSha: draft.baseSha, markdown };
}

export function renderRecord(draft, body, options = {}) {
  if (draft.kind === "REVIEW-PANEL" && draft.input === undefined) return renderStandaloneReviewPanel(draft, body, options);
  const policy = loadPolicy(draft.input, options.env ?? process.env);
  assertInstalledRecordHelper(policy);
  const cwd = options.cwd ?? process.cwd(); assertRepo(policy.repo, cwd);
  check(Object.hasOwn(titles, draft.kind), "Unsupported record kind");
  check(typeof body === "string" && body.trim(), "Record needs substantive Markdown sections");
  // Common identity is generated, never manually restated in the body.
  check(!/^<!-- FORGE:|^\*\*(?:Head|Source head|Issue|Target|Model|Inputs|Supersedes|Remediation round)\*\*:/m.test(body), "Supply content sections only; common identity headers are generated");
  const head = draft.head ?? gitHead(cwd);
  check(typeof head === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head), "Record needs a full source commit");
  execFileSync("git", ["cat-file", "-e", `${head}^{commit}`], { cwd, stdio: "pipe" });
  check(Array.isArray(draft.inputs) && draft.inputs.every(link), "Inputs must be actual HTTPS permalinks");
  check(draft.supersedes == null || link(draft.supersedes), "Supersedes must be a permalink or null");
  if (draft.kind === "REMEDIATION") check(Number.isSafeInteger(draft.round) && draft.round >= 1 && draft.round <= policy.remediationLimit, "Remediation round exceeds the bound policy");
  if (draft.kind === "REVIEW-PANEL") check(Number.isSafeInteger(draft.pr) && draft.pr > 0, "Review record requires its exact PR");
  const reports = draft.kind === "REVIEW-PANEL" ? reviewerReportReferences(draft.reviewerReports, head, draft.round ?? 0, policy.repo, draft.pr) : [];
  const target = draft.kind === "REVIEW-PANEL" ? draft.pr : policy.issue;
  const metadata = { v: 1, source_head: head, inputs: draft.inputs, supersedes: draft.supersedes ?? null,
    execution: { repo: policy.repo, issue: policy.issue, target: policy.target, model: policy.model, remediation_limit: policy.remediationLimit },
    ...(reports.length ? { reviewer_reports: reports } : {}) };
  const markdown = `<!-- FORGE:${draft.kind} -->\n<!-- FORGE:RECORD ${JSON.stringify(metadata)} -->\n## ${titles[draft.kind]}\n\n`
    + `**Issue**: ${policy.repo}#${policy.issue}\n**Target**: ${policy.target}\n**Source head**: \`${head}\`\n`
    + (draft.kind === "BUILDER" ? `**Head**: \`${head}\`\n` : "")
    + (draft.kind === "REMEDIATION" ? `**Remediation round**: ${draft.round}/${policy.remediationLimit}\n` : "")
    + (reports.length ? `**Individual reviewer reports**:\n${reports.map(report => `- ${report.role}: [comment #${report.id}](${report.url})`).join("\n")}\n` : "")
    + `**Inputs**: ${draft.inputs.length ? draft.inputs.map((url, i) => `[source ${i + 1}](${url})`).join(", ") : "none"}\n`
    + `**Supersedes**: ${draft.supersedes ? `[previous record](${draft.supersedes})` : "none"}\n\n${body.trim()}\n`;
  return { policy, controlPlane: policy.controlPlane, repo: policy.repo, target, head, markdown };
}

export function publishRecord(record, outputFile, gh = defaultGh) {
  const { policy, target, head, markdown } = record;
  const repo = record.repo ?? policy?.repo;
  const baseRef = record.baseRef ?? policy?.target;
  const controlPlane = record.controlPlane ?? policy?.controlPlane;
  check(repo && controlPlane, "Records without a parent control-plane binding cannot be published");
  if (policy) assertInstalledRecordHelper(policy); else assertInstalledDirectHelper(controlPlane);
  check(fs.readFileSync(outputFile, "utf8") === markdown, "Publication file does not match rendered identity/body");
  if (markdown.startsWith("<!-- FORGE:REVIEW-PANEL -->")) {
    const pr = JSON.parse(callGh(gh, ["pr", "view", String(target), "-R", repo, "--json", "headRefOid,baseRefName,baseRefOid"], 120_000));
    check(pr.headRefOid === head && pr.baseRefName === baseRef && (!record.baseSha || pr.baseRefOid === record.baseSha), "PR head/target disagrees with bound review identity");
  }
  const endpoint = `repos/${repo}/issues/${target}/comments`;
  const pages = JSON.parse(callGh(gh, ["api", "--paginate", "--slurp", endpoint], 120_000));
  check(Array.isArray(pages), "Unexpected comment response");
  const existing = pages.flat().filter(c => c?.body === markdown);
  check(existing.length <= 1, "Duplicate matching records already exist; reconcile explicitly");
  const created = existing[0] ?? JSON.parse(callGh(gh, ["api", endpoint, "-F", `body=@${path.resolve(outputFile)}`], 120_000));
  check(Number.isSafeInteger(created.id) && created.id > 0, "Missing server comment identity");
  const stored = JSON.parse(callGh(gh, ["api", `repos/${repo}/issues/comments/${created.id}`], 120_000));
  check(stored.id === created.id && stored.body === markdown && link(stored.html_url), "Published record readback mismatch");
  const url = new URL(stored.html_url);
  check([`/${repo}/issues/${target}`, `/${repo}/pull/${target}`].some(p => p.toLowerCase() === url.pathname.toLowerCase()) && url.hash === `#issuecomment-${created.id}`, "Published link disagrees with destination identity");
  return { repo, issue: policy?.issue, destination: target, id: stored.id, url: stored.html_url, source_head: head, reused: Boolean(existing.length) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, a, b, c, action] = process.argv.slice(2);
    if (mode === "reviewer") {
      check(a && b && c && (!action || action === "--publish"), "Usage: record.mjs reviewer AUTHORIZATION_JSON BODY_MD REPORT_MD [--publish]");
      const authorization = readJson(a);
      const record = writeReviewerReport(renderReviewerReport(authorization, fs.readFileSync(b, "utf8")), c);
      console.log(JSON.stringify(action ? publishReviewerReport(record, c) : { schema: REVIEWER_PUBLICATION_SCHEMA, repo: record.repo, pr: record.target, role: record.authorization.role, reportId: record.authorization.id, source_head: record.head, outputFile: record.outputFile }, null, 2));
    } else {
      const draftFile = mode, bodyFile = a, outputFile = b;
      check(draftFile && bodyFile && outputFile && (!c || c === "--publish"), "Usage: record.mjs DRAFT_JSON BODY_MD OUTPUT_MD [--publish]");
      const record = renderRecord(readJson(draftFile), fs.readFileSync(bodyFile, "utf8"));
      if (fs.existsSync(outputFile)) check(fs.readFileSync(outputFile, "utf8") === record.markdown, "Output exists with different content; use a new scratch path");
      else fs.writeFileSync(outputFile, record.markdown, { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify(c ? publishRecord(record, outputFile) : { repo: record.repo, issue: record.policy?.issue, destination: record.target, source_head: record.head, outputFile: path.resolve(outputFile) }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
