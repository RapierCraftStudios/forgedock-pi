#!/usr/bin/env node
// Parent-owned control-plane binding. The target repository is subject data only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse } from "yaml";

export const CONTROL_PLANE_SCHEMA = "forgedock.control-plane/v1";
export const FORGE_OWNER_AGENT = "forgedock-work-on-coordinator";
export const FORGE_REVIEW_AGENT = "delegate";

const FORGE_FILES = Object.freeze([
  ["package", "package.json"],
  ["dispatch", "specs/helpers/dispatch.mjs"],
  ["record", "specs/helpers/record.mjs"],
  ["piAdapter", "specs/pi-adapter.md"],
  ["mechanicalExecution", "specs/mechanical-execution.md"],
  ["verification", "specs/verification.md"],
  ["workOnSpec", "specs/original/commands/work-on.md"],
  ["reviewSpec", "specs/original/commands/review-pr.md"],
  ["workOnSkill", "skills/forgedock-work-on/SKILL.md"],
  ["reviewSkill", "skills/forgedock-review-pr/SKILL.md"],
  ["ownerAgent", "agents/forgedock-work-on-coordinator.md"],
]);
const PI_FILES = Object.freeze([
  ["package", "package.json"],
  ["identity", "src/agents/identity.ts"],
  ["agents", "src/agents/agents.ts"],
  ["skills", "src/agents/skills.ts"],
  ["acceptance", "src/runs/shared/acceptance.ts"],
  ["asyncExecution", "src/runs/background/async-execution.ts"],
  ["types", "src/shared/types.ts"],
]);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => `sha256:${sha(Buffer.from(canonicalJson(value)))}`;
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fail(ok, message) { if (!ok) throw new Error(message); }
function canonicalRoot(value, label) {
  fail(typeof value === "string" && path.isAbsolute(value), `${label} must be an absolute path`);
  const root = fs.realpathSync(value);
  fail(root === path.resolve(value), `${label} must be a canonical real path`);
  return root;
}
function fixedFile(root, [id, relative]) {
  const expected = path.resolve(root, relative);
  const actual = fs.realpathSync(expected);
  fail(actual === expected, `Control-plane file is symlinked or swapped: ${relative}`);
  return { id, relative, path: actual, sha256: sha(fs.readFileSync(actual)) };
}
function repositoryIdentity(value) {
  if (typeof value !== "string" || /[?#\s]/.test(value)) return undefined;
  const raw = value.trim().replace(/^git\+/, "");
  let host, pathname;
  const scp = raw.match(/^git@([^:]+):(.+)$/i);
  if (scp) { host = scp[1]; pathname = scp[2]; }
  else {
    try { const url = new URL(raw); host = url.hostname; pathname = url.pathname.replace(/^\/+/, ""); }
    catch { return undefined; }
  }
  if (host?.toLowerCase() !== "github.com") return undefined;
  const parts = pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
  return parts.length === 2 ? parts.join("/").toLowerCase() : undefined;
}
function packageIdentity(root, file, name, repository) {
  fail(file.path === path.resolve(root, "package.json"), `${name} package path escaped its root`);
  const value = JSON.parse(fs.readFileSync(file.path, "utf8"));
  const repo = typeof value.repository === "string" ? value.repository : value.repository?.url;
  fail(value.name === name && repositoryIdentity(repo) === repository.toLowerCase(), `${name} package identity mismatch`);
}
function fileSet(root, files, expected, label) {
  fail(Array.isArray(files) && files.length === expected.length, `${label} control file set is incomplete`);
  for (let index = 0; index < expected.length; index++) {
    const [id, relative] = expected[index];
    const file = files[index];
    fail(file?.id === id && file.relative === relative, `${label} control file order/path mismatch`);
    const expectedPath = path.resolve(root, relative);
    fail(file.path === expectedPath && fs.realpathSync(file.path) === expectedPath, `${label} control path mismatch: ${relative}`);
    fail(sha(fs.readFileSync(file.path)) === file.sha256, `${label} control digest mismatch: ${relative}`);
  }
}
function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
export function createControlPlaneDescriptor({ forgeDockRoot, piSubagentsRoot }) {
  const forgeRoot = canonicalRoot(forgeDockRoot, "ForgeDock parent root");
  const piRoot = canonicalRoot(piSubagentsRoot, "pi-subagents parent root");
  const forgeFiles = FORGE_FILES.map(entry => fixedFile(forgeRoot, entry));
  const piFiles = PI_FILES.map(entry => fixedFile(piRoot, entry));
  const forgeDock = { root: forgeRoot, files: forgeFiles, agents: { owner: forgeFiles.find(f => f.id === "ownerAgent") } };
  const piSubagents = { root: piRoot, files: piFiles };
  const value = { v: 1, schema: CONTROL_PLANE_SCHEMA, forgeDock, piSubagents };
  packageIdentity(forgeRoot, forgeFiles[0], "forgedock-pi", "rapiercraftstudios/forgedock-pi");
  packageIdentity(piRoot, piFiles[0], "pi-subagents", "nicobailon/pi-subagents");
  return { ...value, digest: digest(value) };
}
export function validateControlPlaneDescriptor(value, options = {}) {
  fail(value && value.v === 1 && value.schema === CONTROL_PLANE_SCHEMA, "Control-plane descriptor schema mismatch");
  fail(value.digest === digest({ v: value.v, schema: value.schema, forgeDock: value.forgeDock, piSubagents: value.piSubagents }), "Control-plane descriptor digest mismatch");
  const forgeRoot = canonicalRoot(value.forgeDock?.root, "ForgeDock parent root");
  const piRoot = canonicalRoot(value.piSubagents?.root, "pi-subagents parent root");
  fileSet(forgeRoot, value.forgeDock.files, FORGE_FILES, "ForgeDock");
  fileSet(piRoot, value.piSubagents.files, PI_FILES, "pi-subagents");
  packageIdentity(forgeRoot, value.forgeDock.files[0], "forgedock-pi", "rapiercraftstudios/forgedock-pi");
  packageIdentity(piRoot, value.piSubagents.files[0], "pi-subagents", "nicobailon/pi-subagents");
  fail(value.forgeDock.agents?.owner?.path === value.forgeDock.files.find(f => f.id === "ownerAgent")?.path, "Owner agent descriptor mismatch");
  if (options.helperPath) {
    const helper = fs.realpathSync(options.helperPath);
    const expected = value.forgeDock.files.find(f => f.id === "dispatch");
    fail(helper === expected.path && sha(fs.readFileSync(helper)) === expected.sha256, "Executing dispatcher is not the bound installed helper");
  }
  if (options.targetRoot) {
    const target = canonicalRoot(options.targetRoot, "Target worktree");
    fail(!within(target, forgeRoot) && !within(target, piRoot), "Control-plane root is inside the target worktree");
    for (const file of [...value.forgeDock.files, ...value.piSubagents.files]) fail(!within(target, file.path), `Control-plane file is inside target worktree: ${file.relative}`);
  }
  return value;
}
function nativePackageName(value) {
  return value?.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, "").replace(/-+/g, "-").replace(/\.+/g, ".").replace(/(?:^[-.]+|[-.]+$)/g, "") ?? "";
}
function frontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  return match ? parse(match[1]) : undefined;
}
function agentNames(file) {
  const value = frontmatter(fs.readFileSync(file, "utf8"));
  if (!value || typeof value.name !== "string") return [];
  const packageName = nativePackageName(typeof value.package === "string" ? value.package : "");
  const prefix = packageName ? `${packageName}.` : "";
  const names = [prefix + value.name.trim()];
  const aliases = Array.isArray(value.aliases) ? value.aliases : typeof value.aliases === "string" ? value.aliases.split(/[,\n]/) : [];
  for (const alias of aliases) if (typeof alias === "string" && alias.trim()) {
    const normalized = alias.trim();
    names.push(normalized.includes(".") ? normalized : prefix + normalized);
  }
  return names;
}
function walk(root, visited = new Set(), output = []) {
  if (!fs.existsSync(root)) return output;
  let real;
  try { real = fs.realpathSync(root); } catch { return output; }
  if (visited.has(real)) return output;
  visited.add(real);
  let entries;
  try { entries = fs.readdirSync(real, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const candidate = path.join(real, entry.name);
    let stat;
    try { stat = fs.statSync(candidate); } catch { continue; }
    if (stat.isDirectory()) walk(candidate, visited, output);
    else if (stat.isFile() && entry.name.endsWith(".md")) output.push(candidate);
  }
  return output;
}
function packageAgentRoots(packageRoot) {
  const roots = [];
  const packageFile = path.join(packageRoot, "package.json");
  if (!fs.existsSync(packageFile)) return roots;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")); } catch { return roots; }
  for (const declaration of [pkg?.pi?.subagents, pkg?.["pi-subagents"]]) {
    for (const directory of declaration?.agents ?? []) if (typeof directory === "string") roots.push(path.resolve(packageRoot, directory));
  }
  return roots;
}
function packageRootsIn(nodeModules) {
  const roots = [];
  if (!fs.existsSync(nodeModules)) return roots;
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const nested of fs.readdirSync(path.join(nodeModules, entry.name), { withFileTypes: true })) if (nested.isDirectory() || nested.isSymbolicLink()) roots.push(path.join(nodeModules, entry.name, nested.name));
    } else if (entry.isDirectory() || entry.isSymbolicLink()) roots.push(path.join(nodeModules, entry.name));
  }
  return roots;
}
function settingsPackageRoots(file, base) {
  if (!fs.existsSync(file)) return [];
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  const roots = [];
  for (const entry of settings?.packages ?? []) {
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string") continue;
    if (source.startsWith("file:")) roots.push(path.resolve(base, source.slice(5)));
    else if (source.startsWith("npm:")) roots.push(path.resolve(base, "npm/node_modules", source.slice(4).split("@")[0]));
    else if (source.startsWith("git:")) {
      const raw = source.slice(4).replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/:/, "/").replace(/\.git(?:@.*)?$/, "");
      roots.push(path.resolve(base, "git", raw));
    } else if (path.isAbsolute(source)) roots.push(source);
  }
  return roots;
}
function targetAgentRoots(targetRoot) {
  const roots = new Set();
  const packageRoots = new Set();
  let current = fs.realpathSync(targetRoot);
  while (true) {
    roots.add(path.join(current, ".pi", "agents"));
    roots.add(path.join(current, ".agents"));
    packageRoots.add(current);
    const packageFile = path.join(current, "package.json");
    if (fs.existsSync(packageFile)) {
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")); } catch { pkg = undefined; }
      for (const declaration of [pkg?.pi?.subagents, pkg?.["pi-subagents"]]) for (const directory of declaration?.agents ?? []) if (typeof directory === "string") roots.add(path.resolve(current, directory));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const projectRoot = fs.realpathSync(targetRoot);
  const userRoot = process.env.PI_CODING_AGENT_DIR ? fs.realpathSync(process.env.PI_CODING_AGENT_DIR) : path.join(os.homedir(), ".pi", "agent");
  roots.add(path.join(userRoot, "agents"));
  roots.add(path.join(os.homedir(), ".agents"));
  const packageRootsToScan = [
    ...packageRoots,
    ...packageRootsIn(path.join(projectRoot, ".pi", "npm", "node_modules")),
    ...packageRootsIn(path.join(userRoot, "npm", "node_modules")),
    ...packageRootsIn(path.join(os.homedir(), ".pi", "agent", "npm", "node_modules")),
    ...packageRootsIn(path.join(os.homedir(), ".pi", "npm", "node_modules")),
    ...packageRootsIn(path.join((() => { try { return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(); } catch { return ""; } })()))
  ];
  for (const root of [...packageRootsToScan, ...settingsPackageRoots(path.join(userRoot, "settings.json"), userRoot), ...settingsPackageRoots(path.join(projectRoot, ".pi", "settings.json"), projectRoot)]) {
    for (const agentRoot of packageAgentRoots(root)) roots.add(agentRoot);
  }
  return roots;
}
export function assertNoTargetAgentShadowing(targetRoot, controlPlane) {
  const names = new Set([FORGE_OWNER_AGENT, FORGE_REVIEW_AGENT]);
  const expected = new Set([controlPlane.forgeDock.agents.owner.path]);
  const targetOwner = path.resolve(targetRoot, "agents/forgedock-work-on-coordinator.md");
  const ownerSha = controlPlane.forgeDock.agents.owner.sha256;
  for (const root of targetAgentRoots(targetRoot)) for (const file of walk(root)) {
    if (expected.has(file)) continue;
    if (file === targetOwner && ownerSha === sha(fs.readFileSync(file))) continue;
    if (agentNames(file).some(name => names.has(name))) throw new Error(`Target agent definition shadows the parent control plane: ${file}`);
  }
}
export { FORGE_FILES, PI_FILES };
