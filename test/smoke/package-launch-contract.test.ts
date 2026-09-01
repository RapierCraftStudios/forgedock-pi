import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
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
] as const;
const BUILDER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
const REVIEWER_TOOLS = ["read", "grep", "find", "ls"] as const;

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
test("an installed package materializes helpers at target runtime paths", async () => {
  const root = process.cwd();
  const temp = await mkdtemp("/tmp/forgedock-runtime-helper-canary-");
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
      { cwd: root, env: { ...process.env, PI_OFFLINE: "1" } },
    );
    const archivePath = `${temp}/${packedArchive(stdout)}`;
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
    const installed = (await import(
      pathToFileURL(
        `${project}/node_modules/forgedock-pi/src/runtime/materialize.ts`,

      ).href
    )) as { materializeForgeRuntimeHelpers: (target: string) => Promise<void> };
    await installed.materializeForgeRuntimeHelpers(project);

    for (const helper of [
      "bin/engine/admission.mjs",
      "bin/engine/invariants.mjs",
      "bin/engine/orchestrate-canary.mjs",
      "bin/engine/resolve.mjs",
      "bin/labels.json",
      "scripts/classify-lane.sh",
      "scripts/code-index.sh",
      "scripts/derive-finding-milestone.sh",
      "scripts/design-system-lint.mjs",
      "scripts/doctor-pipeline-state.sh",
      "scripts/eval-gate-scorecard.mjs",
      "scripts/extract-affected-files.sh",
      "scripts/flaky-quarantine.sh",
      "scripts/graph-query.sh",
      "scripts/issue-dedup.sh",
      "scripts/select-fix-targets.sh",
      "scripts/severity-to-priority.sh",
      "scripts/transition-label.sh",
      "scripts/validate-spec-graph.sh",
      "scripts/verify-env-vars.sh",
      "scripts/verify-host-headers.sh",
      "scripts/verify-route-registration.sh",
      "scripts/verify-sops-chain.sh",
      "scripts/worktree-lifecycle.sh",
    ]) {
      assert.equal(
        await readFile(`${project}/${helper}`, "utf8"),
        await readFile(`${project}/node_modules/forgedock-pi/specs/original/${helper}`, "utf8"),
        helper,
      );
    }
    const { stdout: canary } = await execFileAsync(
      "node",
      ["bin/engine/orchestrate-canary.mjs", "priority", "P1", "true", "3", "0"],
      { cwd: project },
    );
    assert.match(canary, /true/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("packed coordinator, fresh builder, and reviewer resolve with bounded tools", async () => {
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
      "agents/forgedock-builder.md",
      "agents/forgedock-reviewer.md",
      "skills/forgedock-test-gate/SKILL.md",
      "skills/forgedock-issue/SKILL.md",
      "specs/original/commands/test-gate.md",
      "specs/original/commands/issue.md",
      "specs/original/bin/orchestrate-preflight.mjs",
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

    const builderResult = await resolveSubagentLaunchContract({
      agent: "forgedock-builder",
      cwd: project,
      context: "fresh",
      skill: false,
      output: false,
      artifacts: false,
      capabilityCeiling: {
        version: SUBAGENT_CAPABILITY_CEILING_VERSION,
        allowedAgents: ["forgedock-builder"],
        allowedTools: [...BUILDER_TOOLS],
        denyExtensions: false,
        sources: ["package-canary"],
      },
    });
    assert.equal(builderResult.ok, true, builderResult.ok ? "" : builderResult.message);
    if (!builderResult.ok) return;
    assert.equal(builderResult.contract.agent.source, "package");
    assert.equal(builderResult.contract.tools.explicitAllowlist, true);
    assert.equal(builderResult.contract.tools.fanoutAuthorized, false);
    for (const actual of [
      builderResult.contract.tools.requestedBuiltin,
      builderResult.contract.tools.declaredBuiltin,
      builderResult.contract.tools.effectiveAllowlist,
    ])
      assert.deepEqual(new Set(actual), new Set(BUILDER_TOOLS));
    assert.equal(builderResult.contract.tools.configuredExtensions.length, 0);
    for (const forbidden of ["contact_supervisor", "subagent"])
      assert.equal(builderResult.contract.tools.effectiveAllowlist.includes(forbidden), false);

    const reviewerResult = await resolveSubagentLaunchContract({
      agent: "forgedock-reviewer",
      cwd: project,
      context: "fresh",
      skill: false,
      output: false,
      artifacts: false,
      capabilityCeiling: {
        version: SUBAGENT_CAPABILITY_CEILING_VERSION,
        allowedAgents: ["forgedock-reviewer"],
        allowedTools: [...REVIEWER_TOOLS],
        denyExtensions: false,
        sources: ["package-canary"],
      },
    });
    assert.equal(
      reviewerResult.ok,
      true,
      reviewerResult.ok ? "" : reviewerResult.message,
    );
    if (!reviewerResult.ok) return;
    assert.equal(reviewerResult.contract.agent.source, "package");
    assert.equal(reviewerResult.contract.tools.explicitAllowlist, true);
    assert.equal(reviewerResult.contract.tools.fanoutAuthorized, false);
    for (const actual of [
      reviewerResult.contract.tools.requestedBuiltin,
      reviewerResult.contract.tools.declaredBuiltin,
      reviewerResult.contract.tools.effectiveAllowlist,
    ])
      assert.deepEqual(new Set(actual), new Set(REVIEWER_TOOLS));
    assert.equal(reviewerResult.contract.tools.configuredExtensions.length, 0);
    for (const forbidden of ["bash", "edit", "write", "subagent"])
      assert.equal(
        reviewerResult.contract.tools.effectiveAllowlist.includes(forbidden),
        false,
      );
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
