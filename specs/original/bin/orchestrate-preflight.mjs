#!/usr/bin/env node
/**
 * Deterministic /orchestrate preflight planner.
 *
 * This helper is deliberately read-only: it resolves and validates a literal
 * issue set, then emits a plan for the prompt-routed orchestrator. Query-shaped
 * input is handed to the full phase-file path instead of being guessed here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NUMBER_RE = /^(?:[A-Za-z0-9_-]+:)?#?(\d+)$/;
const FILE_RE = /`([^`]+\.(?:py|tsx?|jsx?|sql|json|ya?ml|mjs|js|sh|md))`/g;
const REJECTED_LABELS = new Set([
  "workflow:merged",
  "workflow:invalid",
  "needs-human",
  "workflow:decomposed",
  "workflow:building",
  "workflow:in-review",
  "epic",
]);

function fail(message, code = 2) {
  console.error(`orchestrate-preflight: ${message}`);
  process.exitCode = code;
}

function json(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function classifyInput(input) {
  const tokens = String(input ?? "")
    .replace(/(?:^|\s)(?:--auto|--confirm|--deep-plan)(?=\s|$)/gi, " ")
    .replace(/(?:^|\s)--max-concurrent(?:=|\s+)[1-9]\d*(?=\s|$)/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length && tokens.every((token) => NUMBER_RE.test(token))) {
    const numbers = tokens.map((token) => Number(token.match(NUMBER_RE)[1]));
    if (new Set(numbers).size !== numbers.length)
      return { kind: "invalid", pattern: "duplicate-issues", tokens, numbers };
    return { kind: "literal", pattern: "literal-numbers", tokens, numbers };
  }
  return { kind: "query", pattern: tokens.length ? "ambiguous" : "empty", tokens };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "ignore" : "pipe"],
  }).trim();
}

function issueView(repo, number) {
  return JSON.parse(run("gh", ["issue", "view", String(number), "-R", repo, "--json", "number,title,body,labels,state,milestone"]));
}

function issueComments(repo, number) {
  try {
    return JSON.parse(run("gh", ["api", `repos/${repo}/issues/${number}/comments`], { quiet: true }));
  } catch {
    return [];
  }
}

function scopedFiles(text, heading) {
  const lines = String(text ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start < 0) return [];
  const section = [];
  for (let i = start + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) section.push(lines[i]);
  const files = new Set();
  for (const line of section) {
    for (const match of line.matchAll(FILE_RE)) files.add(match[1]);
  }
  return [...files].sort();
}

export function extractAffectedFiles(issue, comments) {
  const contract = [...comments].reverse().find((comment) => comment.body?.includes("FORGE:CONTRACT"));
  if (contract) {
    const files = scopedFiles(contract.body, "### Deliverables");
    if (files.length) return { provenance: "contract-deliverables", files };
  }
  const investigation = [...comments].reverse().find((comment) => comment.body?.includes("FORGE:INVESTIGATOR"));
  if (investigation) return { provenance: "affected-files-section", files: scopedFiles(investigation.body, "### Affected Files") };
  for (const heading of ["## Affected Files", "## Deliverables", "### Files to change"]) {
    const files = scopedFiles(issue.body, heading);
    if (files.length) return { provenance: "body-fallback", files };
  }
  return { provenance: "none", files: [] };
}

function slugify(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
}

function laneFor(issue, staging) {
  const milestone = issue.milestone?.title ?? null;
  if (!milestone) return { lane: staging, branch: staging, source: "fast-lane", milestone: null };
  const slug = slugify(milestone);
  return { lane: `milestone/${slug}`, branch: `milestone/${slug}`, source: "feature-lane", milestone, slug };
}

function dependenciesFor(body) {
  const dependencies = new Set();
  for (const match of String(body ?? "").matchAll(/(?:depends on|blocked by|after|parent investigation)\s*:?\s*#?(\d+)/gi)) dependencies.add(Number(match[1]));
  return [...dependencies].sort((a, b) => a - b);
}

function hasDomain(issue, name) {
  return new RegExp(`(?:${name})`, "i").test(`${issue.title ?? ""}\n${issue.body ?? ""}`);
}

export function findCycle(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) if (outgoing.has(edge.from) && outgoing.has(edge.to)) outgoing.get(edge.from).push(edge.to);
  const state = new Map(nodes.map((node) => [node, 0]));
  const stack = [];
  function visit(node) {
    state.set(node, 1); stack.push(node);
    for (const next of outgoing.get(node) ?? []) {
      if (state.get(next) === 1) return stack.slice(stack.indexOf(next));
      if (state.get(next) === 0) { const cycle = visit(next); if (cycle) return cycle; }
    }
    stack.pop(); state.set(node, 2); return undefined;
  }
  for (const node of nodes) if (state.get(node) === 0) { const cycle = visit(node); if (cycle) return cycle; }
  return undefined;
}

export function buildPlan(issues, maxConcurrent, staging) {
  const sorted = [...issues].sort((a, b) => a.number - b.number);
  const nodes = sorted.map((issue) => String(issue.number));
  const edges = [];
  const add = (from, to, kind, reason) => {
    if (from === to || edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind)) return;
    edges.push({ from, to, kind, reason });
  };
  for (const issue of sorted) for (const dependency of issue.dependencies) {
    if (nodes.includes(String(dependency))) add(String(dependency), String(issue.number), "explicit", `#${issue.number} ${issue.bodyDependencyReason ?? "declares a dependency"}`);
    else issue.externalDependencies.push(dependency);
  }
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const left = sorted[i], right = sorted[j];
    const shared = left.affected.files.filter((file) => right.affected.files.includes(file));
    if (shared.length) add(String(left.number), String(right.number), "file", `shared affected file: ${shared.join(", ")}`);
  }
  const database = sorted.filter((issue) => hasDomain(issue, "database|migration|postgres|sql"));
  for (let i = 1; i < database.length; i++) add(String(database[i - 1].number), String(database[i].number), "resource", "DATABASE issues are serialized");
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));
  const predecessors = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) predecessors.get(edge.to).push(edge.from);
  for (const values of predecessors.values()) values.sort((a, b) => Number(a) - Number(b));
  const cycle = findCycle(nodes, edges);
  // A predecessor must complete before dispatch; at T0 only nodes with no predecessors are ready.
  const initialReady = sorted.filter((issue) => issue.eligible && !issue.externalDependencies.length && !cycle && (predecessors.get(String(issue.number)) ?? []).length === 0).sort((left, right) => right.priority - left.priority || left.number - right.number).map((issue) => issue.number).slice(0, maxConcurrent);
  return {
    nodes: sorted.map((issue) => ({ id: String(issue.number), issueNumber: issue.number, priority: issue.priority })),
    edges,
    predecessors: Object.fromEntries([...predecessors].map(([id, values]) => [id, values])),
    cycleCheck: { detected: Boolean(cycle), nodes: cycle ?? [] },
    readyQueue: initialReady,
    maxConcurrent,
    max_concurrent: maxConcurrent,
  };
}

function readStaging() {
  try {
    const yaml = readFileSync(join(process.cwd(), "forge.yaml"), "utf8");
    return yaml.match(/^\s*staging:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1] ?? "staging";
  } catch { return "staging"; }
}

function main(argv) {
  const args = [...argv]; let repo = ""; let raw = ""; let maxConcurrent = 4;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") repo = args[++i] ?? "";
    else if (args[i] === "--args") raw = args[++i] ?? "";
    else if (args[i] === "--max-concurrent") maxConcurrent = Number(args[++i]);
    else if (args[i].startsWith("--max-concurrent=")) maxConcurrent = Number(args[i].slice(17));
    else return fail(`unknown argument ${args[i]}`);
  }
  if (!REPO_RE.test(repo)) return fail("--repo must be owner/repo");
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) return fail("--max-concurrent must be a positive integer");
  const classification = classifyInput(raw);
  const confirmed = /(?:^|\s)(?:--auto|--confirm)(?=\s|$)/i.test(raw);
  const base = { schema: "forgedock.orchestrate-preflight/v1", repository: repo, input: raw, classification, confirmed, maxConcurrent, max_concurrent: maxConcurrent };
  if (classification.kind !== "literal") return json({ ...base, confirmed: false, requiresDeepPlan: true, dispatchNow: false, message: "Input is not an unambiguous literal issue list; continue with the full orchestrate phase-file resolver." });
  let views;
  try { views = classification.numbers.map((number) => issueView(repo, number)); }
  catch (error) { return json({ ...base, confirmed: false, requiresDeepPlan: true, dispatchNow: false, message: `Could not read the literal issue set: ${error.message}. Retry after checking gh authentication and repository access.` }); }
  const issues = views.map((issue) => {
    const labels = (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean).sort();
    const reasons = labels.filter((label) => REJECTED_LABELS.has(label));
    if (issue.state !== "OPEN") reasons.push(`state:${issue.state.toLowerCase()}`);
    const comments = issueComments(repo, issue.number);
    const affected = extractAffectedFiles(issue, comments);
    return { number: issue.number, title: issue.title, state: issue.state, labels, milestone: issue.milestone?.title ?? null, eligible: reasons.length === 0, reasons, priority: Number((labels.find((label) => /^priority:P?\d+$/i.test(label)) ?? "P9").match(/\d+/)?.[0] ?? 9), lane: laneFor(issue, readStaging()), affected, dependencies: dependenciesFor(issue.body), externalDependencies: [], body: issue.body ?? "" };
  });
  const dag = buildPlan(issues, maxConcurrent, readStaging());
  const cycle = dag.cycleCheck.detected;
  const dispatchNow = confirmed && !cycle && dag.readyQueue.length > 0;
  return json({ ...base, requiresDeepPlan: false, dispatchNow, dispatchNowIssues: dag.readyQueue, issues: issues.map(({ body, ...issue }) => issue), dag: { nodes: dag.nodes, edges: dag.edges, predecessors: dag.predecessors }, cycleCheck: dag.cycleCheck, readyQueue: dag.readyQueue });
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
