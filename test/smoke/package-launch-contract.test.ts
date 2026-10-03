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

test("packed candidate exposes only thin resources and a bounded owner", async () => {
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
      "candidate/extension.ts",
      "candidate/skills/forgedock-work-on/SKILL.md",
      "candidate/skills/forgedock-orchestrate/SKILL.md",
      "candidate/skills/forgedock-review-pr/SKILL.md",
      "candidate/skills/forgedock-review-pr-staging/SKILL.md",
      "candidate/agents/forgedock-owner.md",
      "candidate/agents/forgedock-reviewer.md",
      "bin/forgedock-candidate.mjs",
      "scripts/install-candidate.sh",
    ]) assert.ok(manifest.files.some((file) => file.path === required), required);
    assert.equal(manifest.files.some((file) => file.path.startsWith("skills/")), false);
    assert.equal(manifest.files.some((file) => file.path.startsWith("specs/")), false);
    assert.equal(manifest.files.some((file) => file.path.startsWith("agents/")), false);

    const project = `${temp}/project`;
    await execFileAsync(
      "npm",
      ["install", "--prefix", project, "--no-save", "--package-lock=false", "--ignore-scripts", "--legacy-peer-deps", `${temp}/${manifest.filename}`],
      { cwd: root, env: { ...process.env, PI_OFFLINE: "1" } },
    );
    await registerPackedProjectPackage(project);

    const packedAgent = await readFile(
      `${project}/node_modules/forgedock-pi/candidate/agents/forgedock-owner.md`,
      "utf8",
    );
    assert.match(packedAgent, /^name: forgedock-owner$/m);
    assert.match(packedAgent, /^allowNestedSubagents: true$/m);
    assert.match(packedAgent, /^tools: read, grep, find, ls, bash, edit, write, subagent, forge_prepare_review, forge_run_check, forge_discover_review_records, forge_resolve_review_tracking, forge_recover_reviewer_publication, forge_publish_incomplete_review, forge_publish_adjudication$/m);
    assert.match(packedAgent, /^skillPath: \.\.\/skills$/m);

    const result = await resolveSubagentLaunchContract({
      agent: "forgedock-owner",
      agentScope: "project",
      cwd: project,
      context: "fresh",
      skill: false,
      output: false,
      artifacts: false,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok) return;
    assert.equal(result.contract.agent.source, "package");
    assert.equal(result.contract.tools.explicitAllowlist, true);
    assert.equal(result.contract.tools.fanoutAuthorized, true);
    assert.equal(result.contract.tools.configuredExtensions.length, 0);
    for (const tool of [
      "forge_prepare_review",
      "forge_run_check",
      "forge_discover_review_records",
      "forge_resolve_review_tracking",
      "forge_recover_reviewer_publication",
      "forge_publish_incomplete_review",
      "forge_publish_adjudication",
    ]) assert.ok(result.contract.tools.effectiveAllowlist.includes(tool), `owner tool allowlist includes ${tool}`);

    const reviewerResult = await resolveSubagentLaunchContract({
      agent: "forgedock-reviewer",
      agentScope: "project",
      cwd: project,
      context: "fresh",
      skill: false,
      output: false,
      artifacts: false,
    });
    assert.equal(reviewerResult.ok, true, reviewerResult.ok ? "" : reviewerResult.message);
    if (!reviewerResult.ok) return;
    assert.deepEqual(reviewerResult.contract.tools.effectiveAllowlist, ["read", "grep", "find", "ls", "forge_publish_reviewer"]);
    assert.equal(reviewerResult.contract.tools.fanoutAuthorized, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("host policy can reject the candidate owner without changing its package", async () => {
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
      agent: "forgedock-owner",
      agentScope: "project",
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
