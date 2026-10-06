import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helper = resolve("bin/forgedock-candidate.mjs");

const fakeGh = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const stateFile = process.env.FAKE_GH_STATE;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { labels: [], comments: {}, nextId: 100, operations: [] };
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  const pull = state.pullRequests?.[args[2]];
  if (!pull) process.exit(1);
  process.stdout.write(JSON.stringify(pull));
  process.exit(0);
}
if (args[0] !== "api") process.exit(2);
const endpoint = args.find((value) => value.startsWith("repos/"));
if (!endpoint) process.exit(2);
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
const parts = endpoint.split("/");
const labelName = endpoint.includes("/labels/") ? decodeURIComponent(endpoint.slice(endpoint.indexOf("/labels/") + "/labels/".length)) : undefined;
const destinationMatch = endpoint.match(/\\/issues\\/(\\d+)(?:\\/comments)?/);
const destination = destinationMatch?.[1];
const commentKey = destination ? String(destination) : "";
const comments = state.comments[commentKey] ?? (state.comments[commentKey] = []);
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const field = (name) => {
  const index = args.findIndex((value) => value === name || value.startsWith(name + "="));
  if (index < 0) return undefined;
  const value = args[index];
  return value.includes("=") ? value.slice(value.indexOf("=") + 1) : args[index + 1];
};
if (method === "GET" && endpoint.endsWith("/labels")) {
  process.stdout.write(JSON.stringify([state.labels.map((name) => ({ name }))]));
} else if (method === "GET" && endpoint.includes("/labels/") && !endpoint.includes("/issues/")) {
  if (!state.labels.includes(labelName)) { console.error("HTTP 404 Not Found"); process.exit(1); }
  process.stdout.write(JSON.stringify({ name: labelName }));
} else if (method === "POST" && endpoint.includes("/issues/") && endpoint.endsWith("/labels")) {
  const name = field("labels[]");
  if (!state.labels.includes(name)) state.labels.push(name);
  state.operations.push({ method, endpoint, name });
  save();
  if (state.failNextLabelAdd) { state.failNextLabelAdd = false; save(); process.exit(1); }
  process.stdout.write(JSON.stringify(state.labels.map((value) => ({ name: value }))));
} else if (method === "POST" && endpoint.endsWith("/labels")) {
  if (state.denyLabelCreate) process.exit(1);
  const name = field("name");
  if (!state.labels.includes(name)) state.labels.push(name);
  state.operations.push({ method, endpoint, name }); save();
  process.stdout.write(JSON.stringify({ name }));
} else if (method === "DELETE" && endpoint.includes("/issues/") && endpoint.includes("/labels/")) {
  state.labels = state.labels.filter((value) => value !== labelName);
  state.operations.push({ method, endpoint, name: labelName });
  save();
  if (state.failNextLabelDelete) { state.failNextLabelDelete = false; save(); process.exit(1); }
  process.stdout.write(JSON.stringify({ name: labelName }));
} else if (method === "GET" && endpoint.includes("/issues/comments/")) {
  const id = Number(endpoint.split("/").at(-1));
  const comment = Object.values(state.comments).flat().find((value) => value.id === id);
  if (!comment) process.exit(1);
  process.stdout.write(JSON.stringify(comment));
} else if (method === "GET" && endpoint.includes("/issues/") && endpoint.endsWith("/comments")) {
  process.stdout.write(JSON.stringify([comments]));
} else if (method === "POST" && endpoint.includes("/issues/") && endpoint.endsWith("/comments")) {
  const bodyArg = args.find((value) => value.startsWith("body=@"));
  const body = readFileSync(bodyArg.slice("body=@".length), "utf8");
  if (state.denyCommentCreate) process.exit(1);
  const id = state.nextId++;
  const destinationPath = state.pullRequests?.[commentKey] ? "pull" : "issues";
  const comment = { id, body, html_url: "https://github.com/example/product/" + destinationPath + "/" + commentKey + "#issuecomment-" + id };
  comments.push(comment);
  state.operations.push({ method, endpoint, commentId: comment.id });
  save();
  if (state.failNextCommentCreate) { state.failNextCommentCreate = false; save(); process.exit(1); }
  process.stdout.write(JSON.stringify(comment));
} else {
  console.error(JSON.stringify({ args, endpoint, method }));
  process.exit(2);
}
`;

const forgeYaml = `
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
  remediation_max_rounds: 1
`;

async function fixture(options: { reviewer?: boolean } = {}) {
  const root = await mkdtemp("/tmp/forgedock-candidate-knowledge-");
  const fakeBin = join(root, "bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "gh"), fakeGh, { mode: 0o755 });
  await writeFile(join(root, "README.md"), "knowledge fixture\n");
  await writeFile(join(root, ".gitignore"), "bin/\ngh-state.json\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
  await execFileAsync("git", ["add", "README.md", ".gitignore"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
  await writeFile(join(root, "forge.yaml"), forgeYaml);
  await execFileAsync("git", ["add", "forge.yaml"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "fixture"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const base = (await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd: root })).stdout.trim();
  await execFileAsync("git", ["branch", "-M", "integration"], { cwd: root });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/integration", base], { cwd: root });
  const state = join(root, "gh-state.json");
  const reviewerEnabled = options.reviewer !== false;
  await writeFile(state, JSON.stringify({ labels: ["bug", "priority:P1", "needs-human"], comments: reviewerEnabled ? { "42": [], "7": [] } : { "42": [] }, pullRequests: reviewerEnabled ? { "7": { headRefOid: head, baseRefName: "integration", baseRefOid: base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } } : {}, nextId: 100, operations: [] }));
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_GH_STATE: state, FORGEDOCK_CANDIDATE_ARTIFACT_ROOT: join(root, ".git"), FORGEDOCK_SAFE_ARTIFACT_ROOT: join(root, ".git", "candidate-artifacts") };
  const preparedReviewer = reviewerEnabled ? await preparedReviewerArtifact(root, env, 7, head, "integration", base) : { reviewRoot: "", artifactKey: "", reportPath: "" };
  return { root, state, head, base, env, ...preparedReviewer };
}

async function preparedReviewerArtifact(root: string, env: NodeJS.ProcessEnv, pullRequest: number, head: string, baseRef: string, baseSha: string) {
  const inputPath = join(root, ".git", `review-input-${pullRequest}-${baseRef}.json`);
  await writeFile(inputPath, JSON.stringify({ repository: "example/product", pullRequest, head, baseRef, baseSha, sourceRoot: root, configRoot: root, roles: ["correctness"], publish: true }));
  const prepared = JSON.parse((await execFileAsync("node", [helper, "prepare-review", "--input", inputPath], { cwd: root, env })).stdout);
  const reviewRoot = prepared.out as string;
  const review = JSON.parse(await readFile(join(reviewRoot, "review.json"), "utf8"));
  const role = "correctness";
  const roleKey = review.roleArtifactKeys[role] as string;
  const bodyText = ["### Scope and decisions considered", `Reviewed the exact prepared PR #${pullRequest} source and base.`, "### Evidence and findings", "No unstructured conclusion replaces the report evidence.", "### Verification limitations", "This knowledge fixture uses a controlled fake GitHub transport.", "### Recommendation", "Use this exact role-bound report in the parent panel."].join("\n\n");
  const observations: unknown[] = [];
  const bodyBytes = `${bodyText}\n`;
  const observationsBytes = `${JSON.stringify(observations, null, 2)}\n`;
  const bodyPath = join(reviewRoot, `${role}.body.md`);
  const reportPath = join(reviewRoot, `${role}.report.md`);
  const observationsPath = join(reviewRoot, `${role}.observations.json`);
  await writeFile(bodyPath, bodyBytes);
  await writeFile(observationsPath, observationsBytes);
  await writeFile(join(reviewRoot, `${role}.publication-recovery.json`), `${JSON.stringify({
    schema: "forgedock.candidate-review-publication-recovery/v1", state: "published", recoveryAttempts: 0,
    nativeRunId: `native-knowledge-${pullRequest}-run`, reviewArtifactKey: review.artifactKey, roleArtifactKey: roleKey, suppliedArtifactKey: roleKey,
    repository: review.repository, pullRequest, head, baseRef, baseSha, role, publish: true,
    bodyPath, reportPath, observationsPath, body: bodyText, observations,
    bodySha256: createHash("sha256").update(bodyBytes).digest("hex"), observationsSha256: createHash("sha256").update(observationsBytes).digest("hex"),
  }, null, 2)}\n`);
  await execFileAsync("node", [helper, "record", "reviewer", "--repo", "example/product", "--pr", String(pullRequest), "--head", head, "--base-ref", baseRef, "--base-sha", baseSha, "--role", role, "--report-id", roleKey, "--body-file", bodyPath, "--report-file", reportPath, "--observations-file", observationsPath, "--cwd", root, "--publish"], { cwd: root, env });
  await writeFile(join(reviewRoot, "panel-launch.claim"), JSON.stringify({ schema: "forgedock.candidate-review-panel-launch/v1", artifactKey: review.artifactKey, workflowSha256: review.workflowSha256, toolCallId: `knowledge-review-${pullRequest}`, claimedAt: new Date().toISOString() }));
  await writeFile(join(reviewRoot, "reviewer-execution.json"), JSON.stringify({
    schema: "forgedock.candidate-review-execution/v1", repository: review.repository, pullRequest, head, baseRef, baseSha,
    artifactKey: review.artifactKey, mode: review.mode, workflowPath: review.workflowPath, workflowSha256: review.workflowSha256,
    toolCallId: `knowledge-review-${pullRequest}`, workflowRunId: `knowledge-workflow-${pullRequest}`, completedAt: new Date().toISOString(),
    roleResults: [{ role, nativeRunId: `native-knowledge-${pullRequest}-run`, nativeStatus: "completed", reportPath, recoveryPath: join(reviewRoot, `${role}.publication-recovery.json`), exitCode: 0 }],
  }, null, 2));
  return { reviewRoot, artifactKey: review.artifactKey, reportPath };
}

async function body(root: string, name: string, content: string) {
  const file = join(root, `${name}.md`);
  await writeFile(file, content);
  return file;
}

async function run(args: string[], env: NodeJS.ProcessEnv) {
  return JSON.parse((await execFileAsync("node", [helper, ...args], { env })).stdout) as Record<string, any>;
}

function recordMetadata(comment: { body: string }) {
  const match = comment.body.split("\n")[1]?.match(/^<!-- FORGE:RECORD (.*) -->$/);
  if (!match?.[1]) throw new Error("published comment carries the generated record metadata");
  return JSON.parse(match[1]);
}

function commentAt(state: Record<string, any>, url: string) {
  const comment = Object.values(state.comments).flat().find((value: any) => value.html_url === url);
  assert.ok(comment, `fresh reader can fetch linked comment ${url}`);
  return comment as { id: number; body: string; html_url: string };
}

async function publishPrebuild(f: Awaited<ReturnType<typeof fixture>>, prefix: string, env = f.env, head = f.head) {
  const names = ["investigator", "classification", "context", "contract", "architect"];
  const kinds = ["INVESTIGATOR", "CLASSIFICATION", "CONTEXT", "CONTRACT", "ARCHITECT"];
  const files: Record<string, string> = {};
  for (const name of names) files[name] = await body(f.root, `${prefix}-${name}`, `### ${name}\n${prefix} evidence for this issue's ${name.toLowerCase()} record.`);
  const input = join(f.root, `${prefix}-records.json`);
  const records = [
    { id: "investigator", kind: kinds[0], bodyFile: files.investigator, head },
    { id: "classification", kind: kinds[1], bodyFile: files.classification, head, inputs: [{ record: "investigator" }] },
    { id: "context", kind: kinds[2], bodyFile: files.context, head, inputs: [{ record: "investigator" }] },
    { id: "contract", kind: kinds[3], bodyFile: files.contract, head, inputs: [{ record: "classification" }, { record: "context" }] },
    { id: "architect", kind: kinds[4], bodyFile: files.architect, head, inputs: [{ record: "contract" }] },
  ];
  await writeFile(input, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records }));
  return { input, result: await run(["record", "batch", "--input", input, "--publish"], env), records, files };
}

test("single Builder and terminal publication carry the exact pre-build receipt without input transcription", async () => {
  const f = await fixture({ reviewer: false });
  try {
    const prebuild = await publishPrebuild(f, "measured-shape");
    const architect = prebuild.result.records.find((record: any) => record.kind === "ARCHITECT");
    assert.ok(architect.receiptFile);
    const savedReceipt = JSON.parse(await readFile(architect.receiptFile, "utf8"));
    assert.equal(savedReceipt.url, architect.url);
    assert.equal(savedReceipt.recordId, architect.recordId);
    assert.deepEqual(savedReceipt.inputs, [prebuild.result.records.find((record: any) => record.kind === "CONTRACT").url]);
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--allow-empty", "--quiet", "-m", "implementation after plan"], { cwd: f.root });

    const builderBody = await body(f.root, "builder", "### Delivered implementation\nThe builder implementation and behavioral proof are complete.");
    const builder = await run(["record", "--kind", "BUILDER", "--repo", "example/product", "--issue", "42", "--body-file", builderBody, "--cwd", f.root, "--publish"], f.env);
    assert.ok(builder.receiptFile);
    assert.notEqual(builder.head, f.head, "the pre-build and post-build source SHAs are allowed to differ");
    const stateAfterBuilder = JSON.parse(await readFile(f.state, "utf8"));
    const builderComment = commentAt(stateAfterBuilder, builder.url);
    const builderMetadata = recordMetadata(builderComment);
    assert.deepEqual(builderMetadata.inputs, [architect.url]);
    assert.ok(builderComment.body.includes(`**Inputs**: [source 1](${architect.url})`));

    const trajectoryBody = await body(f.root, "trajectory", "### Outcome\nThe completed work and exact build evidence are ready.");
    const trajectoryInputs = join(f.root, "trajectory-inputs.json");
    await writeFile(trajectoryInputs, JSON.stringify([{ existing: { kind: "BUILDER" } }]));
    const trajectory = await run(["record", "--kind", "TRAJECTORY", "--repo", "example/product", "--issue", "42", "--body-file", trajectoryBody, "--inputs-file", trajectoryInputs, "--cwd", f.root, "--publish"], f.env);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const trajectoryComment = commentAt(state, trajectory.url);
    assert.deepEqual(recordMetadata(trajectoryComment).inputs, [builder.url]);
    assert.ok(trajectoryComment.body.includes(`**Inputs**: [source 1](${builder.url})`));

    // Cold-start traversal begins at the terminal record and follows only its returned permalinks.
    const discovered = await run(["discover", "--repo", "example/product", "--issue", "42", "--cwd", f.root], f.env);
    const discoveredTrajectory = discovered.records.find((record: any) => record.kind === "TRAJECTORY");
    const linkedBuilderUrl = recordMetadata({ body: discoveredTrajectory.body }).inputs[0];
    const linkedBuilder = commentAt(state, linkedBuilderUrl);
    const linkedArchitectUrl = recordMetadata(linkedBuilder).inputs[0];
    const linkedArchitect = commentAt(state, linkedArchitectUrl);
    const linkedContractUrl = recordMetadata(linkedArchitect).inputs[0];
    const linkedContract = commentAt(state, linkedContractUrl);
    const linkedContextUrl = recordMetadata(linkedContract).inputs.find((url: string) => commentAt(state, url).body.startsWith("<!-- FORGE:CONTEXT -->"));
    assert.ok(linkedContextUrl);
    assert.match(commentAt(state, linkedArchitectUrl).body, /Implementation Plan/);
    assert.match(commentAt(state, linkedContractUrl).body, /Build Contract/);
    assert.match(commentAt(state, linkedContextUrl).body, /Implementation Context/);

    const repeatedPrebuild = await run(["record", "batch", "--input", prebuild.input, "--publish"], f.env);
    assert.ok(repeatedPrebuild.records.every((record: any) => record.reconciliation === "existing-identity"));
    assert.equal(repeatedPrebuild.records.find((record: any) => record.kind === "ARCHITECT").receiptFile, architect.receiptFile);
    const repeatedBuilder = await run(["record", "--kind", "BUILDER", "--repo", "example/product", "--issue", "42", "--body-file", builderBody, "--cwd", f.root, "--publish"], f.env);
    const repeatedTrajectory = await run(["record", "--kind", "TRAJECTORY", "--repo", "example/product", "--issue", "42", "--body-file", trajectoryBody, "--inputs-file", trajectoryInputs, "--cwd", f.root, "--publish"], f.env);
    assert.equal(repeatedBuilder.reconciliation, "existing-identity");
    assert.equal(repeatedBuilder.receiptFile, builder.receiptFile);
    assert.equal(repeatedTrajectory.reconciliation, "existing-identity");
    assert.equal(repeatedTrajectory.receiptFile, trajectory.receiptFile);
    assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments["42"].length, 7);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("unambiguous linked issue history can recover when a batch receipt is unavailable", async () => {
  const f = await fixture({ reviewer: false });
  try {
    const earlierArtifactRoot = join(f.root, ".git", "earlier-owner-artifacts");
    const earlierEnv = { ...f.env, FORGEDOCK_CANDIDATE_ARTIFACT_ROOT: join(f.root, ".git", "earlier-owner"), FORGEDOCK_SAFE_ARTIFACT_ROOT: earlierArtifactRoot };
    const prebuild = await publishPrebuild(f, "retained-history", earlierEnv);
    const architect = prebuild.result.records.find((record: any) => record.kind === "ARCHITECT");
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--allow-empty", "--quiet", "-m", "implementation after retained plan"], { cwd: f.root });
    const currentEnv = { ...f.env, FORGEDOCK_CANDIDATE_ARTIFACT_ROOT: join(f.root, ".git", "current-owner"), FORGEDOCK_SAFE_ARTIFACT_ROOT: join(f.root, ".git", "current-owner-artifacts") };
    const builderBody = await body(f.root, "history-fallback-builder", "### Delivered implementation\nThis Builder uses the only reachable, linked issue plan.");
    const builder = await run(["record", "--kind", "BUILDER", "--repo", "example/product", "--issue", "42", "--body-file", builderBody, "--cwd", f.root, "--publish"], currentEnv);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    assert.notEqual(builder.head, architect.head);
    assert.deepEqual(recordMetadata(commentAt(state, builder.url)).inputs, [architect.url]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("batch Builder and trajectory use same-batch record identities and retry without duplicates", async () => {
  const f = await fixture({ reviewer: false });
  try {
    const prebuild = await publishPrebuild(f, "same-batch");
    const builderBody = await body(f.root, "same-batch-builder", "### Delivered implementation\nThe batch builder links the verified current plan.");
    const trajectoryBody = await body(f.root, "same-batch-trajectory", "### Outcome\nThe terminal record links the exact Builder receipt.");
    const input = JSON.parse(await readFile(prebuild.input, "utf8"));
    input.records.push(
      { id: "builder", kind: "BUILDER", bodyFile: builderBody, head: f.head, inputs: [] },
      { id: "trajectory", kind: "TRAJECTORY", bodyFile: trajectoryBody, head: f.head },
    );
    await writeFile(prebuild.input, JSON.stringify(input));
    const first = await run(["record", "batch", "--input", prebuild.input, "--publish"], f.env);
    const archUrl = first.records.find((record: any) => record.kind === "ARCHITECT").url;
    const builderRecord = first.records.find((record: any) => record.kind === "BUILDER");
    const trajectoryRecord = first.records.find((record: any) => record.kind === "TRAJECTORY");
    assert.ok(builderRecord.receiptFile);
    assert.equal(JSON.parse(await readFile(builderRecord.receiptFile, "utf8")).url, builderRecord.url);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    assert.deepEqual(recordMetadata(commentAt(state, builderRecord.url)).inputs, [archUrl]);
    assert.ok(commentAt(state, builderRecord.url).body.includes(`**Inputs**: [source 1](${archUrl})`));
    assert.deepEqual(recordMetadata(commentAt(state, trajectoryRecord.url)).inputs, [builderRecord.url]);
    assert.ok(commentAt(state, trajectoryRecord.url).body.includes(`**Inputs**: [source 1](${builderRecord.url})`));
    const second = await run(["record", "batch", "--input", prebuild.input, "--publish"], f.env);
    assert.ok(second.records.every((record: any) => record.reconciliation === "existing-identity"));
    assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments["42"].length, 7);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("competing plans require supersession instead of selecting an unrelated newest record", async () => {
  const f = await fixture({ reviewer: false });
  try {
    const first = await publishPrebuild(f, "plan-first");
    const firstArchitect = first.result.records.find((record: any) => record.kind === "ARCHITECT");
    await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--allow-empty", "--quiet", "-m", "revised plan head"], { cwd: f.root });
    const secondHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();

    const revisedBody = await body(f.root, "plan-revised", "### Revised plan\nThis explicit successor plan supersedes the prior plan.");
    const revisedInput = join(f.root, "plan-revised.json");
    await writeFile(revisedInput, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [{ id: "architect-revised", kind: "ARCHITECT", bodyFile: revisedBody, head: secondHead, inputs: [{ existing: { kind: "CONTRACT", sourceHead: f.head } }], supersedes: firstArchitect.url }] }));
    const revised = await run(["record", "batch", "--input", revisedInput, "--publish"], f.env);
    const revisedArchitect = revised.records[0];
    const builderBody = await body(f.root, "plan-revised-builder", "### Delivered implementation\nThe work followed the explicitly superseding plan.");
    const builder = await run(["record", "--kind", "BUILDER", "--repo", "example/product", "--issue", "42", "--body-file", builderBody, "--cwd", f.root, "--publish"], f.env);
    assert.deepEqual(recordMetadata(commentAt(JSON.parse(await readFile(f.state, "utf8")), builder.url)).inputs, [revisedArchitect.url]);
    assert.notEqual(revisedArchitect.head, firstArchitect.head);

    const ambiguous = await fixture({ reviewer: false });
    try {
      const planA = await publishPrebuild(ambiguous, "ambiguous-a");
      await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--allow-empty", "--quiet", "-m", "unrelated plan"], { cwd: ambiguous.root });
      const planBHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ambiguous.root })).stdout.trim();
      const planB = await body(ambiguous.root, "ambiguous-plan-b", "### Independent plan\nThis plan does not supersede the earlier attempt.");
      const planBInput = join(ambiguous.root, "ambiguous-plan-b.json");
      await writeFile(planBInput, JSON.stringify({ repository: "example/product", issue: 42, cwd: ambiguous.root, publish: true, records: [{ id: "architect-b", kind: "ARCHITECT", bodyFile: planB, head: planBHead, inputs: [{ existing: { kind: "CONTRACT", sourceHead: ambiguous.head } }] }] }));
      await run(["record", "batch", "--input", planBInput, "--publish"], ambiguous.env);
      const blockedBuilder = await body(ambiguous.root, "ambiguous-builder", "### Builder\nRetain this authored body when plans conflict.");
      await assert.rejects(run(["record", "--kind", "BUILDER", "--repo", "example/product", "--issue", "42", "--body-file", blockedBuilder, "--cwd", ambiguous.root, "--publish"], ambiguous.env), /2 unsuperseded published ARCHITECT records[\s\S]*authored body retained/);
      assert.match(await readFile(blockedBuilder, "utf8"), /Retain this authored body/);
      const historyOnlyEnv = { ...ambiguous.env, FORGEDOCK_SAFE_ARTIFACT_ROOT: join(ambiguous.root, ".git", "history-only-artifacts") };
      const blockedHistoryBuilder = await body(ambiguous.root, "ambiguous-history-builder", "### Builder\nRetain the body when issue history contains competing plans.");
      await assert.rejects(run(["record", "--kind", "BUILDER", "--repo", "example/product", "--issue", "42", "--body-file", blockedHistoryBuilder, "--cwd", ambiguous.root, "--publish"], historyOnlyEnv), /2 unsuperseded published ARCHITECT records[\s\S]*authored body retained/);
      assert.match(await readFile(blockedHistoryBuilder, "utf8"), /competing plans/);
      assert.equal(JSON.parse(await readFile(ambiguous.state, "utf8")).comments["42"].some((comment: any) => comment.body.startsWith("<!-- FORGE:BUILDER -->")), false);
      assert.equal(planA.result.records.find((record: any) => record.kind === "ARCHITECT").head, ambiguous.head);
    } finally {
      await rm(ambiguous.root, { recursive: true, force: true });
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("missing lineage blocks Builder publication and preserves the authored body", async () => {
  const f = await fixture({ reviewer: false });
  try {
    const builderBody = await body(f.root, "missing-lineage-builder", "### Delivered implementation\nThe authored work remains available if its plan cannot be established.");
    await assert.rejects(run(["record", "--kind", "BUILDER", "--repo", "example/product", "--issue", "42", "--body-file", builderBody, "--cwd", f.root, "--publish"], f.env), /no applicable pre-build receipt or unambiguous linked ARCHITECT[\s\S]*authored body retained/);
    assert.match(await readFile(builderBody, "utf8"), /authored work remains available/);
    assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments["42"].length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("non-publishing local replay does not fabricate record permalinks", async () => {
  const f = await fixture({ reviewer: false });
  try {
    const builderBody = await body(f.root, "local-builder", "### Delivered implementation\nThis local-only record remains saved, not published.");
    const result = await run(["record", "--kind", "BUILDER", "--repo", "example/product", "--issue", "42", "--body-file", builderBody, "--cwd", f.root], f.env);
    assert.equal(result.publication, "saved");
    assert.equal(result.url, null);
    assert.equal(result.receiptFile, undefined);
    assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments["42"].length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("batch publishes distinct linked records, retries idempotently, and resolves reviewer links", async () => {
  const f = await fixture();
  try {
    const investigator = await body(f.root, "investigator", "### Claim\nThe endpoint returns the wrong status for malformed input.");
    const classification = await body(f.root, "classification", "### Classification\nBug fix; one cohesive route-boundary change.");
    const panelBody = await body(f.root, "panel", "### Disposition\nNo blocking correctness finding; retain post-rollout observation.");
    const trajectoryBody = await body(f.root, "trajectory", "### Outcome\nReviewed code is ready for the authorized merge decision.");
    const reportFile = f.reportPath;
    const input = join(f.root, "records.json");
    await writeFile(input, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [
      { id: "investigator", kind: "INVESTIGATOR", bodyFile: investigator, head: f.head },
      { id: "classification", kind: "CLASSIFICATION", bodyFile: classification, head: f.head, inputs: [{ record: "investigator" }] },
      { id: "panel", kind: "REVIEW-PANEL", pullRequest: 7, bodyFile: panelBody, head: f.head, baseRef: "integration", baseSha: f.base, reviewRoot: f.reviewRoot, artifactKey: f.artifactKey, inputs: [{ existing: { kind: "CLASSIFICATION" } }], reviewerReports: [{ role: "correctness", reportFile }] },
      { id: "trajectory", kind: "TRAJECTORY", bodyFile: trajectoryBody, head: f.head, inputs: [{ existing: { kind: "INVESTIGATOR" } }, { existing: { kind: "REVIEW-PANEL", pullRequest: 7 } }] },
    ] }));
    const first = await run(["record", "batch", "--input", input, "--publish"], f.env);
    assert.equal(first.records.length, 4);
    assert.match(first.records[1].url, /issuecomment-/);
    assert.match(first.records[2].url, /issuecomment-/);
    assert.match(await readFile(first.records[2].reportFile, "utf8"), /Individual reviewer reports/);

    const second = await run(["record", "batch", "--input", input, "--publish"], f.env);
    assert.deepEqual(second.records.map((record: any) => record.reconciliation), ["existing-identity", "existing-identity", "existing-identity", "existing-identity"]);
    const state = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(state.comments["42"].length, 3);
    assert.equal(state.comments["7"].length, 2);
    assert.equal(state.comments["7"].filter((comment: any) => comment.body.includes("FORGE:REVIEW-PANEL")).length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("standard review preserves the original base after an unrelated target advance", async () => {
  const f = await fixture();
  try {
    const reportFile = f.reportPath;
    const panelBody = await body(f.root, "standard-panel", "### Disposition\nThe unchanged clean patch remains approved after target-only movement.");
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.pullRequests["7"].baseRefOid = "c".repeat(40);
    await writeFile(f.state, JSON.stringify(state));
    const input = join(f.root, "standard.json");
    await writeFile(input, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [{ id: "panel", kind: "REVIEW-PANEL", pullRequest: 7, bodyFile: panelBody, head: f.head, baseRef: "integration", baseSha: f.base, reviewRoot: f.reviewRoot, artifactKey: f.artifactKey, reviewerReports: [{ role: "correctness", reportFile }] }] }));
    const first = await run(["record", "batch", "--input", input, "--publish"], f.env);
    assert.equal(first.records[0].reconciliation, "created");
    assert.match(await readFile(first.records[0].reportFile, "utf8"), new RegExp(f.base));
    const second = await run(["record", "batch", "--input", input, "--publish"], f.env);
    assert.equal(second.records[0].reconciliation, "existing-identity");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("review panel rejects source changes, retargeting, conflicts, and bad protected bases", async () => {
  const cases = [
    { name: "source", mutate: (state: any) => { state.pullRequests["7"].headRefOid = "d".repeat(40); } },
    { name: "retarget", mutate: (state: any) => { state.pullRequests["7"].baseRefName = "other"; } },
    { name: "conflict", mutate: (state: any) => { state.pullRequests["7"].mergeable = "CONFLICTING"; } },
  ];
  for (const current of cases) {
    const f = await fixture();
    try {
      const reportFile = f.reportPath;
      const panelBody = await body(f.root, `${current.name}-panel`, "### Disposition\nThis record must not publish for the invalid live identity.");
      const state = JSON.parse(await readFile(f.state, "utf8"));
      current.mutate(state);
      await writeFile(f.state, JSON.stringify(state));
      const input = join(f.root, `${current.name}.json`);
      await writeFile(input, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [{ id: "panel", kind: "REVIEW-PANEL", pullRequest: 7, bodyFile: panelBody, head: f.head, baseRef: "integration", baseSha: f.base, reviewRoot: f.reviewRoot, artifactKey: f.artifactKey, reviewerReports: [{ role: "correctness", reportFile }] }] }));
      await assert.rejects(run(["record", "batch", "--input", input, "--publish"], f.env), /REVIEW-PANEL/);
      assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments["7"].length, 1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }

  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.pullRequests["8"] = { headRefOid: f.head, baseRefName: "main", baseRefOid: "c".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
    state.comments["8"] = [];
    await writeFile(f.state, JSON.stringify(state));
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", f.base], { cwd: f.root });
    const protectedReview = await preparedReviewerArtifact(f.root, f.env, 8, f.head, "main", f.base);
    const reportFile = protectedReview.reportPath;
    const panelBody = await body(f.root, "protected-panel", "### Disposition\nProtected promotion must retain the exact base.");
    const input = join(f.root, "protected.json");
    await writeFile(input, JSON.stringify({ repository: "example/product", cwd: f.root, publish: true, records: [{ id: "panel", kind: "REVIEW-PANEL", pullRequest: 8, bodyFile: panelBody, head: f.head, baseRef: "main", baseSha: f.base, mode: "staging", reviewRoot: protectedReview.reviewRoot, artifactKey: protectedReview.artifactKey, reviewerReports: [{ role: "correctness", reportFile }] }] }));
    await assert.rejects(run(["record", "batch", "--input", input, "--publish"], f.env), /protected promotion base/);
    assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments["8"].length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("revised same-head records require supersedes and lost creates reconcile", async () => {
  const f = await fixture();
  try {
    const firstBody = await body(f.root, "first", "### Decision\nThe first bounded decision text.");
    const firstInput = join(f.root, "first.json");
    await writeFile(firstInput, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [{ id: "decision", kind: "TRAJECTORY", bodyFile: firstBody, head: f.head }] }));
    const first = await run(["record", "batch", "--input", firstInput, "--publish"], f.env);

    const revisedBody = await body(f.root, "revised", "### Decision\nThe revised bounded decision with a new limitation.");
    const revisedInput = join(f.root, "revised.json");
    await writeFile(revisedInput, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [{ id: "decision-revised", kind: "TRAJECTORY", bodyFile: revisedBody, head: f.head, supersedes: first.records[0].url }] }));
    const revised = await run(["record", "batch", "--input", revisedInput, "--publish"], f.env);
    assert.equal(revised.records[0].reconciliation, "created");
    assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments["42"].length, 2);

    const retryBody = await body(f.root, "retry", "### Investigation\nThe create response may be lost but the marker is stable.");
    const retryInput = join(f.root, "retry.json");
    await writeFile(retryInput, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [{ id: "retry", kind: "INVESTIGATOR", bodyFile: retryBody, head: f.head }] }));
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.failNextCommentCreate = true;
    await writeFile(f.state, JSON.stringify(state));
    const retried = await run(["record", "batch", "--input", retryInput, "--publish"], f.env);
    assert.equal(retried.records[0].reconciliation, "ambiguous-create-reconciled");
    assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments["42"].length, 3);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("workflow label transitions preserve unrelated labels and are no-op safe", async () => {
  const f = await fixture();
  try {
    const first = await run(["label", "--repo", "example/product", "--issue", "42", "--state", "investigating", "--cwd", f.root], f.env);
    assert.equal(first.label, "workflow:investigating");
    assert.equal(first.changed, true);
    assert.deepEqual(new Set(first.after), new Set(["bug", "priority:P1", "needs-human", "workflow:investigating"]));

    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.labels.push("workflow:building", "review-finding");
    await writeFile(f.state, JSON.stringify(state));
    const second = await run(["label", "--repo", "example/product", "--issue", "42", "--state", "in-review", "--cwd", f.root], f.env);
    assert.equal(second.label, "workflow:in-review");
    assert.equal(second.after.includes("workflow:building"), false);
    assert.equal(second.after.includes("review-finding"), true);
    assert.equal(second.after.includes("needs-human"), true);

    const third = await run(["label", "--repo", "example/product", "--issue", "42", "--state", "in-review", "--cwd", f.root], f.env);
    assert.equal(third.changed, false);
    const finalState = JSON.parse(await readFile(f.state, "utf8"));
    assert.equal(finalState.labels.filter((label: string) => label === "workflow:in-review").length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("label transitions use existing workflow aliases without creating replacements", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.labels.push("workflow:reviewing");
    await writeFile(f.state, JSON.stringify(state));
    const reviewing = await run(["label", "--repo", "example/product", "--issue", "42", "--state", "in-review", "--cwd", f.root], f.env);
    assert.equal(reviewing.label, "workflow:reviewing");
    assert.equal(reviewing.created, false);
    assert.equal(reviewing.after.includes("workflow:built"), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("label mutations reconcile lost responses without repeating engineering", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.failNextLabelAdd = true;
    await writeFile(f.state, JSON.stringify(state));
    const added = await run(["label", "--repo", "example/product", "--issue", "42", "--state", "investigating", "--cwd", f.root], f.env);
    assert.deepEqual(added.reconciliations, [{ label: "workflow:investigating", outcome: "ambiguous-label-reconciled" }]);

    const afterAdd = JSON.parse(await readFile(f.state, "utf8"));
    afterAdd.labels.push("workflow:building", "workflow:in-review");
    afterAdd.failNextLabelDelete = true;
    await writeFile(f.state, JSON.stringify(afterAdd));
    const removed = await run(["label", "--repo", "example/product", "--issue", "42", "--state", "awaiting-merge", "--cwd", f.root], f.env);
    assert.equal(removed.reconciliations.length, 1);
    assert.equal(removed.after.includes("workflow:building"), false);
    assert.equal(removed.after.includes("workflow:in-review"), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("publication and label permission failures remain explicit", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.denyLabelCreate = true;
    state.denyCommentCreate = true;
    await writeFile(f.state, JSON.stringify(state));
    await assert.rejects(
      run(["label", "--repo", "example/product", "--issue", "42", "--state", "investigating", "--cwd", f.root], f.env),
      /failed/i,
    );
    const bodyFile = await body(f.root, "blocked", "### Evidence\nPublication authority is unavailable.");
    const input = join(f.root, "blocked.json");
    await writeFile(input, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [{ id: "blocked", kind: "GATED", bodyFile, head: f.head }] }));
    await assert.rejects(run(["record", "batch", "--input", input, "--publish"], f.env), /failed|error/i);
    assert.equal(JSON.parse(await readFile(f.state, "utf8")).comments["42"].length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("active work-on instructions require durable labels, linked records, and no extra agent", async () => {
  const skill = await readFile("candidate/skills/forgedock-work-on/SKILL.md", "utf8");
  const owner = await readFile("candidate/agents/forgedock-owner.md", "utf8");
  const orchestrate = await readFile("candidate/skills/forgedock-orchestrate/SKILL.md", "utf8");
  const review = await readFile("candidate/skills/forgedock-review-pr/SKILL.md", "utf8");
  assert.match(skill, /discover --repo/);
  assert.match(skill, /record batch --input <records\.json> --publish/);
  assert.match(skill, /exact read-back publication receipts/);
  assert.match(owner, /let `TRAJECTORY` resolve the exact Builder receipt/);
  assert.match(skill, /workflow:investigating/);
  assert.match(skill, /workflow:awaiting-merge/);
  assert.match(skill, /workflow:gated/);
  assert.match(skill, /REVIEW-PANEL/);
  assert.match(review, /target-branch move alone does not[\s\S]*invalidate/);
  assert.match(skill, /TRAJECTORY/);
  assert.match(owner, /distinct issue records/);
  assert.doesNotMatch(owner, /create investigation, builder, quality-gate, remediation, or coordinator children/);
  assert.match(orchestrate, /discover its issue[\s\S]*records and current labels once/);
});

test("discovery returns new and legacy records without hiding ordinary comments", async () => {
  const f = await fixture();
  try {
    const state = JSON.parse(await readFile(f.state, "utf8"));
    const recordId = `sha256:${"a".repeat(64)}`;
    state.comments["42"].push(
      { id: 10, body: `<!-- FORGE:INVESTIGATOR -->\n<!-- FORGE:RECORD ${JSON.stringify({ v: 1, record_id: recordId, source_head: f.head, inputs: [], supersedes: null })} -->\n## Investigation\nCause`, html_url: "https://github.com/example/product/issues/42#issuecomment-10" },
      { id: 11, body: `<!-- FORGE:CANDIDATE:BUILD ${JSON.stringify({ v: 1, source_head: f.head })} -->\nlegacy build`, html_url: "https://github.com/example/product/issues/42#issuecomment-11" },
      { id: 12, body: "ordinary context", html_url: "https://github.com/example/product/issues/42#issuecomment-12" },
    );
    await writeFile(f.state, JSON.stringify(state));
    const result = await run(["discover", "--repo", "example/product", "--issue", "42", "--cwd", f.root], f.env);
    assert.deepEqual(result.records.map((record: any) => record.kind), ["INVESTIGATOR", "BUILD"]);
    assert.equal(result.unclassifiedComments.length, 1);
    assert.equal(result.records[0].metadata.record_id.startsWith("sha256:"), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
