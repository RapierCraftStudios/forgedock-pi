import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  if (state.emptyIssuePostResponse) { writeFileSync(statePath, JSON.stringify(state)); process.exit(1); }
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

function reviewerReportMarkdown(identity: Record<string, unknown>, body: string, observations: any[]): string {
  const oneLine = (value: unknown) => String(value).replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  const summary = observations.length === 0
    ? "### Structured findings\n\nNo structured observations reported.\n\n"
    : `### Structured findings\n\n${observations.map((item) => `- **${item.id}** (${item.kind}) ${oneLine(item.summary)} — evidence: ${item.evidence.map(oneLine).join("; ")}; proposed: ${item.proposedDisposition}; stage: ${oneLine(item.stage)}`).join("\n")}\n\n`;
  const headers = `**Reviewer role**: \`${identity.role}\`\n**Pull request**: #${identity.pullRequest}\n**Reviewed source**: \`${identity.head}\`\n**Review base**: \`${identity.baseRef}\` at \`${identity.baseSha}\`\n\n`;
  return `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify(identity)} -->\n<!-- FORGE:REVIEW_OBSERVATIONS ${JSON.stringify(observations)} -->\n## ForgeDock review\n\n${headers}${summary}${body.trim()}\n`;
}

async function fixture(publish: boolean, staging = false) {
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
  if (staging) await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", base], { cwd: root });
  await writeFile(statePath, JSON.stringify({
    pull: { headRefOid: head, baseRefName: staging ? "main" : "integration", baseRefOid: base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", state: "OPEN", isDraft: false, url: "https://github.com/example/product/pull/7" },
    comments: [],
    issues: [],
    nextComment: 100,
    nextIssue: 401,
    issuePostFails: true,
  }));
  const roles = ["correctness", "security"];
  const roleArtifactKeys = Object.fromEntries(roles.map((role) => [role, `${role}-attempt`]));
  const workflowPath = join(reviewRoot, "workflow.js");
  const workflowText = `const assignments = ${JSON.stringify(roles.map((role) => ({ role, reportPath: join(reviewRoot, `${role}.report.md`), recoveryPath: join(reviewRoot, `${role}.publication-recovery.json`) })))};\nreturn assignments;\n`;
  await writeFile(workflowPath, workflowText);
  const workflowSha256 = createHash("sha256").update(workflowText).digest("hex");
  const observations: Record<string, any[]> = {
    correctness: [{ id: "correctness:F1", kind: "verification-authority-prerequisite", summary: "Backup rehearsal proof is absent", affectedBehavior: "Promotion backup safety", location: "docs/backup.md", evidence: ["No exact-head rehearsal receipt exists."], trigger: "The promotion has no independent backup rehearsal receipt.", consequence: "The protected promotion cannot claim the backup obligation is discharged.", whyThisChange: "The changed storage path is part of this promotion.", stage: "before promotion", proposedDisposition: "NON-BLOCKING FOLLOW-UP" }],
    security: [{ id: "security:F1", kind: "verification-authority-prerequisite", summary: "Backup rehearsal proof is absent", affectedBehavior: "Promotion backup safety", location: "docs/backup.md", evidence: ["The same missing receipt is visible at the protected boundary."], trigger: "The exact-head rehearsal receipt is unavailable.", consequence: "The evidence gap remains until the rehearsal is run.", whyThisChange: "The promotion changes the storage boundary.", stage: "before promotion", proposedDisposition: "NON-BLOCKING FOLLOW-UP" }],
  };
  const baseRef = staging ? "main" : "integration";
  const review = { schema: "forgedock.candidate-review/v1", artifactRoot: reviewRoot, artifactKey: "attempt-1", repository: "example/product", pullRequest: 7, head, baseRef, baseSha: base, sourceRoot: root, configRoot: root, publish, roles, roleArtifactKeys, mode: staging ? "staging" : "standard", workflowPath, workflowSha256 };
  await writeFile(join(reviewRoot, "review.json"), JSON.stringify(review));
  for (const role of roles) {
    const identity = { v: 1, kind: "REVIEW", repository: "example/product", pullRequest: 7, head, baseSha: base, role, reportId: roleArtifactKeys[role]!, baseRef };
    const body = ["### Scope and decisions considered", "The exact patch was reviewed.", "### Evidence and findings", "The structured observation is recorded.", "### Verification limitations", "No independent rehearsal was available.", "### Recommendation", "Follow up after the parent decision."].join("\n\n");
    const bodyBytes = `${body}\n`;
    const observationsBytes = `${JSON.stringify(observations[role], null, 2)}\n`;
    const bodyPath = join(reviewRoot, `${role}.body.md`);
    const reportPath = join(reviewRoot, `${role}.report.md`);
    const observationsPath = join(reviewRoot, `${role}.observations.json`);
    await writeFile(bodyPath, bodyBytes);
    await writeFile(observationsPath, observationsBytes);
    await writeFile(join(reviewRoot, `${role}.authorization.json`), JSON.stringify({ schema: "forgedock.candidate-review-role/v1", artifactRoot: reviewRoot, artifactKey: roleArtifactKeys[role], role, repository: review.repository, pullRequest: 7, head, baseRef, baseSha: base, publish }));
    await writeFile(join(reviewRoot, `${role}.publication-recovery.json`), JSON.stringify({
      schema: "forgedock.candidate-review-publication-recovery/v1", state: publish ? "published" : "saved", recoveryAttempts: 0,
      nativeRunId: `native-${role}-run-33800`, reviewArtifactKey: review.artifactKey, roleArtifactKey: roleArtifactKeys[role], suppliedArtifactKey: roleArtifactKeys[role],
      repository: review.repository, pullRequest: 7, head, baseRef, baseSha: base, role, publish,
      bodyPath, reportPath, observationsPath, body, observations: observations[role],
      bodySha256: createHash("sha256").update(bodyBytes).digest("hex"), observationsSha256: createHash("sha256").update(observationsBytes).digest("hex"),
    }, null, 2));
    await writeFile(reportPath, reviewerReportMarkdown(identity, body, observations[role]!));
  }
  const roleResults = roles.map((role) => ({ role, nativeRunId: `native-${role}-run-33800`, nativeStatus: "completed", reportPath: join(reviewRoot, `${role}.report.md`), recoveryPath: join(reviewRoot, `${role}.publication-recovery.json`), exitCode: 0 }));
  await writeFile(join(reviewRoot, "panel-launch.claim"), JSON.stringify({ schema: "forgedock.candidate-review-panel-launch/v1", artifactKey: review.artifactKey, workflowSha256, toolCallId: "fixture-reviewer-tool-call", claimedAt: new Date().toISOString() }));
  await writeFile(join(reviewRoot, "reviewer-execution.json"), JSON.stringify({ schema: "forgedock.candidate-review-execution/v1", repository: review.repository, pullRequest: review.pullRequest, head, baseRef, baseSha: base, artifactKey: review.artifactKey, mode: review.mode, workflowPath, workflowSha256, toolCallId: "fixture-reviewer-tool-call", workflowRunId: "fixture-workflow-run", completedAt: new Date().toISOString(), roleResults }, null, 2));
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (publish) {
    state.comments = [];
    for (const [index, role] of roles.entries()) state.comments.push({ id: 11 + index, body: await readFile(join(reviewRoot, `${role}.report.md`), "utf8"), html_url: `https://github.com/example/product/pull/7#issuecomment-${11 + index}` });
    await writeFile(statePath, JSON.stringify(state));
  }
  return { root, bin, reviewRoot, statePath, head, base, baseRef, mode: staging ? "staging" : "standard", roles };
}

function inputFor(f: Awaited<ReturnType<typeof fixture>>, publish: boolean, allowIssueWrites: boolean): any {
  return {
    schema: "forgedock.candidate-adjudication/v1",
    repository: "example/product",
    pullRequest: 7,
    head: f.head,
    baseRef: f.baseRef,
    baseSha: f.base,
    mode: f.mode,
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
    historicalDecisions: [],
    limitations: ["The follow-up issue is metadata only; this review does not implement it."],
    nextAction: "Proceed with the current review decision; require the rehearsal before protected promotion.",
    allowIssueWrites,
    publish,
  };
}

test("CLI adjudication binds route mode and every report to the prepared role key", async () => {
  const f = await fixture(false);
  try {
    const inputPath = join(f.reviewRoot, "route-and-report-identity.json");
    const input = inputFor(f, false, false);
    input.mode = "staging";
    await writeFile(inputPath, JSON.stringify(input));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /Adjudication mode does not match the route/);

    input.mode = f.mode;
    const reportPath = join(f.reviewRoot, "correctness.report.md");
    const report = await readFile(reportPath, "utf8");
    await writeFile(reportPath, report.replace("correctness-attempt", "wrong-role-key"));
    await writeFile(inputPath, JSON.stringify(input));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /does not match its prepared role authorization/);
    await writeFile(reportPath, report);
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(state.comments.length, 0);
    assert.equal(state.issues.length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("standalone and batch REVIEW-PANEL CLI routes require prepared adjudication", async () => {
  const f = await fixture(false);
  try {
    const bodyFile = join(f.reviewRoot, "manual-panel.md");
    const reportsFile = join(f.reviewRoot, "manual-reviewers.json");
    const batchFile = join(f.reviewRoot, "manual-panel-batch.json");
    await writeFile(bodyFile, "A manually supplied parent decision.\n");
    await writeFile(reportsFile, JSON.stringify(f.roles.map((role) => ({ role, reportFile: join(f.reviewRoot, `${role}.report.md`) }))));
    await assert.rejects(execFileAsync("node", [helper, "record", "--kind", "REVIEW-PANEL", "--repo", "example/product", "--pr", "7", "--head", f.head, "--base-ref", f.baseRef, "--base-sha", f.base, "--mode", f.mode, "--body-file", bodyFile, "--reviewers-file", reportsFile, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /REVIEW-PANEL prepared reviewRoot must be a non-empty string/);
    await writeFile(batchFile, JSON.stringify({ repository: "example/product", cwd: f.root, records: [{ kind: "REVIEW-PANEL", pullRequest: 7, head: f.head, baseRef: f.baseRef, baseSha: f.base, bodyFile, reviewerReports: f.roles.map((role) => ({ role, reportFile: join(f.reviewRoot, `${role}.report.md`) })) }] }));
    await assert.rejects(execFileAsync("node", [helper, "record", "batch", "--input", batchFile], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /REVIEW-PANEL prepared reviewRoot must be a non-empty string/);
    const saved = JSON.parse((await execFileAsync("node", [helper, "record", "--kind", "REVIEW-PANEL", "--repo", "example/product", "--pr", "7", "--head", f.head, "--base-ref", f.baseRef, "--base-sha", f.base, "--mode", f.mode, "--body-file", bodyFile, "--reviewers-file", reportsFile, "--review-root", f.reviewRoot, "--artifact-key", "attempt-1", "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(saved.kind, "REVIEW-PANEL");
    assert.equal(saved.publication, "saved");
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(state.comments.length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("direct adjudication requires byte-exact remote reviewer report readback", async () => {
  const f = await fixture(true);
  try {
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    state.comments[0].body += "\n";
    await writeFile(f.statePath, JSON.stringify(state));
    const inputPath = join(f.reviewRoot, "remote-report-bytes.json");
    await writeFile(inputPath, JSON.stringify(inputFor(f, true, false)));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /was not found exactly once with the saved bytes/);
    const after = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(after.comments.length, 2);
    assert.equal(after.comments.some((comment: any) => comment.body.includes("REVIEW-PANEL")), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("direct adjudication rejects noncanonical local report line endings", async () => {
  const f = await fixture(false);
  try {
    const reportPath = join(f.reviewRoot, "correctness.report.md");
    const report = await readFile(reportPath, "utf8");
    await writeFile(reportPath, report.replace(/\n/g, "\r\n"));
    const inputPath = join(f.reviewRoot, "noncanonical-report.json");
    await writeFile(inputPath, JSON.stringify(inputFor(f, false, false)));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /does not match its retained authored body\/observations/);
    assert.equal((await readdir(f.reviewRoot)).some((name) => name.startsWith("review-panel.provisional-r0")), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

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

test("legacy prose concerns fail actionably and a revised structured request remains valid", async () => {
  const f = await fixture(false);
  try {
    const failedPath = join(f.reviewRoot, "adjudication-input-r0.json");
    const failed = inputFor(f, false, false) as any;
    failed.priorConcerns = ["A prior allegation requires adjudication."];
    await writeFile(failedPath, JSON.stringify(failed));
    await assert.rejects(
      execFileAsync("node", [helper, "record", "adjudication", "--input", failedPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }),
      /Legacy priorConcerns prose.*historicalDecisions.*sourceReference/,
    );
    const revisedPath = join(f.reviewRoot, "adjudication-input-r1.json");
    const revised = inputFor(f, false, false) as any;
    revised.historicalDecisions = [{ id: "prior-allegation", sourceReference: "https://github.com/example/product/pull/7#issuecomment-prior", disposition: "REJECTED/NOT APPLICABLE", resolution: "resolved-by-evidence", summary: "The allegation is contradicted by current primary evidence", rationale: "The exact-head evidence preserves the artifact.", evidence: ["The current report and source evidence preserve the artifact."], stage: "current review", blocksCurrentStage: false, tracking: { status: "none" } }];
    revised.revision = 1;
    await writeFile(revisedPath, JSON.stringify(revised));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", revisedPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(result.publication, "saved");
    assert.match(await readFile(failedPath, "utf8"), /priorConcerns/);
    const artifact = JSON.parse(await readFile(result.decisionPath, "utf8"));
    assert.ok(artifact.decisions.some((decision: any) => decision.id === "prior-allegation"));
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
    const review = JSON.parse(await readFile(join(f.reviewRoot, "review.json"), "utf8"));
    for (const role of f.roles) {
      const body = ["### Scope and decisions considered", "The exact patch was reviewed.", "### Evidence and findings", "Code findings: none.", "### Verification limitations", "No unresolved prerequisite was found.", "### Recommendation", "Approve after parent adjudication."].join("\n\n");
      const observations: any[] = [];
      const bodyBytes = `${body}\n`;
      const observationsBytes = `${JSON.stringify(observations, null, 2)}\n`;
      const recoveryPath = join(f.reviewRoot, `${role}.publication-recovery.json`);
      const recovery = JSON.parse(await readFile(recoveryPath, "utf8"));
      recovery.body = body;
      recovery.observations = observations;
      recovery.bodySha256 = createHash("sha256").update(bodyBytes).digest("hex");
      recovery.observationsSha256 = createHash("sha256").update(observationsBytes).digest("hex");
      await writeFile(recovery.bodyPath, bodyBytes);
      await writeFile(recovery.observationsPath, observationsBytes);
      await writeFile(recoveryPath, JSON.stringify(recovery));
      const identity = { v: 1, kind: "REVIEW", repository: "example/product", pullRequest: 7, head: f.head, baseSha: f.base, role, reportId: review.roleArtifactKeys[role], baseRef: "integration" };
      await writeFile(join(f.reviewRoot, `${role}.report.md`), reviewerReportMarkdown(identity, body, observations));
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

test("current and historical follow-ups both require tracking", async () => {
  const currentFixture = await fixture(false);
  try {
    const inputPath = join(currentFixture.reviewRoot, "adjudication.json.input");
    const input = inputFor(currentFixture, false, false);
    input.decisions[0]!.tracking = { status: "none" };
    await writeFile(inputPath, JSON.stringify(input));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", currentFixture.root], { env: { ...process.env, PATH: `${currentFixture.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: currentFixture.statePath } }), /follow-up must identify/);
  } finally {
    await rm(currentFixture.root, { recursive: true, force: true });
    await rm(currentFixture.bin, { recursive: true, force: true });
    await rm(currentFixture.reviewRoot, { recursive: true, force: true });
  }
  const historicalFixture = await fixture(false);
  try {
    const inputPath = join(historicalFixture.reviewRoot, "adjudication.json.input");
    const input = inputFor(historicalFixture, false, false);
    input.historicalDecisions = [{ id: "prior-follow-up", sourceReference: "https://github.com/example/product/pull/7#issuecomment-prior", disposition: "NON-BLOCKING FOLLOW-UP", resolution: "confirmed", summary: "Historical follow-up remains useful", rationale: "The parent retains the same actionable non-blocking work.", evidence: ["The prior report remains applicable."], stage: "later validation", blocksCurrentStage: false, tracking: { status: "none" } }];
    await writeFile(inputPath, JSON.stringify(input));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", historicalFixture.root], { env: { ...process.env, PATH: `${historicalFixture.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: historicalFixture.statePath } }), /follow-up must identify/);
  } finally {
    await rm(historicalFixture.root, { recursive: true, force: true });
    await rm(historicalFixture.bin, { recursive: true, force: true });
    await rm(historicalFixture.reviewRoot, { recursive: true, force: true });
  }
});

test("historical follow-ups render verified links or pending drafts", async () => {
  const existingFixture = await fixture(false);
  try {
    const state = JSON.parse(await readFile(existingFixture.statePath, "utf8"));
    state.issues = [{ number: 33781, title: "Existing tracking", body: "## Problem\nExisting obligation", state: "open", labels: ["workflow:gated"], html_url: "https://github.com/example/product/issues/33781" }];
    await writeFile(existingFixture.statePath, JSON.stringify(state));
    const inputPath = join(existingFixture.reviewRoot, "adjudication.json.input");
    const input = inputFor(existingFixture, false, false);
    input.verdict = "APPROVE_WITH_FOLLOW_UP";
    input.decisions[0]!.disposition = "REJECTED/NOT APPLICABLE";
    input.decisions[0]!.resolution = "unsupported";
    input.decisions[0]!.tracking = { status: "none" };
    input.historicalDecisions = [{ id: "prior-follow-up", sourceReference: "https://github.com/example/product/pull/7#issuecomment-prior", disposition: "NON-BLOCKING FOLLOW-UP", resolution: "confirmed", summary: "Historical obligation remains useful", rationale: "The parent retains the actionable follow-up without blocking this stage.", evidence: ["The original report remains applicable."], stage: "later validation", blocksCurrentStage: false, tracking: { status: "existing", issueNumber: 33781, issueUrl: "https://github.com/example/product/issues/33781" } }];
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", existingFixture.root], { env: { ...process.env, PATH: `${existingFixture.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: existingFixture.statePath } })).stdout);
    assert.match(result.gateBody, /\[#33781\]\(https:\/\/github.com\/example\/product\/issues\/33781\)/);
  } finally {
    await rm(existingFixture.root, { recursive: true, force: true });
    await rm(existingFixture.bin, { recursive: true, force: true });
    await rm(existingFixture.reviewRoot, { recursive: true, force: true });
  }
  const pendingFixture = await fixture(false);
  try {
    const inputPath = join(pendingFixture.reviewRoot, "adjudication.json.input");
    const input = inputFor(pendingFixture, false, false);
    const pendingDraft = input.decisions[0]!.tracking.draft;
    input.verdict = "APPROVE_WITH_FOLLOW_UP";
    input.decisions[0]!.disposition = "REJECTED/NOT APPLICABLE";
    input.decisions[0]!.resolution = "unsupported";
    input.decisions[0]!.tracking = { status: "none" };
    input.historicalDecisions = [{ id: "prior-pending", sourceReference: "https://github.com/example/product/pull/7#issuecomment-prior", disposition: "NON-BLOCKING FOLLOW-UP", resolution: "confirmed", summary: "Historical work awaits permission", rationale: "The draft is actionable but issue publication is not authorized.", evidence: ["The original report remains applicable."], stage: "later validation", blocksCurrentStage: false, tracking: { status: "pending", draft: pendingDraft } }];
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", pendingFixture.root], { env: { ...process.env, PATH: `${pendingFixture.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: pendingFixture.statePath } })).stdout);
    assert.match(result.gateBody, /PENDING/);
  } finally {
    await rm(pendingFixture.root, { recursive: true, force: true });
    await rm(pendingFixture.bin, { recursive: true, force: true });
    await rm(pendingFixture.reviewRoot, { recursive: true, force: true });
  }
});

test("historical concerns enter the same decision path with explicit rejection evidence", async () => {
  const f = await fixture(false);
  try {
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    input.historicalDecisions = [{ id: "prior-merge-result", sourceReference: "https://github.com/example/product/pull/7#issuecomment-previous", disposition: "REJECTED/NOT APPLICABLE", resolution: "resolved-by-evidence", summary: "The merge result preserves the changelog blob", rationale: "The proposed merge resolves the base-versus-head snapshot difference without deleting the artifact.", evidence: ["The reviewed merge blob is identical to the protected-base blob."], stage: "before promotion", blocksCurrentStage: false, tracking: { status: "none" } }];
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    const artifact = JSON.parse(await readFile(result.decisionPath, "utf8"));
    assert.ok(artifact.decisions.some((decision: any) => decision.id === "prior-merge-result"));
    assert.match(artifact.gateBody, /prior-merge-result/);
    assert.match(artifact.gateBody, /REJECTED\/NOT APPLICABLE/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("accepted staging repair records pending tracking instead of none", async () => {
  const f = await fixture(false, true);
  try {
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    input.verdict = "CHANGES_REQUESTED";
    input.gate = "FAIL";
    input.decisions[0]!.disposition = "IMMEDIATE REPAIR";
    input.decisions[0]!.resolution = "confirmed";
    input.decisions[0]!.blocksCurrentStage = true;
    input.decisions[0]!.tracking = { status: "pending", draft: input.decisions[0]!.tracking.draft };
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(result.gate, "FAIL");
    assert.equal(result.trackingPublication, "pending");
    assert.match(result.gateBody, /PENDING/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("executed-proof requirements need an identified source", async () => {
  const f = await fixture(false);
  try {
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    input.checks[0]!.executedProofRequired = true;
    delete input.checks[0]!.proofSource;
    await writeFile(inputPath, JSON.stringify(input));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /executed-proof requirement needs an applicable acceptance or policy source/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.bin, { recursive: true, force: true });
    await rm(f.reviewRoot, { recursive: true, force: true });
  }
});

test("current evidence prerequisites use the same source requirement as historical ones", async () => {
  const f = await fixture(false);
  try {
    const inputPath = join(f.reviewRoot, "adjudication.json.input");
    const input = inputFor(f, false, false);
    input.verdict = "GATED";
    input.gate = "FAIL";
    input.decisions[0]!.disposition = "EVIDENCE/AUTHORITY PREREQUISITE";
    input.decisions[0]!.blocksCurrentStage = true;
    input.decisions[0]!.tracking = { status: "pending", draft: input.decisions[0]!.tracking.draft };
    await writeFile(inputPath, JSON.stringify(input));
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /executed-proof prerequisite needs/);
    input.decisions[0]!.proofSource = "acceptance:restore-contract#backup-proof";
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(result.gate, "FAIL");
    assert.match(result.gateBody, /acceptance:restore-contract#backup-proof/);
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
    await assert.rejects(execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } }), /PASS cannot coexist|executed-proof prerequisite/);
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
    input.historicalDecisions = [{ id: "prior-attempt-C0", sourceReference: "https://github.com/example/product/pull/7#issuecomment-prior", disposition: "REJECTED/NOT APPLICABLE", resolution: "resolved-by-evidence", summary: "Prior backup-proof concern is not required at this standard stage", rationale: "The current stage has no accepted executed-proof obligation for this concern.", evidence: ["The current stage policy accepts the no-op status."], stage: "current standard review", blocksCurrentStage: false, tracking: { status: "none" } }];
    input.decisions[0]!.sourceObservationIds = ["correctness:F1", "security:F1"];
    await writeFile(inputPath, JSON.stringify(input));
    const result = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", inputPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    const artifact = JSON.parse(await readFile(result.decisionPath, "utf8"));
    assert.match(artifact.gateBody, /prior-attempt-C0/);
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
    afterRecovery.omitSearchIssues = true;
    await writeFile(f.statePath, JSON.stringify(afterRecovery));
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

test("empty lost response stays pending, then late bounded reconciliation recovers without a second POST", async () => {
  const f = await fixture(true);
  try {
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    state.emptyIssuePostResponse = true;
    state.omitSearchIssues = true;
    await writeFile(f.statePath, JSON.stringify(state));
    const firstPath = join(f.reviewRoot, "lost-r0.json");
    const first = inputFor(f, true, true);
    first.revision = 0;
    await writeFile(firstPath, JSON.stringify(first));
    const firstResult = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", firstPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(firstResult.trackingPublication, "pending");
    assert.equal(firstResult.tracking.C1.attempted, true);
    const afterFirst = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(afterFirst.issues.length, 1);
    const postCount = afterFirst.calls.filter((args: string[]) => args.includes("POST") && args.some((arg) => arg.endsWith("/issues"))).length;
    const retryPath = join(f.reviewRoot, "lost-r1.json");
    const retry = inputFor(f, true, true);
    retry.revision = 1;
    retry.supersedes = firstResult.panelUrl;
    await writeFile(retryPath, JSON.stringify(retry));
    const retryResult = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", retryPath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(retryResult.trackingPublication, "pending");
    const afterRetry = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(afterRetry.calls.filter((args: string[]) => args.includes("POST") && args.some((arg) => arg.endsWith("/issues"))).length, postCount);
    afterRetry.omitSearchIssues = false;
    afterRetry.emptyIssuePostResponse = false;
    await writeFile(f.statePath, JSON.stringify(afterRetry));
    const latePath = join(f.reviewRoot, "lost-r2.json");
    const late = inputFor(f, true, true);
    late.revision = 2;
    late.supersedes = retryResult.panelUrl;
    await writeFile(latePath, JSON.stringify(late));
    const lateResult = JSON.parse((await execFileAsync("node", [helper, "record", "adjudication", "--input", latePath, "--cwd", f.root], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_ADJUDICATION_STATE: f.statePath } })).stdout);
    assert.equal(lateResult.tracking.C1.status, "reused");
    assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).calls.filter((args: string[]) => args.includes("POST") && args.some((arg) => arg.endsWith("/issues"))).length, postCount);
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
