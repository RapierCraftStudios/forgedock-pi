import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
const dispatch = await import(new URL("../../specs/helpers/dispatch.mjs", import.meta.url).href);
const { prepareBatch } = dispatch;
const installedForgeDockRoot = process.env.FORGEDOCK_PARENT_PACKAGE_ROOT ?? fileURLToPath(new URL("../..", import.meta.url));
const installedPiSubagentsRoot = process.env.PI_SUBAGENTS_PARENT_PACKAGE_ROOT ?? realpathSync(join(fileURLToPath(new URL("../..", import.meta.url)), "node_modules/pi-subagents"));
const controlPlane = dispatch.createControlPlaneDescriptor({ forgeDockRoot: installedForgeDockRoot, piSubagentsRoot: installedPiSubagentsRoot });

const exec = promisify(execFile);

test("documented child launch carries a prepared catalog absent from its clean target", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-catalog-test-"));
  const target = join(root, "target");
  const snapshot = join(root, "prepared-verification.json");
  try {
    await mkdir(target);
    await exec("git", ["init", "-q"], { cwd: target });
    await exec("git", ["remote", "add", "origin", "https://github.com/example/project.git"], { cwd: target });
    const config = 'project: {owner: example, repo: project}\nagents: {subagent_model: "test/model"}\nverification:\n  commands: {}\n';
    await writeFile(join(target, "forge.yaml"), config);
    await exec("git", ["add", "forge.yaml"], { cwd: target });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "target"], { cwd: target });
    const catalog = { commands: { api: { test: "npm run test:api" } }, discovery: {} };
    const bytes = JSON.stringify(catalog);
    await writeFile(snapshot, bytes, { mode: 0o400 });
    const digest = createHash("sha256").update(bytes).digest("hex");
    const contract = dispatch.createIssueContract(42, [
      { id: "source-behavior", textHash: `sha256:${"1".repeat(64)}`, proofType: "behavioral", affectedBoundaries: ["src/example.ts"] },
    ]);
    const contractBytes = `${JSON.stringify(contract)}\n`;
    const contractPath = join(root, "issue-42-contract.json");
    await writeFile(contractPath, contractBytes, { mode: 0o400 });
    const contractDescriptor = { path: contractPath, sha256: createHash("sha256").update(contractBytes).digest("hex") };
    const prepared = prepareBatch({ activeOwners: 1, launchAllowance: 8, requestStartedAt: "2026-01-01T00:00:00Z", controlPlane,
      verification: { path: snapshot, sha256: digest }, issues: [{ number: 42, target: "staging", baseCwd: target, predecessors: [], contract: contractDescriptor }] }, join(root, "prepared"), target);
    const script = await readFile(prepared.request.workflowScriptPath, "utf8");
    const graph = JSON.parse(script.match(/^const issueGraph=(.+);$/m)![1]!);
    const launch = graph[0].launch as { task: string; cwd: string; output: boolean; artifacts: boolean };
    assert.equal(launch.cwd, target);
    assert.equal(launch.output, false, "the recipe reuses native artifacts rather than extra named output");
    assert.equal(launch.artifacts, true);
    assert.ok(launch.task.startsWith("42 --under-orchestration\n"));
    const payload = launch.task.split("Prepared verification catalog: ")[1];
    assert.ok(payload, "task must carry the explicit parent input, not assume untracked config was cloned");
    const input = JSON.parse(payload) as { path: string; sha256: string };
    const received = await readFile(input.path);
    assert.equal(createHash("sha256").update(received).digest("hex"), input.sha256);
    assert.equal(JSON.parse(received.toString()).commands.api.test, "npm run test:api");
    assert.equal(await readFile(join(target, "forge.yaml"), "utf8"), config);
    assert.equal((await exec("git", ["status", "--porcelain"], { cwd: target })).stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog handoff states precedence and does not grant source mutation or secret disclosure", async () => {
  const verification = await readFile("specs/verification.md", "utf8");
  const coordinator = await readFile("agents/forgedock-work-on-coordinator.md", "utf8");
  assert.match(verification, /snapshot.*authoritative.*route start/s);
  assert.match(verification, /explicit.*overrides/);
  assert.match(verification, /Do not serialize.*secrets/s);
  assert.match(verification, /missing.*mismatch.*before.*execut/s);
  assert.match(coordinator, /bound execution input.*dispatch\.mjs context/s);
  assert.match(coordinator, /model and remediation limit are authoritative/);
});
