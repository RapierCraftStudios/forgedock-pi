import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);
const launcher = resolve("scripts/launch-candidate.sh");

async function createFixture(root: string, modelPresent: boolean) {
  const install = join(root, "install");
  const repo = join(root, "probe-repo");
  const piAgent = join(install, "pi-agent");
  const fakePackage = join(install, "package");
  const staleBin = join(root, "stale-bin");
  const pinnedBin = join(root, "pinned-bin");
  await Promise.all([
    mkdir(piAgent, { recursive: true }),
    mkdir(join(fakePackage, "bin"), { recursive: true }),
    mkdir(join(install, "sessions"), { recursive: true }),
    mkdir(repo),
    mkdir(staleBin),
    mkdir(pinnedBin),
  ]);
  await writeFile(join(piAgent, "settings.json"), "{}\n");
  await writeFile(join(install, "manifest.json"), JSON.stringify({
    piVersion: "1.0.2",
    piBinary: join(pinnedBin, "pi-selected"),
  }));
  await writeFile(join(fakePackage, "bin", "forgedock-candidate.mjs"), `
const [command] = process.argv.slice(2);
if (command === "verify-install") process.exit(0);
if (command === "config") {
  process.stdout.write(JSON.stringify({
    ownerModel: "openai-codex/gpt-6-luna",
    ownerThinking: "max",
    review: { reviewerThinking: "max" }
  }));
  process.exit(0);
}
process.exit(2);
`);
  const piProgram = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--version" ]]; then printf '%s\\n' "\${PI_FAKE_VERSION:-1.0.2}"; exit 0; fi
if [[ " $* " == *" --list-models "* ]]; then
  printf '%s\\n' 'provider      model         context  max-out  thinking  images'
  if [[ "$PI_MODEL_PRESENT" == "1" ]]; then
    printf '%s\\n' 'openai-codex  gpt-6-luna    272K     128K     yes       yes'
  else
    printf '%s\\n' 'openai-codex  gpt-5.6-luna  272K     128K     yes       yes'
  fi
  printf '%s\\n' "$*" > "$PI_MODEL_PREFLIGHT_CAPTURE"
  exit 0
fi
printf '%s\\n' "$0" > "$PI_PARENT_BINARY_CAPTURE"
printf '%s\\n' "$PI_SUBAGENT_PI_BINARY" > "$PI_CHILD_BINARY_CAPTURE"
printf '%s\\n' "$*" > "$PI_PARENT_ARGS_CAPTURE"
`;
  const selectedPi = join(pinnedBin, "pi-selected");
  const stalePi = join(staleBin, "pi");
  await writeFile(selectedPi, piProgram);
  await chmod(selectedPi, 0o755);
  await writeFile(stalePi, "#!/bin/sh\nprintf '0.85.1\\n'\n");
  await chmod(stalePi, 0o755);
  return { install, repo, selectedPi, staleBin, modelPresent };
}

function probeEnv(root: string, fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    PATH: `${fixture.staleBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: root,
    PI_MODEL_PRESENT: fixture.modelPresent ? "1" : "0",
    PI_MODEL_PREFLIGHT_CAPTURE: join(root, "model-preflight-args.txt"),
    PI_PARENT_BINARY_CAPTURE: join(root, "parent-binary.txt"),
    PI_CHILD_BINARY_CAPTURE: join(root, "child-binary.txt"),
    PI_PARENT_ARGS_CAPTURE: join(root, "parent-args.txt"),
  };
}

test("candidate launcher pins one Pi 1.0.2 executable for parent and native children", async () => {
  const root = await mkdtemp("/tmp/forgedock-runtime-launch-");
  try {
    const fixture = await createFixture(root, true);
    const env = probeEnv(root, fixture);
    await execFileAsync("bash", [launcher, "--install-root", fixture.install, "--repo", fixture.repo], { env });
    assert.equal((await readFile(join(root, "parent-binary.txt"), "utf8")).trim(), fixture.selectedPi);
    assert.equal((await readFile(join(root, "child-binary.txt"), "utf8")).trim(), fixture.selectedPi);
    const parentArgs = await readFile(join(root, "parent-args.txt"), "utf8");
    assert.match(parentArgs, /--model openai-codex\/gpt-6-luna/);
    assert.match(parentArgs, /--thinking max/);
    const modelProbe = await readFile(join(root, "model-preflight-args.txt"), "utf8");
    assert.match(modelProbe, /--model openai-codex\/gpt-6-luna/);
    assert.match(modelProbe, /--thinking max/);
    assert.match(modelProbe, /--list-models openai-codex\/gpt-6-luna/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate launcher refuses a historical Pi runtime before opening the parent", async () => {
  const root = await mkdtemp("/tmp/forgedock-runtime-version-gate-");
  try {
    const fixture = await createFixture(root, true);
    const error = await execFileAsync("bash", [launcher, "--install-root", fixture.install, "--repo", fixture.repo], { env: { ...probeEnv(root, fixture), PI_FAKE_VERSION: "0.85.1" } }).then(
      () => null,
      (value: unknown) => value as Error & { stderr?: string },
    );
    assert.ok(error, "candidate must reject a Pi executable that differs from its manifest pin");
    assert.match(error.stderr ?? error.message, /Pinned Pi runtime is 0\.85\.1, expected installed version 1\.0\.2/);
    await assert.rejects(readFile(join(root, "model-preflight-args.txt"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(root, "parent-binary.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate launcher fails model registry preflight before starting the parent", async () => {
  const root = await mkdtemp("/tmp/forgedock-runtime-model-gate-");
  try {
    const fixture = await createFixture(root, false);
    const error = await execFileAsync("bash", [launcher, "--install-root", fixture.install, "--repo", fixture.repo], { env: probeEnv(root, fixture) }).then(
      () => null,
      (value: unknown) => value as Error & { stderr?: string },
    );
    assert.ok(error, "missing registry model must stop candidate startup");
    assert.match(error.stderr ?? error.message, /model registry does not resolve owner\/reviewer model openai-codex\/gpt-6-luna:max/);
    await assert.rejects(readFile(join(root, "parent-binary.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate launch and install defaults pin the qualified runtime", async () => {
  const installer = await readFile(resolve("scripts/install-candidate.sh"), "utf8");
  const docs = await readFile(resolve("docs/candidate.md"), "utf8");
  assert.match(installer, /REQUIRED_PI_VERSION=\$\{PI_REQUIRED_VERSION:-1\.0\.2\}/);
  assert.match(installer, /PI_BINARY=\$\{PI_SUBAGENT_PI_BINARY:-\$\(command -v pi \|\| true\)\}/);
  assert.match(docs, /PI_REQUIRED_VERSION=1\.0\.2/);
});
