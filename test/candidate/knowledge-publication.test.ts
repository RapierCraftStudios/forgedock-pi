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

async function fixture() {
  const root = await mkdtemp("/tmp/forgedock-candidate-knowledge-");
  const fakeBin = join(root, "bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "gh"), fakeGh, { mode: 0o755 });
  await writeFile(join(root, "README.md"), "knowledge fixture\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: root });
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "base"], { cwd: root });
  await writeFile(join(root, "forge.yaml"), forgeYaml);
  await execFileAsync("git", ["add", "forge.yaml"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Candidate Test", "commit", "--quiet", "-m", "fixture"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const base = (await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd: root })).stdout.trim();
  const state = join(root, "gh-state.json");
  await writeFile(state, JSON.stringify({ labels: ["bug", "priority:P1", "needs-human"], comments: { "42": [], "7": [{ id: 9, body: `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ v: 1, repository: "example/product", pullRequest: 7, head, baseRef: "integration", baseSha: base, role: "correctness" })} -->\nreview report`, html_url: "https://github.com/example/product/pull/7#issuecomment-9" }] }, pullRequests: { "7": { headRefOid: head, baseRefName: "integration", baseRefOid: base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } }, nextId: 100, operations: [] }));
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_GH_STATE: state };
  return { root, state, head, base, env };
}

async function body(root: string, name: string, content: string) {
  const file = join(root, `${name}.md`);
  await writeFile(file, content);
  return file;
}

async function run(args: string[], env: NodeJS.ProcessEnv) {
  return JSON.parse((await execFileAsync("node", [helper, ...args], { env })).stdout) as Record<string, any>;
}

test("batch publishes distinct linked records, retries idempotently, and resolves reviewer links", async () => {
  const f = await fixture();
  try {
    const investigator = await body(f.root, "investigator", "### Claim\nThe endpoint returns the wrong status for malformed input.");
    const classification = await body(f.root, "classification", "### Classification\nBug fix; one cohesive route-boundary change.");
    const panelBody = await body(f.root, "panel", "### Disposition\nNo blocking correctness finding; retain post-rollout observation.");
    const trajectoryBody = await body(f.root, "trajectory", "### Outcome\nReviewed code is ready for the authorized merge decision.");
    const reportFile = join(f.root, "correctness.report.md");
    await writeFile(reportFile, `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ v: 1, repository: "example/product", pullRequest: 7, head: f.head, baseRef: "integration", baseSha: f.base, role: "correctness" })} -->\nreview report\n`);
    const input = join(f.root, "records.json");
    await writeFile(input, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [
      { id: "investigator", kind: "INVESTIGATOR", bodyFile: investigator, head: f.head },
      { id: "classification", kind: "CLASSIFICATION", bodyFile: classification, head: f.head, inputs: [{ record: "investigator" }] },
      { id: "panel", kind: "REVIEW-PANEL", pullRequest: 7, bodyFile: panelBody, head: f.head, baseRef: "integration", baseSha: f.base, inputs: [{ existing: { kind: "CLASSIFICATION" } }], reviewerReports: [{ role: "correctness", reportFile }] },
      { id: "trajectory", kind: "TRAJECTORY", bodyFile: trajectoryBody, head: f.head, inputs: [{ existing: { kind: "INVESTIGATOR" } }, { existing: { kind: "REVIEW-PANEL", pullRequest: 7 } }] },
    ] }));
    const first = await run(["record", "batch", "--input", input, "--publish"], f.env);
    assert.equal(first.records.length, 4);
    assert.match(first.records[1].url, /issuecomment-/);
    assert.match(first.records[2].url, /issuecomment-/);
    assert.match(await readFile(join(f.root, "panel.record.md"), "utf8"), /Individual reviewer reports/);

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
    const reportFile = join(f.root, "correctness.report.md");
    await writeFile(reportFile, `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ v: 1, repository: "example/product", pullRequest: 7, head: f.head, baseRef: "integration", baseSha: f.base, role: "correctness" })} -->\nreview report\n`);
    const panelBody = await body(f.root, "standard-panel", "### Disposition\nThe unchanged clean patch remains approved after target-only movement.");
    const state = JSON.parse(await readFile(f.state, "utf8"));
    state.pullRequests["7"].baseRefOid = "c".repeat(40);
    await writeFile(f.state, JSON.stringify(state));
    const input = join(f.root, "standard.json");
    await writeFile(input, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [{ id: "panel", kind: "REVIEW-PANEL", pullRequest: 7, bodyFile: panelBody, head: f.head, baseRef: "integration", baseSha: f.base, reviewerReports: [{ role: "correctness", reportFile }] }] }));
    const first = await run(["record", "batch", "--input", input, "--publish"], f.env);
    assert.equal(first.records[0].reconciliation, "created");
    assert.match(await readFile(join(f.root, "panel.record.md"), "utf8"), new RegExp(f.base));
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
      const reportFile = join(f.root, `${current.name}.report.md`);
      await writeFile(reportFile, `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ v: 1, repository: "example/product", pullRequest: 7, head: f.head, baseRef: "integration", baseSha: f.base, role: "correctness" })} -->\nreview report\n`);
      const panelBody = await body(f.root, `${current.name}-panel`, "### Disposition\nThis record must not publish for the invalid live identity.");
      const state = JSON.parse(await readFile(f.state, "utf8"));
      current.mutate(state);
      await writeFile(f.state, JSON.stringify(state));
      const input = join(f.root, `${current.name}.json`);
      await writeFile(input, JSON.stringify({ repository: "example/product", issue: 42, cwd: f.root, publish: true, records: [{ id: "panel", kind: "REVIEW-PANEL", pullRequest: 7, bodyFile: panelBody, head: f.head, baseRef: "integration", baseSha: f.base, reviewerReports: [{ role: "correctness", reportFile }] }] }));
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
    state.comments["8"] = [{ id: 10, body: `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ v: 1, repository: "example/product", pullRequest: 8, head: f.head, baseRef: "main", baseSha: f.base, role: "correctness" })} -->\nreview report\n`, html_url: "https://github.com/example/product/pull/8#issuecomment-10" }];
    await writeFile(f.state, JSON.stringify(state));
    const reportFile = join(f.root, "protected.report.md");
    await writeFile(reportFile, `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ v: 1, repository: "example/product", pullRequest: 8, head: f.head, baseRef: "main", baseSha: f.base, role: "correctness" })} -->\nreview report\n`);
    const panelBody = await body(f.root, "protected-panel", "### Disposition\nProtected promotion must retain the exact base.");
    const input = join(f.root, "protected.json");
    await writeFile(input, JSON.stringify({ repository: "example/product", cwd: f.root, publish: true, records: [{ id: "panel", kind: "REVIEW-PANEL", pullRequest: 8, bodyFile: panelBody, head: f.head, baseRef: "main", baseSha: f.base, mode: "staging", reviewerReports: [{ role: "correctness", reportFile }] }] }));
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
  assert.match(skill, /workflow:investigating/);
  assert.match(skill, /workflow:awaiting-merge/);
  assert.match(skill, /workflow:gated/);
  assert.match(skill, /REVIEW-PANEL/);
  assert.match(review, /target-branch move alone does not invalidate/);
  assert.match(skill, /TRAJECTORY/);
  assert.match(owner, /distinct issue records/);
  assert.doesNotMatch(owner, /create investigation, builder, quality-gate, remediation, or coordinator children/);
  assert.match(orchestrate, /discover its issue records and current labels once/);
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
