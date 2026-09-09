import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
const dispatch = await import(new URL("../../specs/helpers/dispatch.mjs", import.meta.url).href);
const records = await import(new URL("../../specs/helpers/record.mjs", import.meta.url).href);

async function fixture(run: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "forge-mechanics-"));
  const repo = join(root, "repo"); await mkdir(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/project.git"], { cwd: repo });
  await writeFile(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base"], { cwd: repo });
  await writeFile(join(repo, "forge.yaml"), 'project: {owner: example, repo: project}\nagents: {subagent_model: "openai-codex/gpt-5.6-luna"}\norchestration: {max_concurrent: 3}\nprivate_value: do-not-print-this\n');
  const makeContract = async (issue: number) => {
    const contract = dispatch.createIssueContract(issue, [
      { id: "source-behavior", textHash: `sha256:${"1".repeat(64)}`, proofType: "behavioral", affectedBoundaries: ["src/example.ts"] },
      { id: "source-safety", textHash: `sha256:${"2".repeat(64)}`, proofType: "unit", affectedBoundaries: ["test/example.test.ts"] },
    ]);
    const path = join(root, `contract-${issue}.json`);
    const bytes = `${JSON.stringify(contract)}\n`;
    await writeFile(path, bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const plan = { activeOwners: 2, launchAllowance: 24, requestStartedAt: "2026-01-01T00:00:00Z", issues: [
    { number: 33724, target: "staging", baseCwd: repo, predecessors: [], contract: await makeContract(33724) },
    { number: 33745, target: "staging", baseCwd: repo, predecessors: [], contract: await makeContract(33745) },
  ] };
  try { await run({ root, repo, plan }); } finally { await rm(root, { recursive: true, force: true }); }
}

test("prepared requests bind one canonical model/cap despite absent child config and stale neighbours", async () => {
  await fixture(async ({ root, repo, plan }) => {
    const child = join(root, "child"), neighbour = join(root, "old-worktree"); await mkdir(child); await mkdir(neighbour);
    await writeFile(join(neighbour, "forge.yaml"), 'agents: {subagent_model: "anthropic/stale"}\nreview: {remediation_max_rounds: 4}\n');
    const prepared = dispatch.prepareBatch(plan, join(root, "prepared"), repo);
    const batch = JSON.parse(await readFile(prepared.batchFile, "utf8"));
    const lane = batch.lanes[1]; const env = { PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ [dispatch.BINDING]: lane.input }) };
    const policy = dispatch.loadPolicy(undefined, env);
    assert.equal(policy.issue, 33745); assert.equal(policy.repo, "example/project");
    assert.equal(policy.model, "openai-codex/gpt-5.6-luna"); assert.equal(policy.remediationLimit, 1);
    assert.equal(fs.existsSync(join(child, "forge.yaml")), false);
    assert.throws(() => dispatch.loadPolicy(undefined, {}), /Missing authoritative lane input/);
    assert.throws(() => dispatch.loadPolicy(batch.lanes[0].input, env), /disagrees/);
    assert.equal(JSON.stringify(prepared.request).includes("do-not-print-this"), false);
    const script = await readFile(prepared.request.workflowScriptPath, "utf8");
    assert.ok(script.includes('"launch":{"agent":"forgedock-work-on-coordinator"'));
    assert.equal(script.includes("do-not-print-this"), false);
    assert.equal(prepared.request.globalConcurrencyLimit, 2);
    assert.equal(prepared.request.maxSubagentSpawnsPerRun, 24);
    assert.equal(policy.config.sha256.length, 64);
    const graph = JSON.parse(script.match(/^const issueGraph=(.+);$/m)![1]!);
    assert.deepEqual(graph[1].launch.acceptance.criteria.map((criterion: { id: string }) => criterion.id), ["source-behavior", "source-safety"]);
    assert.match(script, /exactAcceptanceSatisfied/);
    assert.match(script, /Bound issue acceptance criteria were missing/);
    const cli = execFileSync(process.execPath, [fileURLToPath(new URL("../../specs/helpers/dispatch.mjs", import.meta.url)), "context"], { cwd: child, env: { ...process.env, ...env }, encoding: "utf8" });
    assert.equal(JSON.parse(cli).remediationLimit, 1);
    assert.equal(cli.includes("do-not-print-this"), false);
  });
});

test("contract descriptors are exact, immutable, and fail closed before launch", async () => {
  await fixture(async ({ root, repo, plan }) => {
    assert.throws(
      () => dispatch.prepareBatch({ ...plan, issues: [{ ...plan.issues[0], contract: undefined }] }, join(root, "missing"), repo),
      /contract descriptor/,
    );
    const original = plan.issues[0].contract;
    await writeFile(original.path, `${JSON.stringify(dispatch.createIssueContract(33724, [{ id: "changed", textHash: `sha256:${"4".repeat(64)}`, proofType: "behavioral", affectedBoundaries: ["src/example.ts"] }]) )}\n`);
    assert.throws(
      () => dispatch.prepareBatch(plan, join(root, "stale"), repo),
      /Contract descriptor digest mismatch/,
    );
    const tampered = dispatch.createIssueContract(33724, [{ id: "source", textHash: `sha256:${"5".repeat(64)}`, proofType: "behavioral", affectedBoundaries: ["src/example.ts"] }]);
    tampered.digest = `sha256:${"0".repeat(64)}`;
    const tamperedPath = join(root, "tampered-contract.json");
    const tamperedBytes = `${JSON.stringify(tampered)}\n`;
    await writeFile(tamperedPath, tamperedBytes);
    assert.throws(
      () => dispatch.prepareBatch({ ...plan, issues: [{ ...plan.issues[0], contract: { path: tamperedPath, sha256: createHash("sha256").update(tamperedBytes).digest("hex") } }] }, join(root, "tampered"), repo),
      /Contract digest does not match/,
    );
  });
});

test("generated recipe rejects omitted, missing, extra, and generic owner criteria", async () => {
  await fixture(async ({ root, repo, plan }) => {
    const prepared = dispatch.prepareBatch(plan, join(root, "prepared"), repo);
    const script = await readFile(prepared.request.workflowScriptPath, "utf8");
    const graph = JSON.parse(script.match(/^const issueGraph=(.+);$/m)![1]!);
    const execute = async (mutate: (result: any, index: number) => any) => {
      const responses = graph.map((node: any, index: number) => {
        const criteria = node.launch.acceptance.criteria;
        const result = { ok: true, output: `FORGE_WORK_ON_RESULT status=DONE issue=${node.issue} pr=none dependency=SATISFIED`, acceptance: { effectiveAcceptance: { criteria }, childReport: { criteriaSatisfied: criteria.map((criterion: any) => ({ id: criterion.id, status: "satisfied" })) } } };
        return mutate(result, index);
      });
      return runInNewContext(`(async () => {\n${script}\n})()`, { runs: { all: async () => [responses.shift()] } });
    };
    assert.ok((await execute((result, index) => index === 0 ? { ...result, acceptance: undefined } : result))[0].ok === false);
    assert.ok((await execute((result, index) => index === 0 ? { ...result, acceptance: { ...result.acceptance, childReport: { criteriaSatisfied: [] } } } : result))[0].ok === false);
    assert.ok((await execute((result, index) => index === 0 ? { ...result, acceptance: { ...result.acceptance, effectiveAcceptance: { criteria: [...result.acceptance.effectiveAcceptance.criteria, { id: "extra", must: "extra" }] } } } : result))[0].ok === false);
    assert.ok((await execute((result, index) => index === 0 ? { ...result, acceptance: { ...result.acceptance, childReport: { criteriaSatisfied: [{ id: "criterion-1", status: "satisfied" }] } } } : result))[0].ok === false);
  });
});

test("bad launch shape fails before request publication, not inside native dispatch", async () => {
  await fixture(async ({ root, repo, plan }) => {
    const out = join(root, "bad");
    assert.throws(() => dispatch.prepareBatch({ ...plan, issues: [{ launch: { agent: "wrong-level" } }] }, out, repo), /Unknown issue field|issue number/);
    assert.equal(fs.existsSync(out), false);
  });
});

test("review preparation cannot substitute a model, duplicate correctness or exceed bound rounds", async () => {
  await fixture(async ({ root, repo, plan }) => {
    const prepared = dispatch.prepareBatch(plan, join(root, "prepared"), repo);
    const batch = JSON.parse(await readFile(prepared.batchFile, "utf8"));
    const env = { PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ [dispatch.BINDING]: batch.lanes[0].input }) };
    const policy = dispatch.loadPolicy(undefined, env);
    const boundContract = JSON.parse(await readFile(policy.contract.path, "utf8"));
    const review = { head: dispatch.gitHead(repo), round: 1, contractDigest: policy.contractDigest, criterionIds: boundContract.criteria.map((criterion: { id: string }) => criterion.id), roles: [{ role: "correctness", thinking: "high", task: "Review only" }] };
    assert.throws(() => dispatch.prepareReview({ ...review, round: 4 }, join(root, "over"), env), /exceeds bound remediation limit 1/);
    assert.throws(() => dispatch.prepareReview({ ...review, roles: [{ ...review.roles[0], model: "anthropic/stale" }] }, join(root, "model"), env), /Unknown role field: model/);
    assert.throws(() => dispatch.prepareReview({ ...review, roles: [...review.roles, { role: "general", thinking: "high", task: "Duplicate" }] }, join(root, "dupe"), env), /Duplicate/);
    assert.throws(() => dispatch.prepareReview({ ...review, criterionIds: ["source-behavior"] }, join(root, "missing-criterion"), env), /exactly match/);
    assert.throws(() => dispatch.prepareReview({ ...review, criterionIds: ["criterion-1", "source-safety"] }, join(root, "generic-criterion"), env), /exactly match/);
    const valid = dispatch.prepareReview(review, join(root, "review"), env);
    const reviewScript = await readFile(valid.request.workflowScriptPath, "utf8");
    assert.match(reviewScript, /openai-codex\/gpt-5.6-luna:high/);
    assert.match(reviewScript, /agentScope":"user"/);
  });
});

test("supervisor identity resolves the exact run ID, never the shared child index zero", async () => {
  await fixture(async ({ root, repo, plan }) => {
    const prepared = dispatch.prepareBatch(plan, join(root, "prepared"), repo);
    const batch = JSON.parse(await readFile(prepared.batchFile, "utf8"));
    const status = { runId: "batch", steps: [
      { runId: "owner-a", workflowKey: batch.lanes[0].key, index: 0 },
      { runId: "owner-b", workflowKey: batch.lanes[1].key, index: 0 },
    ] };
    assert.equal(dispatch.identifyLane(batch, status, "owner-b").issue, 33745);
    status.steps.push({ runId: "recovered-b", workflowKey: `${batch.lanes[1].key}-recovery`, index: 0 });
    assert.equal(dispatch.identifyLane(batch, status, "recovered-b").issue, 33745);
    assert.throws(() => dispatch.identifyLane(batch, status, "unknown"), /absent or ambiguous/);
    assert.throws(() => dispatch.identifyLane({ ...batch, repo: "wrong/repo" }, status, "owner-b"), /digest-bound prepared batch/);
    const other = dispatch.prepareBatch(plan, join(root, "other-batch"), repo);
    assert.throws(() => dispatch.identifyLane(JSON.parse(fs.readFileSync(other.batchFile, "utf8")), status, "owner-b"), /exact prepared batch/);
    const stale = structuredClone(batch); stale.lanes[1].target = "main";
    assert.throws(() => dispatch.identifyLane(stale, status, "owner-b"), /digest-bound prepared batch/);
  });
});

test("record rendering derives identity and treats shell metacharacters as literal data", async () => {
  await fixture(async ({ root, repo, plan }) => {
    const prepared = dispatch.prepareBatch(plan, join(root, "prepared"), repo);
    const batch = JSON.parse(await readFile(prepared.batchFile, "utf8"));
    const env = { PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ [dispatch.BINDING]: batch.lanes[1].input }) };
    const marker = join(root, "must-not-exist");
    const body = `### Decision\nKeep \`literal-code\` and $(touch ${marker}) literally.\n`;
    const draft = { kind: "REMEDIATION", round: 1, inputs: [], supersedes: null };
    const rendered = records.renderRecord(draft, body, { cwd: repo, env });
    assert.equal(rendered.target, 33745); assert.ok(rendered.markdown.includes(body.trim()));
    assert.ok(rendered.markdown.includes("**Remediation round**: 1/1"));
    assert.ok(rendered.markdown.includes(dispatch.gitHead(repo))); assert.equal(fs.existsSync(marker), false);
    assert.throws(() => records.renderRecord({ ...draft, round: 4 }, body, { cwd: repo, env }), /bound policy/);
    assert.throws(() => records.renderRecord(draft, "**Head**: invented", { cwd: repo, env }), /generated/);
    const output = join(root, "record.md"); await writeFile(output, rendered.markdown);
    const calls: string[][] = [];
    const stored = { id: 123, body: rendered.markdown, html_url: "https://github.com/example/project/issues/33745#issuecomment-123" };
    const gh = (args: string[]) => { calls.push(args); return args.includes("--slurp") ? "[[]]" : JSON.stringify(stored); };
    const receipt = records.publishRecord(rendered, output, gh);
    assert.equal(receipt.issue, 33745);
    assert.ok(calls.some(args => args.includes("repos/example/project/issues/33745/comments") && args.includes(`body=@${output}`)));
    const reused = records.publishRecord(rendered, output, (args: string[]) => args.includes("--slurp") ? JSON.stringify([[stored]]) : JSON.stringify(stored));
    assert.equal(reused.reused, true);
    assert.throws(() => records.publishRecord(rendered, output, (args: string[]) => args.includes("--slurp") ? "[[]]" : JSON.stringify({ ...stored, html_url: "https://github.com/example/project/issues/33724#issuecomment-123" })), /destination identity/);
    const review = records.renderRecord({ kind: "REVIEW-PANEL", pr: 99, inputs: [] }, body, { cwd: repo, env });
    const reviewFile = join(root, "review.md"); await writeFile(reviewFile, review.markdown);
    for (const mismatch of [{ headRefOid: "0".repeat(40), baseRefName: "staging" }, { headRefOid: review.head, baseRefName: "main" }]) {
      assert.throws(() => records.publishRecord(review, reviewFile, () => JSON.stringify(mismatch)), /PR head\/target/);
    }
  });
});


test("standalone policy and corrupt descriptor handling", async () => {
  await fixture(async ({ root, repo }) => {
    const contract = dispatch.createIssueContract(42, [{ id: "source", textHash: `sha256:${"3".repeat(64)}`, proofType: "behavioral", affectedBoundaries: ["src/example.ts"] }]);
    const contractPath = join(root, "contract-42.json");
    const contractBytes = `${JSON.stringify(contract)}\n`;
    await writeFile(contractPath, contractBytes);
    const contractDescriptor = { path: contractPath, sha256: createHash("sha256").update(contractBytes).digest("hex") };
    const single = dispatch.prepareSingle({ number: 42, target: "staging", contract: contractDescriptor }, join(root, "single"), repo);
    assert.equal(dispatch.loadPolicy(single.input, {}).issue, 42);
    assert.throws(() => dispatch.loadPolicy({ ...single.input, sha256: "0".repeat(64) }, {}), /digest mismatch/);
    const policy = JSON.parse(await readFile(single.input.path, "utf8"));
    delete policy.contract; delete policy.contractDigest;
    const legacyBytes = `${JSON.stringify(policy)}\n`;
    const legacyPath = join(root, "legacy-lane.json"); await writeFile(legacyPath, legacyBytes);
    const legacy = { path: legacyPath, sha256: createHash("sha256").update(legacyBytes).digest("hex") };
    assert.throws(() => dispatch.loadPolicy(legacy, {}), /contract is missing/i);
    assert.equal(dispatch.loadPolicy(legacy, {}, true).issue, 42);
    assert.equal(fs.existsSync(join(root, "single", "config.snapshot.yaml")), false);
  });
});

test("unlinked standalone PR publication does not require an invented issue policy", async () => {
  const spec = await readFile("specs/knowledge-records.md", "utf8");
  assert.match(spec, /standalone PR review without a bound work-on issue retains direct file-backed/);
  assert.match(spec, /Do not invent an issue or lane policy/);
});
