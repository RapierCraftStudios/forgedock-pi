import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helper = resolve("bin/forgedock-candidate.mjs");

const fakeGh = `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const stateFile = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
if (args[0] !== "api") process.exit(2);
if (args.includes("--method") && args[args.indexOf("--method") + 1] === "POST") {
  const field = args.find((arg) => arg.startsWith("body=@"));
  const body = readFileSync(field.slice("body=@".length), "utf8");
  writeFileSync(stateFile, JSON.stringify({ id: 77, body, html_url: "https://github.com/example/product/pull/7#issuecomment-77" }));
  process.exit(1);
}
if (args.some((arg) => arg.includes("issues/comments/77"))) {
  process.stdout.write(JSON.stringify(state));
} else if (args.includes("--paginate")) {
  process.stdout.write(JSON.stringify(state ? [[state]] : [[]]));
} else {
  process.exit(2);
}
`;

test("publication recovers an ambiguous create from the stable saved marker", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-publication-");
  try {
    const fakeBin = join(root, "bin");
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, "gh"), fakeGh, { mode: 0o755 });
    const body = join(root, "body.md");
    const report = join(root, "report.md");
    const state = join(root, "gh-state.json");
    const head = "a".repeat(40);
    const baseSha = "b".repeat(40);
    await writeFile(body, "### Scope and decisions considered\nThe exact frozen patch was reviewed.\n\n### Evidence and findings\nNo blocking finding was reproduced.\n\n### Verification limitations\nThe disposable publication boundary was used.\n\n### Recommendation\nApprove after parent readback.\n");
    await writeFile(state, JSON.stringify({ id: 9, body: `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ v: 1, repository: "example/product", pullRequest: 7, head, baseSha, role: "correctness", baseRef: "integration" })} -->\nold report\n`, html_url: "https://github.com/example/product/pull/7#issuecomment-9" }));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "reviewer", "--repo", "example/product", "--pr", "7", "--head", head, "--base-ref", "integration", "--base-sha", baseSha, "--role", "correctness", "--report-id", "report-new", "--body-file", body, "--report-file", report, "--publish"], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_GH_STATE: state } })).stdout) as { publication: string; reconciliation: string; url: string };
    assert.match(await readFile(report, "utf8"), /reportId/);
    assert.equal(result.publication, "published");
    assert.equal(result.reconciliation, "ambiguous-create-reconciled");
    assert.equal(result.url, "https://github.com/example/product/pull/7#issuecomment-77");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-head staging gate publication uses an explicit supersession marker", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-gate-publication-");
  try {
    const fakeBin = join(root, "bin");
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, "gh"), fakeGh, { mode: 0o755 });
    const body = join(root, "body.md");
    const report = join(root, "report.md");
    const state = join(root, "gh-state.json");
    const head = "a".repeat(40);
    const baseSha = "b".repeat(40);
    await writeFile(body, "The exact staging gate evidence remains blocked by a required runtime check.");
    await writeFile(state, JSON.stringify({ id: 9, body: `<!-- FORGE:CANDIDATE:STAGING_GATE ${JSON.stringify({ v: 1, kind: "STAGING_GATE", repository: "example/product", pullRequest: 7, head, baseSha, baseRef: "main", gate: "FAIL" })} -->\nold gate\n`, html_url: "https://github.com/example/product/pull/7#issuecomment-9" }));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "--kind", "STAGING_GATE", "--repo", "example/product", "--pr", "7", "--head", head, "--base-ref", "main", "--base-sha", baseSha, "--gate", "FAIL", "--supersedes", "https://github.com/example/product/pull/7#issuecomment-9", "--body-file", body, "--report-file", report, "--publish"], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_GH_STATE: state } })).stdout) as { publication: string; url: string };
    assert.equal(result.publication, "published");
    assert.equal(result.url, "https://github.com/example/product/pull/7#issuecomment-77");
    assert.match(await readFile(report, "utf8"), /supersedes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewer reports retain structured observations for parent adjudication", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-observation-");
  try {
    const body = join(root, "body.md");
    const report = join(root, "report.md");
    const observations = join(root, "observations.json");
    await writeFile(body, "### Scope and decisions considered\nThe exact frozen patch was reviewed.\n\n### Evidence and findings\nOne concrete observation is recorded below.\n\n### Verification limitations\nThe disposable publication boundary was used.\n\n### Recommendation\nFollow up after parent adjudication.\n");
    await writeFile(observations, JSON.stringify([{ id: "correctness:F1", kind: "verification-authority-prerequisite", summary: "Runtime proof is absent", affectedBehavior: "Promotion evidence", location: "policy:required-check", evidence: ["The required check is skipped."], trigger: "The check conclusion is SKIPPED.", consequence: "Promotion cannot claim executed proof.", whyThisChange: "The review evaluates promotion readiness.", stage: "before promotion", proposedDisposition: "EVIDENCE/AUTHORITY PREREQUISITE" }]));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "reviewer", "--repo", "example/product", "--pr", "7", "--head", "a".repeat(40), "--base-ref", "main", "--base-sha", "b".repeat(40), "--role", "correctness", "--observations-file", observations, "--body-file", body, "--report-file", report], { env: process.env })).stdout) as { publication: string };
    assert.equal(result.publication, "saved");
    const reportText = await readFile(report, "utf8");
    assert.match(reportText, /FORGE:REVIEW_OBSERVATIONS/);
    assert.match(reportText, /correctness:F1/);
    assert.match(reportText, /Runtime proof is absent/);
    assert.match(reportText, /The required check is skipped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacement and rollback preserve the exact prior registration", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-replace-");
  try {
    const oldPackage = join(root, "old-package");
    const configDir = join(root, "pi");
    await mkdir(join(oldPackage, "candidate", "skills"), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await cp("package.json", join(oldPackage, "package.json"));
    await cp("candidate", join(oldPackage, "candidate"), { recursive: true });
    const env = { ...process.env, PI_CODING_AGENT_DIR: configDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    await execFileAsync("pi", ["install", oldPackage, "--approve"], { env });
    const before = await readFile(join(configDir, "settings.json"), "utf8");
    const replacement = JSON.parse((await execFileAsync("node", [helper, "replace", "--config-dir", configDir, "--old-source", "../old-package", "--candidate-source", resolve(".")], { env })).stdout) as { settingsBackup: string; status: string };
    assert.equal(replacement.status, "replaced");
    const rolledBack = JSON.parse((await execFileAsync("node", [helper, "rollback", "--rollback", resolve(replacement.settingsBackup, "..")], { env })).stdout) as { status: string };
    assert.equal(rolledBack.status, "rolled-back");
    assert.equal(await readFile(join(configDir, "settings.json"), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
