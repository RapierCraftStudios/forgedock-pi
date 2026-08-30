#!/usr/bin/env node

import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import YAML from "yaml";

function usage() {
  console.error(
    "usage: project-forge-config.mjs --input PATH --output PATH --child-root ABSOLUTE_PATH",
  );
  process.exit(2);
}

function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--input", "--output", "--child-root"].includes(key)) usage();
    const value = argv[++index];
    if (!value || value.startsWith("--")) usage();
    values[key.slice(2)] = value;
  }
  if (!values.input || !values.output || !values["child-root"]) usage();
  return values;
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`forge.yaml ${path} must be a mapping`);
  return value;
}

function string(value, path) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim())
    throw new Error(`forge.yaml ${path} must be a non-empty trimmed string`);
  return value;
}

function pathValue(value, path) {
  const result = string(value, path);
  if (result.includes("\0") || result.split(/[\\/]/).includes(".."))
    throw new Error(`forge.yaml ${path} contains traversal or NUL bytes`);
  return result.replaceAll("\\", "/");
}

function branch(value, path) {
  const result = string(value, path);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result) ||
    result.includes("..") ||
    result.includes("//") ||
    result.endsWith("/") ||
    result.endsWith(".")
  )
    throw new Error(`forge.yaml ${path} is not a safe branch name`);
  return result;
}

function scalar(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(scalar);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(scalar);
}

function validate(value) {
  if (!scalar(value)) throw new Error("forge.yaml document contains unsupported values");
  const root = object(value, "document");
  const project = object(root.project, "project");
  const paths = object(root.paths, "paths");
  const branches = object(root.branches, "branches");
  const agents = object(root.agents, "agents");
  const owner = string(project.owner, "project.owner");
  const repo = string(project.repo, "project.repo");
  if (!/^[^/\\s]+\/[^/\\s]+$/.test(`${owner}/${repo}`))
    throw new Error("forge.yaml project owner/repo is invalid");
  pathValue(paths.root, "paths.root");
  pathValue(paths.worktree_base, "paths.worktree_base");
  branch(branches.staging, "branches.staging");
  branch(branches.default, "branches.default");
  string(project.name, "project.name");
  string(agents.default_model, "agents.default_model");
  string(agents.subagent_model, "agents.subagent_model");
}

function contained(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

const options = args(process.argv.slice(2));
const childRoot = realpathSync(resolve(options["child-root"]));
const output = resolve(options.output);
const runtimeRoot = resolve(childRoot, ".forge", "runtime");
if (!contained(childRoot, runtimeRoot) || !contained(runtimeRoot, output))
  throw new Error("projection output must be inside the child runtime directory");
await mkdir(runtimeRoot, { recursive: true });
const runtimeParent = realpathSync(runtimeRoot);
if (!contained(childRoot, runtimeParent) || !contained(runtimeParent, output))
  throw new Error("projection output parent escapes the child root");

const value = YAML.parse(await readFile(resolve(options.input), "utf8"), {
  strict: true,
  uniqueKeys: true,
});
validate(value);
const projected = { ...value, paths: { ...value.paths } };
projected.paths.root = childRoot;
projected.paths.worktree_base = resolve(childRoot, ".forge", "runtime", "worktrees");
await mkdir(projected.paths.worktree_base, { recursive: true });
const flags = constants.O_NOFOLLOW === undefined
  ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
  : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
const handle = await open(output, flags, 0o600);
try {
  await handle.writeFile(YAML.stringify(projected), "utf8");
} finally {
  await handle.close();
}
console.log(output);
