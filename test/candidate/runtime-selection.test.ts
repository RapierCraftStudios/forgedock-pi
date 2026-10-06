import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helper = resolve("bin/forgedock-candidate.mjs");

async function writePiBinary(file: string, version: string): Promise<void> {
  await writeFile(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi\nexit 0\n`);
  await chmod(file, 0o755);
}

test("verify-install uses the manifest-pinned Pi executable instead of PATH", async () => {
  const root = await mkdtemp("/tmp/forgedock-runtime-pin-verify-");
  try {
    const installRoot = join(root, "install");
    const packageRoot = join(installRoot, "package");
    const subagentsRoot = join(installRoot, "pi-subagents");
    const piRoot = join(installRoot, "pi-agent");
    const staleBin = join(root, "stale-bin");
    const pinnedBin = join(root, "pinned-bin");
    await Promise.all([
      mkdir(join(packageRoot, "bin"), { recursive: true }),
      mkdir(subagentsRoot, { recursive: true }),
      mkdir(piRoot, { recursive: true }),
      mkdir(staleBin),
      mkdir(pinnedBin),
    ]);
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "forgedock-pi", version: "test" }));
    await writeFile(join(packageRoot, "bin", "forgedock-candidate.mjs"), "// isolated verification fixture\n");
    await writeFile(join(subagentsRoot, "package.json"), JSON.stringify({ name: "pi-subagents", version: "0.60.0" }));
    await writeFile(join(subagentsRoot, "index.ts"), "// isolated extension fixture\n");
    await writeFile(join(piRoot, "settings.json"), JSON.stringify({
      packages: ["../package"],
      extensions: ["../pi-subagents/index.ts"],
      skills: [],
      prompts: [],
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
    }));
    await writePiBinary(join(staleBin, "pi"), "0.85.1");
    await writePiBinary(join(pinnedBin, "pi"), "1.0.2");
    const piBinary = join(pinnedBin, "pi");
    const packageDigest = (await execFileAsync(process.execPath, [helper, "digest-tree", "--root", packageRoot])).stdout.trim();
    const piSubagentsDigest = (await execFileAsync(process.execPath, [helper, "digest-tree", "--root", subagentsRoot])).stdout.trim();
    await writeFile(join(installRoot, "manifest.json"), JSON.stringify({
      schema: "forgedock.candidate-install/v1",
      candidateCommit: "a".repeat(40),
      piSubagentsCommit: "b".repeat(40),
      packageDigest,
      piSubagentsDigest,
      piVersion: "1.0.2",
      requiredPiVersion: "1.0.2",
      piBinary,
      installRoot,
      packageRoot,
      piSubagentsRoot: subagentsRoot,
    }));

    const env = { PATH: `${staleBin}:${process.env.PATH ?? ""}` };
    const result = JSON.parse((await execFileAsync(process.execPath, [helper, "verify-install", "--install-root", installRoot], { env })).stdout) as { piBinary: string; piVersion: string };
    assert.equal(result.piBinary, piBinary);
    assert.equal(result.piVersion, "1.0.2");

    await assert.rejects(
      execFileAsync(process.execPath, [helper, "verify-install", "--install-root", installRoot], { env: { ...env, PI_SUBAGENT_PI_BINARY: join(staleBin, "pi") } }),
      /PI_SUBAGENT_PI_BINARY does not match the candidate install's pinned Pi executable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate runtime defaults to the previously qualified Pi version", async () => {
  const installer = await readFile(resolve("scripts/install-candidate.sh"), "utf8");
  const docs = await readFile(resolve("docs/candidate.md"), "utf8");
  assert.match(installer, /REQUIRED_PI_VERSION=\$\{PI_REQUIRED_VERSION:-1\.0\.2\}/);
  assert.match(installer, /PI_BINARY=\$\{PI_SUBAGENT_PI_BINARY:-/);
  assert.ok(installer.includes('PI_VERSION=$("$PI_BINARY" --version)'));
  assert.ok(installer.includes('"$PI_BINARY" install'));
  assert.ok(installer.includes('"piBinary": "$PI_BINARY"'));
  assert.ok(installer.includes('exec env PI_SUBAGENT_PI_BINARY="$PI_BINARY"'));
  assert.match(docs, /PI_REQUIRED_VERSION=1\.0\.2/);
  assert.match(docs, /parent and native children/);
});
