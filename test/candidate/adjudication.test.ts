import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helper = resolve("bin/forgedock-candidate.mjs");

const fakeGh = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const statePath = process.env.FAKE_ADJUDICATION_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const args = process.argv.slice(2);
state.calls = [...(state.calls ?? []), args];
const output = (value, code = 0) => { writeFileSync(statePath, JSON.stringify(state)); process.stdout.write(JSON.stringify(value)); process.exit(code); };
if (args[0] === "pr" && args[1] === "view") output(state.pull);
if (args[0] !== "api") process.exit(2);
const endpoint = args.find((value) => value.startsWith("repos/") || value.startsWith("search/")) ?? "";
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
if (endpoint.includes("/issues/7/comments")) {
  if (method === "POST") {
    const bodyArg = args.find((value) => value.startsWith("body=@"));
    const body = readFileSync(bodyArg.slice("body=@".length), "utf8");
    const comment = { id: (state.nextComment ?? 100), body, html_url: "https://github.com/example/product/pull/7#issuecomment-" + (state.nextComment ?? 100) };
    state.nextComment = (state.nextComment ?? 100) + 1;
    state.comments = [...(state.comments ?? []), comment];
    output(comment, state.commentPostFails ? 1 : 0);
  }
  output([state.comments ?? []]);
}
if (endpoint.includes("/issues/comments/")) {
  const id = Number(endpoint.split("/").at(-1));
  const comment = (state.comments ?? []).find((entry) => entry.id === id);
  if (!comment) process.exit(1);
  output(comment);
}
if (endpoint.startsWith("search/issues?")) {
  const query = decodeURIComponent(endpoint.split("?q=")[1]?.split("&")[0] ?? "").toLowerCase();
  const items = state.omitSearchIssues ? [] : (state.issues ?? []).filter((issue) => /backup|receipt|storage/.test((issue.title + " " + issue.body).toLowerCase()) || query.includes("unrelated"));
  output({ items });
}
if (endpoint.includes("/issues?")) output([state.issues ?? []]);
if (endpoint.endsWith("/issues") && method === "POST") {
  const titleArg = args.find((value) => value.startsWith("title="));
  const bodyArg = args.find((value) => value.startsWith("body=@"));
  const number = state.nextIssue ?? 401;
  const issue = { number, title: titleArg.slice("title=".length), body: readFileSync(bodyArg.slice("body=@".length), "utf8"), state: "open", labels: args.filter((value) => value.startsWith("labels[]=")).map((value) => value.slice("labels[]=".length)), html_url: "https://github.com/example/product/issues/" + number };
  state.nextIssue = number + 1;
  state.issues = [...(state.issues ?? []), issue];
  output(issue, state.issuePostFails ? 1 : 0);
}
if (/\\/issues\\/\\d+$/.test(endpoint)) {
  if (state.issueReadFails) process.exit(1);
  const number = Number(endpoint.split("/").at(-1));
  const issue = (state.issues ?? []).find((entry) => entry.number === number);
  if (!issue) process.exit(1);
  output(issue);
}
process.exit(2);
`;

const config = `
project:
  owner: example
  repo: product
paths:
  root: .
branches:
  default: main
  staging: integration
  feature_pattern: feature/{slug}
agents:
  subagent_model: provider/model
orchestration:
  max_concurrent: 2
review:
  reviewer_timeout_ms: 1000
  panel_timeout_ms: 4000
  publication_timeout_ms: 1000
  max_concurrent: 2
`;

async function fixture(publish: boolean) {
  const root = await mkdtemp("/tmp/forgedock-adjudication-repo-");
  const bin = await mkdtemp("/tmp/forgedock-adjudication-bin-");
  const reviewRoot = await mkdtemp("/tmp/forgedock-adjudication-review-");
  const statePath = join(root, "gh-state.json");
  await writeFile(join(bin, "gh"), fakeGh, { mode: 0o755 });
  await writeFile(join(root, "README.md"), "base\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
  const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await writeFile(join(root, "forge.yaml"), config);
  await execFileAsync("git", ["add", "forge.yaml"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "config"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await execFileAsync("git", ["branch", "-M", "integration"], { cwd: root });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/integration", base], { cwd: root });
  await writeFile(statePath, JSON.stringify({
    pull: { headRefOid: head, baseRefName: "integration", baseRefOid: base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", state: "OPEN", isDraft: false, url: "https://github.com/example/product/pull/7" },
    comments: [],
    issues: [],
    nextComment: 100,
    nextIssue: 401,
    issuePostFails: true,
  }));
  const roles = ["correctness", "security"];
  const observations: Record<string, any[]> = {
    correctness: [{ id: "correctness:F1", kind: "verification-authority-prerequisite", summary: "Backup rehearsal proof is absent", affectedBehavior: "Promotion backup safety", location: "docs/backup.md", evidence: ["No exact-head rehearsal receipt exists."], trigger: "The promotion has no independent backup rehearsal receipt.", consequence: "The protected promotion cannot claim the backup obligation is discharged.", whyThisChange: "The changed storage path is part of this promotion.", stage: "before promotion", proposedDisposition: "NON-BLOCKING FOLLOW-UP" }],
    security: [{ id: "security:F1", kind: "verification-authority-prerequisite", summary: "Backup rehearsal proof is absent", affectedBehavior: "Promotion backup safety", location: "docs/backup.md", evidence: ["The same missing receipt is visible at the protected boundary."], trigger: "The exact-head rehearsal receipt is unavailable.", consequence: "The evidence gap remains until the rehearsal is run.", whyThisChange: "The promotion changes the storage boundary.", stage: "before promotion", proposedDisposition: "NON-BLOCKING FOLLOW-UP" }],
  };
  for (const role of roles) {
    const identity = { v: 1, kind: "REVIEW", repository: "example/product", pullRequest: 7, head, baseSha: base, role, reportId: `${role}-attempt`, baseRef: "integration" };
    const observationsMarker = `<!-- FORGE:REVIEW_OBSERVATIONS ${JSON.stringify(observations[role])} -->`;
    const body = `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify(identity)} -->\n${observationsMarker}\n## ForgeDock review\n\n### Scope and decisions considered\nThe exact patch was reviewed.\n\n### Evidence and findings\nThe structured observation is recorded.\n\n### Verification limitations\nNo independent rehearsal was available.\n\n### Recommendation\nFollow up after the parent decision.\n`;
    await writeFile(join(reviewRoot, `${role}.report.md`), body);
  }
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (publish) {
    state.comments = [];
    for (const [index, role] of roles.entries()) state.comments.push({ id: 11 + index, body: await readFile(join(reviewRoot, `${role}.report.md`), "utf8"), html_url: `https://github.com/example/product/pull/7#issuecomment-${11 + index}` });
    await writeFile(statePath, JSON.stringify(state));
  }
  await writeFile(join(reviewRoot, "review.json"), JSON.stringify({ schema: "forgedock.candidate-review/v1", artifactRoot: reviewRoot, artifactKey: "attempt-1", repository: "example/product", pullRequest: 7, head, baseRef: "integration", baseSha: base, sourceRoot: root, configRoot: root, publish, roles }));
  return { root, bin, reviewRoot, statePath, head, base, roles };
}

function inputFor(f: Awaited<ReturnType<typeof fixture>>, publish: boolean, allowIssueWrites: boolean): any {
  return {
    schema: "forgedock.candidate-adjudication/v1",
    repository: "example/product",
    pullRequest: 7,
    head: f.head,
    baseRef: "integration",
    baseSha: f.base,
    mode: "standard",
    reviewRoot: f.reviewRoot,
    artifactKey: "attempt-1",
    verdict: "APPROVE_WITH_FOLLOW_UP",
    gate: "PASS",
    decisions: [{
      id: "C1",
      sourceObservationIds: ["correctness:F1", "security:F1"],
      disposition: "NON-BLOCKING FOLLOW-UP",
      resolution: "duplicate",
      summary: "Backup rehearsal proof is absent",
      rationale: "Both roles describe the same missing runtime proof; it is useful follow-up work and does not block this standard review stage.",
      evidence: ["Both reports cite the same missing exact-head rehearsal receipt."],
      stage: "before promotion",
      blocksCurrentStage: false,
      tracking: {
        status: "new",
        draft: {
          title: "Add exact-head backup rehearsal proof",
          problem: "The promotion lacks an independently captured backup rehearsal receipt.",
          rootCause: "The changed storage boundary has no durable rehearsal evidence.",
          affectedFiles: ["docs/backup.md"],
          expectedBehavior: "A bounded rehearsal produces a durable receipt for the protected promotion.",
          acceptanceCriteria: ["Run the rehearsal against the exact promotion identity.", "Publish a read-back receipt and focused regression proof."],
          evidence: ["correctness:F1 and security:F1 cite the same missing receipt."],
          stage: "before promotion",
          sourceLinks: ["https://github.com/example/product/pull/7"],
          labels: ["workflow:gated"],
        },
      },
    }],
    checks: [{ name: "Shadow Database Migration Dry Run", required: true, conclusion: "skipped", executedProof: false, executedProofRequired: false, policyAccepted: true, stage: "merge status", evidence: ["GitHub accepted the skipped conclusion."] }],
    priorConcerns: ["A prior same-head attempt raised the same missing proof; this attempt groups it explicitly."],
    limitations: ["The follow-up issue is metadata only; this review does not implement it."],
    nextAction: "Proceed with the current review decision; require the rehearsal before protected promotion.",
    allowIssueWrites,
    publish,
  };
}

test("parent adjudication deduplicates duplicate observations and preserves skipped semantics", async () => {
  const f = await fixture(false);
  try {
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(result.publication, "saved");
    assert.equal(result.trackingPublication, "pending");
    const artifact = JSON.parse(await readFile(result.decisionPath, "utf8"));
    assert.deepEqual(artifact.decisions[0].sourceObservationIds, ["correctness:F1", "security:F1"]);
    assert.match(artifact.gateBody, /REVIEW-PANEL/);
    assert.match(artifact.gateBody, /skipped/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("parent refuses a current report that omits its observations marker", async () => {
  const f = await fixture(false);
  try {
    const reportPath = join(f.reviewRoot, "correctness.report.md");
    const report = await readFile(reportPath, "utf8");
    await writeFile(reportPath, report.replace(/<!-- FORGE:REVIEW_OBSERVATIONS .* -->\n/, ""));
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    await writeFile(inputPath, JSON.stringify(inputFor(f, false, false)));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /missing its explicit observations array/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("clean reports produce a justified approval without invented tracking", async () => {
  const f = await fixture(false);
  try {
    for (const role of f.roles) {
      await writeFile(join(f.reviewRoot, `${role}.report.md`), `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ v: 1, kind: "REVIEW", repository: "example/product", pullRequest: 7, head: f.head, baseSha: f.base, role, reportId: `${role}-attempt`, baseRef: "integration" })} -->\n<!-- FORGE:REVIEW_OBSERVATIONS [] -->\n## ForgeDock review\n\n### Scope and decisions considered\nThe exact patch was reviewed.\n\n### Evidence and findings\nCode findings: none.\n\n### Verification limitations\nNo unresolved prerequisite was found.\n\n### Recommendation\nApprove after parent adjudication.\n`);
    }
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    input.verdict = "APPROVE";
    input.decisions = [];
    input.checks = [];
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(result.verdict, "APPROVE");
    assert.equal(result.trackingPublication, "complete");
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("parent rejects a PASS that leaves a current-stage blocker unresolved", async () => {
  const f = await fixture(false);
  try {
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    input.decisions[0]!.disposition = "EVIDENCE/AUTHORITY PREREQUISITE";
    input.decisions[0]!.tracking = { status: "none" };
    input.decisions[0]!.blocksCurrentStage = true;
    await writeFile(inputPath, JSON.stringify(input));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /PASS cannot coexist/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("a fresh attempt carries prior concern disposition instead of relying on role omission", async () => {
  const f = await fixture(false);
  try {
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    input.priorConcerns = ["Prior attempt C0: unresolved backup proof was reviewed and explicitly REJECTED/NOT APPLICABLE for this current standard stage because no current-stage acceptance criterion requires it."];
    input.decisions[0]!.sourceObservationIds = ["correctness:F1", "security:F1"];
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    const artifact = JSON.parse(await readFile(result.decisionPath, "utf8"));
    assert.match(artifact.gateBody, /Prior attempt C0/);
    assert.match(artifact.gateBody, /REJECTED\/NOT APPLICABLE/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("current attempt rejects omission of a selected role observation", async () => {
  const f = await fixture(false);
  try {
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    input.decisions[0]!.sourceObservationIds = ["correctness:F1"];
    await writeFile(inputPath, JSON.stringify(input));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /Adjudication omitted security:F1/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("parent may reject a reviewer blocker only with an explicit disposition", async () => {
  const f = await fixture(false);
  try {
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    input.verdict = "APPROVE";
    input.decisions[0]!.disposition = "REJECTED/NOT APPLICABLE";
    input.decisions[0]!.resolution = "unsupported";
    input.decisions[0]!.tracking = { status: "none" };
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(result.gate, "PASS");
    assert.equal(result.verdict, "APPROVE");
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("parent reuses an existing issue for an accepted obligation", async () => {
  const f = await fixture(false);
  try {
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    state.issues = [{ number: 33781, title: "Protected storage backup verification", body: "## Problem\nBackup rehearsal evidence remains outstanding.\n## Root Cause\nThe protected storage path has no receipt.\n## Affected Files\n- docs/backup.md\n## Expected Behavior\nA rehearsal receipt exists.\n## Acceptance Criteria\n- [ ] Publish the receipt.", state: "open", labels: ["workflow:gated"], html_url: "https://github.com/example/product/issues/33781" }];
    await writeFile(f.statePath, JSON.stringify(state));
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    input.decisions[0]!.tracking = { status: "existing", issueNumber: 33781, issueUrl: "https://github.com/example/product/issues/33781" };
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(result.tracking.C1.status, "existing");
    assert.equal(result.tracking.C1.issue.number, 33781);
    const decisionArtifact = JSON.parse(await readFile(result.decisionPath, "utf8"));
    assert.match(decisionArtifact.gateBody, /\[#33781\]\(https:\/\/github.com\/example\/product\/issues\/33781\)/);
    assert.match(decisionArtifact.gateBody, /existing tracking/);
    assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).issues.length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("one review root supports pending recovery, explicit revisions, and idempotent repeat", async () => {
  const f = await fixture(true);
  try {
    const pendingPath = join(f.reviewRoot, "pending-input.json");
    const pending = inputFor(f, true, false);
    pending.revision = 0;
    await writeFile(pendingPath, JSON.stringify(pending));
    const pendingResult = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", pendingPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(pendingResult.trackingPublication, "pending");
    assert.ok(pendingResult.panelUrl);
    const recoveredState = JSON.parse(await readFile(f.statePath, "utf8"));
    recoveredState.issuePostFails = false;
    await writeFile(f.statePath, JSON.stringify(recoveredState));
    const recoveredPath = join(f.reviewRoot, "recovered-input.json");
    const recovered = inputFor(f, true, true);
    recovered.revision = 1;
    recovered.supersedes = pendingResult.panelUrl;
    await writeFile(recoveredPath, JSON.stringify(recovered));
    const recoveredResult = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", recoveredPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(recoveredResult.trackingPublication, "complete");
    assert.equal(recoveredResult.tracking.C1.status, "created");
    const afterRecovery = JSON.parse(await readFile(f.statePath, "utf8"));
    const commentCount = afterRecovery.comments.length;
    const searchCount = afterRecovery.calls.filter((args: string[]) => args.some((arg) => arg.startsWith("search/issues?"))).length;
    const issueCreateCount = afterRecovery.calls.filter((args: string[]) => args.includes("POST") && args.some((arg) => arg.endsWith("/issues"))).length;
    const repeated = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", recoveredPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(repeated.tracking.C1.status, "reused");
    const afterRepeat = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(afterRepeat.comments.length, commentCount);
    assert.equal(afterRepeat.calls.filter((args: string[]) => args.some((arg) => arg.startsWith("search/issues?"))).length, searchCount);
    assert.equal(afterRepeat.calls.filter((args: string[]) => args.includes("POST") && args.some((arg) => arg.endsWith("/issues"))).length, issueCreateCount);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("inconclusive create preserves a known issue for direct recovery without a duplicate POST", async () => {
  const f = await fixture(true);
  try {
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    state.issueReadFails = true;
    state.omitSearchIssues = true;
    await writeFile(f.statePath, JSON.stringify(state));
    const firstPath = join(f.reviewRoot, "inconclusive-r0.json");
    const first = inputFor(f, true, true);
    first.revision = 0;
    await writeFile(firstPath, JSON.stringify(first));
    const firstResult = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", firstPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(firstResult.trackingPublication, "pending");
    assert.equal(firstResult.tracking.C1.status, "pending");
    assert.equal(firstResult.tracking.C1.knownIssue.number, 401);
    const changed = JSON.parse(await readFile(f.statePath, "utf8"));
    changed.issueReadFails = false;
    changed.omitSearchIssues = false;
    const createCount = changed.calls.filter((args: string[]) => args.includes("POST") && args.some((arg) => arg.endsWith("/issues"))).length;
    await writeFile(f.statePath, JSON.stringify(changed));
    const secondPath = join(f.reviewRoot, "inconclusive-r1.json");
    const second = inputFor(f, true, true);
    second.revision = 1;
    second.supersedes = firstResult.panelUrl;
    await writeFile(secondPath, JSON.stringify(second));
    const secondResult = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", secondPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(secondResult.tracking.C1.status, "reused");
    const after = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(after.calls.filter((args: string[]) => args.includes("POST") && args.some((arg) => arg.endsWith("/issues"))).length, createCount);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("authorized follow-up issue creation reconciles an ambiguous response once", async () => {
  const f = await fixture(true);
  try {
    const stateWithHistory = JSON.parse(await readFile(f.statePath, "utf8"));
    stateWithHistory.issues = Array.from({ length: 80 }, (_, index) => ({ number: 500 + index, title: `Unrelated history ${index}`, body: "An unrelated repository concern.", state: index % 2 ? "closed" : "open", labels: [], html_url: `https://github.com/example/product/issues/${500 + index}` }));
    await writeFile(f.statePath, JSON.stringify(stateWithHistory));
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, true, true);
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(result.publication, "published");
    assert.equal(result.trackingPublication, "complete");
    assert.equal(result.tracking.C1.status, "created");
    assert.equal(result.tracking.C1.reconciliation, "ambiguous-create-reconciled");
    assert.equal(result.tracking.C1.issue.number, 401);
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(state.issues.length, 81);
    assert.ok(state.comments.length >= 3);
    const issueLookups = state.calls.filter((args: string[]) => args.some((arg) => arg.startsWith("search/issues?")));
    assert.ok(issueLookups.length <= 4);
    assert.equal(state.calls.some((args: string[]) => args.some((arg) => arg.includes("issues?state=all"))), false);
    const discovered = JSON.parse((await execFileAsync("node", [helper, "discover", "--repo", "example/product", "--pr", "7", "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    const panel = discovered.records.filter((record: any) => record.kind === "REVIEW-PANEL").at(-1);
    assert.ok(panel);
    assert.match(panel.body, /Backup rehearsal proof is absent/);
    assert.match(panel.body, /NON-BLOCKING FOLLOW-UP/);
    assert.match(panel.body, /#401/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});
