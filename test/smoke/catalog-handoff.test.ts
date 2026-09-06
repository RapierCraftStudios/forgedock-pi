import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";

const exec = promisify(execFile);

test("documented child launch carries a prepared catalog absent from its clean target", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-catalog-test-"));
  const target = join(root, "target");
  const snapshot = join(root, "prepared-verification.json");
  try {
    await mkdir(target);
    await exec("git", ["init", "-q"], { cwd: target });
    await writeFile(join(target, "forge.yaml"), "verification:\n  commands: {}\n");
    await exec("git", ["add", "forge.yaml"], { cwd: target });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "target"], { cwd: target });
    const catalog = { commands: { api: { test: "npm run test:api" } }, discovery: {} };
    const bytes = JSON.stringify(catalog);
    await writeFile(snapshot, bytes, { mode: 0o400 });
    const digest = createHash("sha256").update(bytes).digest("hex");
    const spec = await readFile("specs/pi-adapter.md", "utf8");
    const item = spec.match(/```js\n([\s\S]*?)\n```/)?.[1];
    assert.ok(item);
    const launch = vm.runInNewContext(`(${item})`, {
      issue: { number: 42, targetBase: target }, configuredModel: "test/model",
      verificationCatalogPath: snapshot, verificationCatalogSha256: digest,
    }) as { task: string; cwd: string; output: boolean; artifacts: boolean };
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
    assert.equal(await readFile(join(target, "forge.yaml"), "utf8"), "verification:\n  commands: {}\n");
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
  assert.match(coordinator, /read-only catalog.*digest/s);
});
