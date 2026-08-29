import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import {
  SUBAGENT_CAPABILITY_CEILING_VERSION,
  type ResolvedSubagentCapabilityCeiling,
} from "pi-subagents/capability-ceiling";

const execFileAsync = promisify(execFile);
const COORDINATOR_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  "contact_supervisor",
  "subagent",
  "forge_prepare_lane_base",
  "forge_verify_lane_scope",
  "forgedock_preflight",
  "forgedock_github",
] as const;

async function registerPackedProjectPackage(project: string): Promise<void> {
  await mkdir(`${project}/.pi`, { recursive: true });
  await writeFile(
    `${project}/.pi/settings.json`,
    `${JSON.stringify({ packages: [`${project}/node_modules/forgedock-pi`] }, null, 2)}\n`,
  );
}

/**
 * Exercise the tarball that an operator installs, rather than the checkout's
 * source discovery paths. Preflight is the public pi-subagents launch contract
 * and does not require a model or spawn a child process.
 */
test("packed coordinator resolves nested reviewer capability and explicit tools", async () => {
  const root = process.cwd();
  const temp = await mkdtemp("/tmp/forgedock-package-canary-");
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
      { cwd: root, env: { ...process.env, PI_OFFLINE: "1" } },
    );
    const archive = packedArchive(stdout);
    assert.ok(archive);
    const packagedFiles = packedManifest(stdout).files.map((file) => file.path);
    for (const required of [
      "agents/forgedock-work-on-coordinator.md",
      "skills/forgedock-test-gate/SKILL.md",
      "skills/forgedock-issue/SKILL.md",
      "specs/original/commands/test-gate.md",
      "specs/original/commands/issue.md",
    ])
      assert.ok(packagedFiles.includes(required), `missing packed file ${required}`);
    const archivePath = `${temp}/${archive}`;
    const project = `${temp}/project`;
    await execFileAsync(
      "npm",
      [
        "install",
        "--prefix",
        project,
        "--no-save",
        "--package-lock=false",
        "--ignore-scripts",
        "--legacy-peer-deps",
        archivePath,
      ],
      { cwd: root, env: { ...process.env, PI_OFFLINE: "1" } },
    );

    await registerPackedProjectPackage(project);

    const ceiling: ResolvedSubagentCapabilityCeiling = {
      version: SUBAGENT_CAPABILITY_CEILING_VERSION,
      allowedAgents: ["forgedock-work-on-coordinator"],
      allowedTools: [...COORDINATOR_TOOLS],
      denyExtensions: false,
      sources: ["package-canary"],
    };
    const result = await resolveSubagentLaunchContract({
      agent: "forgedock-work-on-coordinator",
      cwd: project,
      context: "fresh",
      skill: false,
      output: false,
      artifacts: false,
      capabilityCeiling: ceiling,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok) return;
    assert.equal(result.contract.agent.source, "package");
    assert.ok(
      result.contract.agent.filePath.startsWith(`${project}/node_modules/forgedock-pi/`),
      result.contract.agent.filePath,
    );
    assert.equal(result.contract.tools.explicitAllowlist, true);
    assert.equal(result.contract.tools.fanoutAuthorized, true);
    assert.ok(result.contract.tools.effectiveAllowlist.includes("subagent"));
    assert.deepEqual(result.contract.tools.capabilityCeiling?.allowedAgents, [
      "forgedock-work-on-coordinator",
    ]);
    assert.deepEqual(
      new Set(result.contract.tools.capabilityCeiling?.allowedTools),
      new Set(COORDINATOR_TOOLS),
    );
    assert.equal(result.contract.tools.configuredExtensions.length, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("packed coordinator is rejected by preflight when its capability ceiling excludes it", async () => {
  const root = process.cwd();
  const temp = await mkdtemp("/tmp/forgedock-package-ceiling-");
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
      { cwd: root, env: { ...process.env, PI_OFFLINE: "1" } },
    );
    const archive = packedArchive(stdout);
    assert.ok(archive);
    const archivePath = `${temp}/${archive}`;
    const project = `${temp}/project`;
    await execFileAsync(
      "npm",
      ["install", "--prefix", project, "--no-save", "--package-lock=false", "--ignore-scripts", "--legacy-peer-deps", archivePath],
      { cwd: root, env: { ...process.env, PI_OFFLINE: "1" } },
    );
    await registerPackedProjectPackage(project);
    const result = await resolveSubagentLaunchContract({
      agent: "forgedock-work-on-coordinator",
      cwd: project,
      context: "fresh",
      skill: false,
      output: false,
      artifacts: false,
      capabilityCeiling: {
        version: SUBAGENT_CAPABILITY_CEILING_VERSION,
        allowedAgents: ["forge-review-security"],
        allowedTools: [...COORDINATOR_TOOLS],
        denyExtensions: false,
        sources: ["package-canary"],
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "restricted_agent");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

function packedManifest(stdout: string): {
  filename: string;
  files: Array<{ path: string }>;
} {
  const parsed = JSON.parse(stdout) as
    | Array<{ filename?: unknown; files?: Array<{ path: string }> }>
    | { "forgedock-pi": { filename?: unknown; files?: Array<{ path: string }> } };
  const value = Array.isArray(parsed) ? parsed[0] : parsed["forgedock-pi"];
  assert.equal(typeof value?.filename, "string");
  assert.ok(value?.files);
  return value as { filename: string; files: Array<{ path: string }> };
}

function packedArchive(stdout: string): string {
  return packedManifest(stdout).filename;
}
