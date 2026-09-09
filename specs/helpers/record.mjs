#!/usr/bin/env node
// Render/post an explicitly requested record; no workflow or finding decisions.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadPolicy, assertRepo, gitHead } from "./dispatch.mjs";

const titles = { INVESTIGATOR: "Investigation", CLASSIFICATION: "Classification", CONTEXT: "Implementation Context", CONTRACT: "Build Contract", ARCHITECT: "Implementation Plan", BUILDER: "Build Complete", "REVIEW-PANEL": "Review Panel", REMEDIATION: "Remediation Complete", DECOMPOSED: "Decomposition Complete", GATED: "Work-On Gated", TRAJECTORY: "Work-On Outcome" };
function check(ok, message) { if (!ok) throw new Error(message); }
const link = value => {
  if (typeof value !== "string" || /[\s<>]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search; } catch { return false; }
};
export function renderRecord(draft, body, options = {}) {
  const policy = loadPolicy(draft.input, options.env ?? process.env, options.legacyHistory === true);
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
  const target = draft.kind === "REVIEW-PANEL" ? draft.pr : policy.issue;
  const metadata = { v: 1, source_head: head, inputs: draft.inputs, supersedes: draft.supersedes ?? null,
    execution: { repo: policy.repo, issue: policy.issue, target: policy.target, model: policy.model, remediation_limit: policy.remediationLimit } };
  const markdown = `<!-- FORGE:${draft.kind} -->\n<!-- FORGE:RECORD ${JSON.stringify(metadata)} -->\n## ${titles[draft.kind]}\n\n`
    + `**Issue**: ${policy.repo}#${policy.issue}\n**Target**: ${policy.target}\n**Source head**: \`${head}\`\n`
    + (draft.kind === "BUILDER" ? `**Head**: \`${head}\`\n` : "")
    + (draft.kind === "REMEDIATION" ? `**Remediation round**: ${draft.round}/${policy.remediationLimit}\n` : "")
    + `**Inputs**: ${draft.inputs.length ? draft.inputs.map((url, i) => `[source ${i + 1}](${url})`).join(", ") : "none"}\n`
    + `**Supersedes**: ${draft.supersedes ? `[previous record](${draft.supersedes})` : "none"}\n\n${body.trim()}\n`;
  return { policy, target, head, markdown };
}
export function publishRecord(record, outputFile, gh = args => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) {
  const { policy, target, head, markdown } = record;
  check(fs.readFileSync(outputFile, "utf8") === markdown, "Publication file does not match rendered identity/body");
  if (markdown.startsWith("<!-- FORGE:REVIEW-PANEL -->")) {
    const pr = JSON.parse(gh(["pr", "view", String(target), "-R", policy.repo, "--json", "headRefOid,baseRefName"]));
    check(pr.headRefOid === head && pr.baseRefName === policy.target, "PR head/target disagrees with bound review identity");
  }
  const endpoint = `repos/${policy.repo}/issues/${target}/comments`;
  const pages = JSON.parse(gh(["api", "--paginate", "--slurp", endpoint]));
  check(Array.isArray(pages), "Unexpected comment response");
  const existing = pages.flat().filter(c => c?.body === markdown);
  check(existing.length <= 1, "Duplicate matching records already exist; reconcile explicitly");
  const created = existing[0] ?? JSON.parse(gh(["api", endpoint, "-F", `body=@${path.resolve(outputFile)}`]));
  check(Number.isSafeInteger(created.id) && created.id > 0, "Missing server comment identity");
  const stored = JSON.parse(gh(["api", `repos/${policy.repo}/issues/comments/${created.id}`]));
  check(stored.id === created.id && stored.body === markdown && link(stored.html_url), "Published record readback mismatch");
  const url = new URL(stored.html_url);
  check([`/${policy.repo}/issues/${target}`, `/${policy.repo}/pull/${target}`].some(p => p.toLowerCase() === url.pathname.toLowerCase()) && url.hash === `#issuecomment-${created.id}`, "Published link disagrees with destination identity");
  return { repo: policy.repo, issue: policy.issue, destination: target, id: stored.id, url: stored.html_url, source_head: head, reused: Boolean(existing.length) };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [draftFile, bodyFile, outputFile, action] = process.argv.slice(2);
    check(draftFile && bodyFile && outputFile && (!action || action === "--publish"), "Usage: record.mjs DRAFT_JSON BODY_MD OUTPUT_MD [--publish]");
    const draft = JSON.parse(fs.readFileSync(draftFile, "utf8"));
    const record = renderRecord(draft, fs.readFileSync(bodyFile, "utf8"));
    if (fs.existsSync(outputFile)) check(fs.readFileSync(outputFile, "utf8") === record.markdown, "Output exists with different content; use a new scratch path");
    else fs.writeFileSync(outputFile, record.markdown, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(action ? publishRecord(record, outputFile) : { repo: record.policy.repo, issue: record.policy.issue, destination: record.target, source_head: record.head, outputFile: path.resolve(outputFile) }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
