#!/usr/bin/env node
// Mechanical request preparation only: no agents, GitHub writes or phase decisions.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

export const BINDING = "forgedock.execution/1";
const here = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash("sha256").update(value).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
function requireThat(ok, message) { if (!ok) throw new Error(message); }
function integer(value, name, minimum = 1) { requireThat(Number.isSafeInteger(value) && value >= minimum, `${name} must be an integer >= ${minimum}`); return value; }
function fields(value, allowed, name) {
  requireThat(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  for (const key of Object.keys(value)) requireThat(allowed.includes(key), `Unknown ${name} field: ${key}`);
}
function descriptor(file) {
  const resolved = path.resolve(file);
  return { path: resolved, sha256: sha(fs.readFileSync(resolved)) };
}
function save(file, value) { fs.writeFileSync(file, value, { flag: "wx", mode: 0o400 }); return descriptor(file); }
export function readInput(input) {
  fields(input, ["path", "sha256"], "input descriptor");
  requireThat(path.isAbsolute(input.path ?? "") && /^[a-f0-9]{64}$/.test(input.sha256 ?? ""), "Input requires an absolute path and SHA-256");
  const bytes = fs.readFileSync(input.path);
  requireThat(sha(bytes) === input.sha256, "Input digest mismatch; obtain the correct parent input");
  return JSON.parse(bytes.toString("utf8"));
}
export function gitHead(cwd = process.cwd()) { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(); }
export function assertRepo(repo, cwd = process.cwd()) {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).trim().replace(/\/$/, "");
  const match = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  requireThat(match?.[1]?.toLowerCase() === repo.toLowerCase(), "Current origin does not match the bound repository");
}
function sourceRoot(config, cwd) { return config.paths?.root ? fs.realpathSync(path.resolve(cwd, config.paths.root)) : fs.realpathSync(cwd); }
function configAt(cwd) {
  const raw = fs.readFileSync(path.join(cwd, "forge.yaml")); // no neighbour search
  const config = parse(raw.toString("utf8"));
  const owner = config?.project?.owner, name = config?.project?.repo;
  requireThat(/^[\w.-]+$/.test(owner ?? "") && /^[\w.-]+$/.test(name ?? ""), "Canonical forge.yaml needs project.owner/repo");
  const repo = `${owner}/${name}`; assertRepo(repo, cwd);
  if (sourceRoot(config, cwd) !== fs.realpathSync(cwd)) throw new Error("Run preparation from the canonical paths.root, not another worktree");
  const model = config.agents?.subagent_model ?? config.agents?.default_model;
  requireThat(typeof model === "string" && /^[^\s/]+\/[^\s]+$/.test(model), "Canonical config needs a full provider/model ID");
  const remediationLimit = integer(config.review?.remediation_max_rounds ?? 1, "remediation limit", 0);
  return { raw, config, repo, model, remediationLimit };
}
export function loadPolicy(explicit, env = process.env) {
  const bindings = env.PI_SUBAGENT_EXTENSION_BINDINGS ? JSON.parse(env.PI_SUBAGENT_EXTENSION_BINDINGS) : {};
  const bound = bindings[BINDING];
  if (bound && explicit) requireThat(bound.path === explicit.path && bound.sha256 === explicit.sha256, "Explicit input disagrees with native lane binding");
  requireThat(bound || explicit, "Missing authoritative lane input; do not search sibling worktrees for configuration");
  const policy = readInput(bound ?? explicit);
  requireThat(policy.v === 1 && typeof policy.repo === "string" && typeof policy.key === "string", "Invalid lane input");
  integer(policy.issue, "issue"); integer(policy.remediationLimit, "remediation limit", 0);
  requireThat(typeof policy.model === "string" && /^[^\s/]+\/[^\s]+$/.test(policy.model), "Invalid bound model");
  return policy;
}
export function prepareSingle(plan, out, cwd = process.cwd()) {
  fields(plan, ["number", "target", "requestStartedAt", "verification"], "single policy");
  integer(plan.number, "issue number");
  requireThat(typeof plan.target === "string" && plan.target.length > 0, "Single policy needs target");
  execFileSync("git", ["check-ref-format", "--branch", plan.target], { cwd, stdio: "pipe" });
  const source = configAt(cwd);
  if (plan.verification) readInput(plan.verification);
  fs.mkdirSync(out, { recursive: true }); out = path.resolve(out);
  const config = { path: path.resolve(cwd, "forge.yaml"), sha256: sha(source.raw) };
  const verification = plan.verification ?? save(path.join(out, "verification.json"), json({ commands: source.config.verification?.commands ?? {}, discovery: source.config.verification?.discovery ?? {} }));
  const policy = { v: 1, key: `issue-${plan.number}`, repo: source.repo, issue: plan.number, target: plan.target,
    model: source.model, remediationLimit: source.remediationLimit, requestStartedAt: plan.requestStartedAt ?? null, config, verification };
  return { input: save(path.join(out, "lane.json"), json(policy)) };
}
function recipe() {
  const doc = fs.readFileSync(path.join(here, "..", "pi-adapter.md"), "utf8");
  const body = doc.slice(doc.indexOf("Use one visible promise graph.")).match(/```js\n([\s\S]*?)\n```/)?.[1];
  requireThat(body, "Packaged dispatcher recipe is missing"); return body;
}
export function prepareBatch(plan, out, cwd = process.cwd()) {
  fields(plan, ["issues", "activeOwners", "requestStartedAt", "verification"], "plan");
  const source = configAt(cwd);
  integer(plan.activeOwners, "activeOwners");
  requireThat(Array.isArray(plan.issues) && plan.issues.length > 0, "Plan needs issues");
  if (source.config.orchestration?.max_concurrent !== undefined) requireThat(plan.activeOwners <= integer(source.config.orchestration.max_concurrent, "configured concurrency"), "Active owners exceed configured ceiling");
  requireThat(typeof plan.requestStartedAt === "string" && Number.isFinite(Date.parse(plan.requestStartedAt)), "Plan needs the original request timestamp");
  const seen = new Set();
  for (const issue of plan.issues) {
    fields(issue, ["number", "target", "baseCwd", "predecessors"], "issue");
    integer(issue.number, "issue number");
    requireThat(!seen.has(issue.number), "Duplicate issue");
    requireThat(typeof issue.target === "string" && issue.target.length > 0 && !issue.target.startsWith("-"), "Issue needs target branch");
    execFileSync("git", ["check-ref-format", "--branch", issue.target], { cwd, stdio: "pipe" });
    requireThat(path.isAbsolute(issue.baseCwd ?? "") && fs.statSync(issue.baseCwd).isDirectory(), "Issue needs an existing absolute baseCwd");
    assertRepo(source.repo, issue.baseCwd);
    requireThat(Array.isArray(issue.predecessors) && issue.predecessors.every(n => seen.has(n)), "Issues must be topologically ordered with known predecessors");
    seen.add(issue.number);
  }
  if (plan.verification) readInput(plan.verification);
  fs.mkdirSync(out, { recursive: true }); out = path.resolve(out);
  const configInput = { path: path.resolve(cwd, "forge.yaml"), sha256: sha(source.raw) };
  const verification = plan.verification ?? save(path.join(out, "verification.json"), json({ commands: source.config.verification?.commands ?? {}, discovery: source.config.verification?.discovery ?? {} }));
  const issueGraph = [], lanes = [], keys = new Map();
  const batchNonce = randomUUID();
  for (const issue of plan.issues) {
    const logicalKey = `issue-${issue.number}`;
    const policy = { v: 1, key: logicalKey, batchNonce, repo: source.repo, issue: issue.number, target: issue.target, model: source.model,
      remediationLimit: source.remediationLimit, requestStartedAt: plan.requestStartedAt, config: configInput, verification };
    const input = save(path.join(out, `${logicalKey}.json`), json(policy));
    const key = `${logicalKey}-${input.sha256}`; keys.set(issue.number, key);
    lanes.push({ key, issue: issue.number, repo: source.repo, target: issue.target, input });
    issueGraph.push({ key, issue: issue.number, repo: source.repo, target: issue.target,
      predecessors: issue.predecessors.map(n => keys.get(n)),
      launch: { agent: "forgedock-work-on-coordinator", task: `${issue.number} --under-orchestration\n\nPrepared lane input: ${JSON.stringify(input)}\nPrepared verification catalog: ${JSON.stringify(verification)}`,
        context: "fresh", model: source.model, cwd: issue.baseCwd, worktree: true, output: false, outputMode: "inline", artifacts: true,
        extensionBindings: { [BINDING]: input }, timeoutMs: 2147483647 } });
  }
  const scriptPath = path.join(out, "workflow.js");
  save(scriptPath, `const configuredModel=${JSON.stringify(source.model)};\nconst ownerConcurrency=${plan.activeOwners};\nconst issueGraph=${JSON.stringify(issueGraph)};\n${recipe()}\n`);
  const batch = { batchNonce, repo: source.repo, requestStartedAt: plan.requestStartedAt, lanes };
  save(path.join(out, "batch.json"), json(batch));
  const request = { async: true, workflowScriptPath: scriptPath, globalConcurrencyLimit: plan.activeOwners,
    control: { needsAttentionAfterMs: 1200000, activeNoticeAfterMs: 1200000 } };
  save(path.join(out, "request.json"), json(request));
  return { request, requestFile: path.join(out, "request.json"), batchFile: path.join(out, "batch.json") };
}
export function prepareReview(plan, out, env = process.env) {
  fields(plan, ["input", "head", "round", "roles"], "review");
  const policy = loadPolicy(plan.input, env);
  integer(plan.round, "review round", 0);
  requireThat(plan.round <= policy.remediationLimit, `Review round ${plan.round} exceeds bound remediation limit ${policy.remediationLimit}`);
  requireThat(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(plan.head ?? ""), "Review needs exact head");
  requireThat(Array.isArray(plan.roles) && plan.roles.length > 0, "Review needs selected roles");
  const used = new Set();
  const roles = plan.roles.map(role => {
    fields(role, ["role", "task", "thinking"], "role");
    const name = role.role === "general" ? "correctness" : role.role;
    requireThat(typeof name === "string" && /^[a-z][a-z0-9-]*$/.test(name) && !used.has(name), "Duplicate or invalid review role"); used.add(name);
    requireThat(typeof role.task === "string" && role.task.length > 0, "Review role needs a task");
    requireThat(["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(role.thinking), "Invalid review thinking level");
    const model = /:(off|minimal|low|medium|high|xhigh|max)$/.test(policy.model) ? policy.model : `${policy.model}:${role.thinking}`;
    return { key: `${name}-${plan.round}-${plan.head.slice(0, 12)}`, agent: "delegate", task: `Bound review identity: ${policy.repo}#${policy.issue}, target ${policy.target}, head ${plan.head}.\n${role.task}`,
      model, context: "fresh", worktree: false, acceptance: false, timeoutMs: 900000 };
  });
  fs.mkdirSync(out, { recursive: true }); out = path.resolve(out);
  const scriptPath = path.join(out, "review.js"); save(scriptPath, `return await runs.all(${JSON.stringify(roles)});\n`);
  const request = { workflowScriptPath: scriptPath, async: !env.PI_SUBAGENT_RUN_ID, timeoutMs: 1200000 };
  save(path.join(out, "request.json"), json(request)); return { request, requestFile: path.join(out, "request.json") };
}
export function identifyLane(batch, status, runId) {
  requireThat(typeof runId === "string" && runId.length > 0, "Use the native request's exact owner run ID, never a local index");
  const matches = (status.steps ?? []).filter(s => s.runId === runId);
  requireThat(matches.length === 1, "Owner run ID is absent or ambiguous in this native workflow status");
  const lanes = batch.lanes.filter(l => l.key === matches[0].workflowKey || `${l.key}-recovery` === matches[0].workflowKey);
  requireThat(lanes.length === 1, "Native workflow key is absent or ambiguous in this exact prepared batch");
  const lane = lanes[0], policy = readInput(lane.input);
  requireThat(lane.key === `${policy.key}-${lane.input.sha256}` && policy.batchNonce === batch.batchNonce && policy.repo === batch.repo
    && policy.repo === lane.repo && policy.issue === lane.issue && policy.target === lane.target, "Identity disagrees with the digest-bound prepared batch");
  return { runId, workflowRunId: status.runId, key: lanes[0].key, repo: lanes[0].repo, issue: lanes[0].issue, target: lanes[0].target };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, a, b, c] = process.argv.slice(2);
    const result = mode === "batch" ? prepareBatch(read(a), b)
      : mode === "single" ? prepareSingle(read(a), b)
      : mode === "review" ? prepareReview(read(a), b)
      : mode === "identify" ? identifyLane(read(a), read(b), c)
      : mode === "context" ? loadPolicy(a ? read(a) : undefined)
      : (() => { throw new Error("Usage: dispatch.mjs batch PLAN OUT | single PLAN OUT | review PLAN OUT | identify BATCH STATUS RUN_ID | context [INPUT_DESCRIPTOR]"); })();
    console.log(json(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
