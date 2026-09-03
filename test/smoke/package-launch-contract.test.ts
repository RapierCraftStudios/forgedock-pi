import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import { SUBAGENT_CAPABILITY_CEILING_VERSION } from "pi-subagents/capability-ceiling";

const execFileAsync = promisify(execFile);

async function registerPackedProjectPackage(project: string): Promise<void> {
  await mkdir(`${project}/.pi`, { recursive: true });
  await writeFile(
    `${project}/.pi/settings.json`,
    `${JSON.stringify({ packages: [`${project}/node_modules/forgedock-pi`] }, null, 2)}\n`,
  );
}

test("packed work-on agent resolves without a package tool ceiling", async () => {
  const root = process.cwd();
  const temp = await mkdtemp("/tmp/forgedock-package-canary-");
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
      { cwd: root, env: { ...process.env, PI_OFFLINE: "1" } },
    );
    const manifest = packedManifest(stdout);
    for (const required of [
      "agents/forgedock-work-on-coordinator.md",
      "skills/forgedock-work-on/SKILL.md",
      "skills/forgedock-orchestrate/SKILL.md",
      "skills/forgedock-review-pr/SKILL.md",
      "specs/original/commands/work-on.md",
    ])
      assert.ok(manifest.files.some((file) => file.path === required), required);
    assert.equal(
      manifest.files.some((file) => file.path === "agents/forgedock-reviewer.md"),
      false,
      "specialized reviewer profile must not be packaged",
    );

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
        `${temp}/${manifest.filename}`,
      ],
      { cwd: root, env: { ...process.env, PI_OFFLINE: "1" } },
    );
    await registerPackedProjectPackage(project);

    const packedAgent = await readFile(
      `${project}/node_modules/forgedock-pi/agents/forgedock-work-on-coordinator.md`,
      "utf8",
    );
    assert.match(packedAgent, /^timeoutMs: 2147483647$/m);
    assert.match(packedAgent, /^toolTimeoutMs: 3900000$/m);
    assert.doesNotMatch(packedAgent, /^tools:/m);

    const result = await resolveSubagentLaunchContract({
      agent: "forgedock-work-on-coordinator",
      cwd: project,
      context: "fresh",
      skill: false,
      output: false,
      artifacts: false,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok) return;
    assert.equal(result.contract.agent.source, "package");
    assert.equal(result.contract.tools.explicitAllowlist, false);
    assert.equal(result.contract.tools.fanoutAuthorized, true);
    assert.equal(result.contract.tools.configuredExtensions.length, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("host policy may still reject the packaged agent", async () => {
  const root = process.cwd();
  const temp = await mkdtemp("/tmp/forgedock-package-ceiling-");
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
      { cwd: root, env: { ...process.env, PI_OFFLINE: "1" } },
    );
    const manifest = packedManifest(stdout);
    const project = `${temp}/project`;
    await execFileAsync(
      "npm",
      ["install", "--prefix", project, "--no-save", "--package-lock=false", "--ignore-scripts", "--legacy-peer-deps", `${temp}/${manifest.filename}`],
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
        allowedAgents: ["delegate"],
        allowedTools: ["*"],
        denyExtensions: false,
        sources: ["host-policy-test"],
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
