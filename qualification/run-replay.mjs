#!/usr/bin/env node
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const EXEC = process.platform === "win32" ? "pi.cmd" : "pi";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) continue;
    const key = value.slice(2);
    if (key === "help" || key === "preflight-only") values.set(key, "true");
    else values.set(key, argv[++index]);
  }
  return values;
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return resolve(value);
}

function requiredText(values, key) {
  const value = values.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing --${key}`);
  return value.trim();
}

async function git(cwd, args) {
  const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise((done) => child.on("close", done));
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim().slice(-800)}`);
  return stdout.trim();
}

async function run(cwd, command, args, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise((done) => child.on("close", done));
  return { code, stdout, stderr };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function copyFixture(mode, sandbox) {
  const fixtureName = mode === "owner" ? "owner-replay" : "orchestration-replay";
  const fixture = join(HERE, "fixtures", fixtureName);
  const source = join(sandbox, "seed");
  await cp(join(fixture, "product"), source, { recursive: true });
  const issueFile = join(sandbox, mode === "owner" ? "issue.json" : "orchestrate-issues.json");
  await cp(join(fixture, mode === "owner" ? "issue.json" : "orchestrate-issues.json"), issueFile);
  return { source, issueFile };
}

async function createRepository(mode, sandbox) {
  const { source, issueFile } = await copyFixture(mode, sandbox);
  const remote = join(sandbox, "example", "product.git");
  await mkdir(dirname(remote), { recursive: true });
  await git(sandbox, ["init", "--bare", "--quiet", remote]);
  await git(source, ["init", "--quiet"]);
  await git(source, ["remote", "add", "origin", `file://${remote}`]);
  await git(source, ["add", "."]);
  await git(source, ["-c", "user.email=qualification@example.com", "-c", "user.name=Qualification", "commit", "--quiet", "-m", "replay baseline"]);
  await git(source, ["branch", "-M", "integration"]);
  await git(source, ["push", "--quiet", "-u", "origin", "integration"]);
  const baseHead = await git(source, ["rev-parse", "HEAD"]);
  return { source, issueFile, remote, baseHead };
}

async function prepareIntegration(source, sandbox) {
  const out = join(sandbox, "integration");
  const script = join(PROJECT_ROOT, "scripts", "prepare-integration-checkout.sh");
  const result = await run(PROJECT_ROOT, script, ["--source", source, "--out", out, "--branch", "integration"]);
  if (result.code !== 0) throw new Error(`integration preparation failed: ${result.stderr.slice(-1000)}`);
  return { out, preparation: JSON.parse(result.stdout) };
}

async function fakeGithub(sandbox, { originUrl, pullRequests }) {
  const directory = join(sandbox, "fake-bin");
  await mkdir(directory, { recursive: true });
  const log = join(sandbox, "github-local-transport.jsonl");
  const stateFile = join(sandbox, "github-local-state.json");
  await writeFile(stateFile, json({ schema: "forgedock.local-github-readback/v1", repository: "example/product", originUrl, integrationBranch: "integration", pullRequests, publication: "disabled", comments: [] }), { mode: 0o600 });
  const script = join(directory, "gh");
  const helper = join(PROJECT_ROOT, "qualification", "local-github-readback.mjs");
  await writeFile(script, `#!/usr/bin/env bash\nexec node ${JSON.stringify(helper)} "$@"\n`, { mode: 0o700 });
  await chmod(script, 0o700);
  return { directory, log, stateFile, helper };
}

function ownerTask({ issueFile, integration, output, baseHead, issueNumber }) {
  return [
    "This is an authorized local/disposable ForgeDock qualification replay. You are the sole issue owner and writer; the parent must not solve the task or make product decisions.",
    `Issue input: ${issueFile}. Issue number: ${issueNumber}. Product workspace: ${integration}. Candidate helper: ${process.env.FORGEDOCK_CANDIDATE_BIN ?? join(PROJECT_ROOT, "bin", "forgedock-candidate.mjs")}.`,
    `Use the forgedock-work-on skill inline. Prepare intake twice with --issue ${issueNumber} --issue-file ${issueFile} --cwd "$PWD". The second call must reuse the immutable issue-N intake and preserve its timestamp; preserve the complete original body and acceptance obligations from that file.`,
    `Before editing, execute npm test in the product workspace and retain the failing-before result. Read and apply the linked prior decision in docs/decisions/display-boundary.md. Do not inspect or receive a completed solution from the harness.`,
    "Implement the smallest coherent behavior through the real producer/consumer path, add the necessary regression test, and run npm test after the change. Do not use gh or make any GitHub write.",
    `After the local commit, create review input using baseRef=integration, baseSha=${baseHead}, sourceRoot="$PWD", configRoot="$PWD", the complete acceptance from intake, and publish=false. Run the generated candidate review request through exactly one joined nested subagent workflow. Every fresh forgedock-reviewer must publish its own saved report through the publication-only tool. Read all reports, adjudicate them, and do not repair unless a genuine blocking finding is evidenced.`,
    `Save the exact local source diff as ${join(output, `owner-${issueNumber}.diff`)} and a compact owner evidence note as ${join(output, `owner-${issueNumber}.md`)}. Include commands/results, decision applicability, review report paths, first-pass outcome, and remote GitHub limitations.`,
    "There is no real PR, merge, or issue closure in this replay. A locally committed and independently reviewed behavior may use pr=none and dependency=SATISFIED in the final local marker; do not call that GitHub delivery.",
    "Finish with exactly: FORGE_WORK_ON_RESULT status=DONE issue=<N> pr=none dependency=SATISFIED",
  ].join("\n");
}

function dispatcherTask({ issueFile, integration, output }) {
  return [
    "This is an authorized local/disposable ForgeDock orchestration qualification replay. You are the dispatcher only; do not edit product files or provide solutions.",
    `Use the forgedock-orchestrate skill with selector '#101 #102', cwd ${integration}, and issue input ${issueFile}. Invoke the candidate helper with --issues-file ${issueFile} --delivery-mode local-replay so it retains both complete issue bodies and acceptance obligations while publication remains false.`,
    "Before publishing CONTEXT or mutating source, the dependent owner must verify #101's exact local integration delivery and record prepared/effective/observed base SHAs in CONTEXT; no owner changes or reviewer evidence may be pre-applied by the harness.",
    `The candidate helper is ${process.env.FORGEDOCK_CANDIDATE_BIN ?? join(PROJECT_ROOT, "bin", "forgedock-candidate.mjs")}; generated artifacts and compact results must remain under ${output}. Query the native subagent status boundary before admission and invoke the generated request exactly through the installed subagent tool.`,
    "This replay has a local file:// origin only. Do not use gh, create remote GitHub records, or solve either issue in the parent. The generated owner tasks are authorized to deliver reviewed commits to the disposable local integration ref so the dependent owner can fetch and consume predecessor behavior.",
    "Wait for the actual generated workflow result. Return each owner run identity, exact marker, predecessor/successor ordering, source-head evidence, review report evidence, test results, first-pass outcome, and the unexecuted GitHub publication/merge/closure limitation. Do not treat workflow syntax validation as execution success.",
  ].join("\n");
}

function collectRuns(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (typeof value.runId === "string") {
    output.push({
      runId: value.runId,
      agent: typeof value.agent === "string" ? value.agent : null,
      model: typeof value.model === "string" ? value.model : null,
      exitCode: Number.isSafeInteger(value.exitCode) ? value.exitCode : null,
      usage: value.usage ?? null,
      progressSummary: value.progressSummary ?? null,
    });
  }
  for (const child of Object.values(value)) collectRuns(child, output, seen);
  return output;
}

function parseEvents(text) {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function verifyLocalDeliveryAndFastForward(integration, remote, sandbox, baseHead) {
  const deliveredPath = join(sandbox, "preflight-delivered");
  const successorPath = join(sandbox, "preflight-successor");
  let remoteAdvanced = false;
  let deliveredHead = null;
  let successorHead = null;
  try {
    await git(integration, ["worktree", "add", "--quiet", "-b", "qualification-preflight-delivery", deliveredPath, baseHead]);
    await git(deliveredPath, ["-c", "user.email=qualification@example.com", "-c", "user.name=Qualification", "commit", "--allow-empty", "--quiet", "-m", "preflight local delivery probe"]);
    deliveredHead = await git(deliveredPath, ["rev-parse", "HEAD"]);
    await git(deliveredPath, ["push", "--quiet", "origin", "HEAD:refs/heads/integration"]);
    remoteAdvanced = true;
    if (await git(remote, ["rev-parse", "refs/heads/integration"]) !== deliveredHead) throw new Error("Disposable local delivery push did not read back the exact delivered commit");

    await git(integration, ["worktree", "add", "--quiet", "-b", "qualification-preflight-successor", successorPath, baseHead]);
    await git(successorPath, ["fetch", "origin", "integration", "--quiet"]);
    await git(successorPath, ["merge", "--ff-only", "origin/integration"]);
    successorHead = await git(successorPath, ["rev-parse", "HEAD"]);
    if (successorHead !== deliveredHead || await git(successorPath, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Disposable successor did not fast-forward cleanly to the exact predecessor delivery");
    return { pushReadback: deliveredHead, successorFastForward: successorHead, worktreeClean: true };
  } finally {
    if (remoteAdvanced) await git(remote, ["update-ref", "refs/heads/integration", baseHead]);
    try { await git(integration, ["worktree", "remove", "--force", successorPath]); } catch {}
    try { await git(integration, ["worktree", "remove", "--force", deliveredPath]); } catch {}
    try { await git(integration, ["branch", "-D", "qualification-preflight-successor"]); } catch {}
    try { await git(integration, ["branch", "-D", "qualification-preflight-delivery"]); } catch {}
    await git(integration, ["update-ref", "refs/remotes/origin/integration", baseHead]);
  }
}

async function verifyReplayOperations({ installRoot, manifest, model, thinking, mode, prepared, repository, issueFile, github, output, env }) {
  const candidateBin = join(installRoot, "package", "bin", "forgedock-candidate.mjs");
  const verifyInstall = await run(PROJECT_ROOT, process.execPath, [candidateBin, "verify-install", "--install-root", installRoot], env);
  if (verifyInstall.code !== 0) throw new Error(`Candidate install verification failed before model execution: ${verifyInstall.stderr.slice(-800)}`);
  const installedIdentity = JSON.parse(verifyInstall.stdout);
  if (installedIdentity.candidateCommit !== manifest.candidateCommit || installedIdentity.piSubagentsCommit !== manifest.piSubagentsCommit) throw new Error("Candidate/native package identity changed after installation");

  const configResult = await run(prepared.out, process.execPath, [candidateBin, "config", "--cwd", prepared.out], env);
  if (configResult.code !== 0) throw new Error(`Fixture configuration resolution failed before model execution: ${configResult.stderr.slice(-800)}`);
  const config = JSON.parse(configResult.stdout);
  if (config.ownerModel !== model || config.ownerThinking !== thinking || config.configuredOwnerConcurrency !== 2 || config.effectiveOwnerConcurrency !== 2) throw new Error("Fixture model/thinking or configured owner ceiling does not match the requested qualification");
  const baseline = await run(prepared.out, process.platform === "win32" ? "npm.cmd" : "npm", ["test"], env);
  const baselineText = `${baseline.stdout}\n${baseline.stderr}`;
  await writeFile(join(output, "preflight-baseline-test.log"), baselineText, { mode: 0o600 });
  const expectedBaselineFailure = mode === "orchestrate" && baseline.code !== 0 && baselineText.includes("display normalization is not implemented");
  if (mode === "orchestrate" && !expectedBaselineFailure) throw new Error("Fixture did not demonstrate its exact expected pre-fix producer failure before model execution");

  const issueInput = readJson(issueFile);
  const issueRows = Array.isArray(issueInput) ? issueInput : Array.isArray(issueInput.issues) ? issueInput.issues : [issueInput];
  const probeIssue = Number(issueRows[0]?.number);
  const read = await run(prepared.out, "gh", ["pr", "view", String(probeIssue), "-R", "example/product", "--json", "headRefOid,baseRefName,baseRefOid"], env);
  if (read.code !== 0) throw new Error(`Local fake-GitHub identity read failed before model execution: ${read.stderr.slice(-800)}`);
  const localIdentity = JSON.parse(read.stdout);
  if (localIdentity.headRefOid !== repository.baseHead || localIdentity.baseRefOid !== repository.baseHead || localIdentity.baseRefName !== "integration") throw new Error("Local fake-GitHub identity read disagrees with the disposable source/base");
  const write = await run(prepared.out, "gh", ["issue", "create", "-R", "example/product", "--title", "blocked preflight write", "--body", "must remain local and rejected"], env);
  if (write.code !== 77) throw new Error("Local transport did not reject a simulated GitHub write");

  let preparedWorkflow;
  let dispatch = null;
  if (mode === "orchestrate") {
    const dispatchOut = join(output, "preflight-dispatch");
    const dispatchResult = await run(prepared.out, process.execPath, [candidateBin, "prepare-dispatch", "--selector", "#101 #102", "--issues-file", issueFile, "--delivery-mode", "local-replay", "--cwd", prepared.out, "--out", dispatchOut], env);
    if (dispatchResult.code !== 0) throw new Error(`Candidate dispatch preparation failed before model execution: ${dispatchResult.stderr.slice(-800)}`);
    const preparedDispatch = JSON.parse(dispatchResult.stdout);
    const plan = readJson(preparedDispatch.planPath);
    const request = readJson(preparedDispatch.requestPath);
    const producer = plan.issues.find((issue) => issue.number === 101);
    const successor = plan.issues.find((issue) => issue.number === 102);
    if (plan.deliveryMode !== "local-replay" || !producer || !successor || !successor.predecessors.includes(producer.key) || plan.targetBase.headSha !== repository.baseHead || request.globalConcurrencyLimit !== 2) throw new Error("Candidate local dispatch lost the exact fixture identity, configured ceiling, or true dependency edge");
    dispatch = { result: "passed", deliveryMode: plan.deliveryMode, issueOrder: plan.issues.map((issue) => issue.number), dependency: { successor: 102, predecessor: 101 }, targetBase: plan.targetBase, ownerConcurrency: request.globalConcurrencyLimit };
    preparedWorkflow = preparedDispatch.requestPath;
  } else {
    const intakeOut = join(output, "preflight-intake.json");
    const intake = await run(prepared.out, process.execPath, [candidateBin, "prepare", "--issue", String(probeIssue), "--issue-file", issueFile, "--cwd", prepared.out, "--out", intakeOut], env);
    if (intake.code !== 0) throw new Error(`Candidate owner intake failed before model execution: ${intake.stderr.slice(-800)}`);
    preparedWorkflow = JSON.parse(intake.stdout).outputPath;
  }

  const delivery = await verifyLocalDeliveryAndFastForward(prepared.out, repository.remote, join(output, "transport-probe"), repository.baseHead);
  const restoredHead = await git(prepared.out, ["rev-parse", "HEAD"]);
  const restoredRemote = await git(repository.remote, ["rev-parse", "refs/heads/integration"]);
  if (restoredHead !== repository.baseHead || restoredRemote !== repository.baseHead || await git(prepared.out, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Local transport preflight did not restore the disposable fixture to its frozen clean base");

  const doctorResult = await run(prepared.out, process.execPath, [candidateBin, "doctor", "--config-dir", join(installRoot, "pi-agent"), "--cwd", prepared.out], env);
  if (doctorResult.code !== 0) throw new Error(`Candidate doctor failed before model execution: ${doctorResult.stderr.slice(-800)}`);
  const doctor = JSON.parse(doctorResult.stdout);
  if (doctor.pi?.version !== manifest.piVersion || doctor.piSubagents?.version !== "0.60.0" || doctor.providerAuth?.status !== "ready" || doctor.readiness !== "ready-with-live-write-limitation") throw new Error(`Candidate runtime/provider preflight is not ready: ${JSON.stringify({ pi: doctor.pi?.version, piSubagents: doctor.piSubagents?.version, providerAuth: doctor.providerAuth?.status, readiness: doctor.readiness, limitations: doctor.limitations })}`);
  const authPath = join(installRoot, "pi-agent", "auth.json");
  const operatorAuth = process.env.PI_AUTH_SOURCE ?? join(process.env.HOME ?? ".", ".pi", "agent", "auth.json");
  if (!existsSync(authPath) || realpathSync(authPath) !== realpathSync(operatorAuth)) throw new Error("Isolated candidate auth is not the existing operator auth symlink");

  return { schema: "forgedock.qualification-preflight/v1", result: "passed", noModelRequests: true, candidateCommit: manifest.candidateCommit, piVersion: manifest.piVersion, piSubagentsCommit: manifest.piSubagentsCommit, model, thinking, configuredOwnerConcurrency: config.configuredOwnerConcurrency, baselineTest: { exitCode: baseline.code, expectedFailure: expectedBaselineFailure, marker: expectedBaselineFailure ? "display normalization is not implemented" : null }, localGitHub: { identityRead: "passed", writeAttempt: "rejected-by-local-only-transport" }, dispatch, preparedWorkflow, localDelivery: delivery, doctor: { readiness: doctor.readiness, providerAuth: doctor.providerAuth, loadedCommands: doctor.loadedResources?.commands?.length ?? 0 }, auth: "isolated symlink to existing operator auth; file contents not read", restoredFixtureHead: restoredHead };
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  if (values.has("help")) {
    process.stdout.write("Usage: run-replay.mjs --install-root DIR --mode owner|orchestrate --out DIR --model provider/id --thinking off|minimal|low|medium|high|xhigh|max --pi-version VERSION --subagents-commit SHA [--preflight-only]\n");
    return;
  }
  const installRoot = required(values, "install-root");
  const mode = values.get("mode") ?? "owner";
  if (mode !== "owner" && mode !== "orchestrate") throw new Error("--mode must be owner or orchestrate");
  const output = required(values, "out");
  const model = requiredText(values, "model");
  const thinking = requiredText(values, "thinking");
  const requiredPiVersion = requiredText(values, "pi-version");
  const requiredSubagentsCommit = requiredText(values, "subagents-commit");
  if (!/^[^\s/:]+\/[^\s:]+$/.test(model)) throw new Error("--model must be a full provider/model ID without a thinking suffix");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error("--thinking is unsupported");
  if (!/^[A-Za-z0-9.+-]+$/.test(requiredPiVersion) || !/^[a-f0-9]{40,64}$/.test(requiredSubagentsCommit)) throw new Error("--pi-version or --subagents-commit is malformed");
  const manifest = readJson(join(installRoot, "manifest.json"));
  const actualPi = await run(PROJECT_ROOT, EXEC, ["--version"]);
  if (actualPi.code !== 0 || actualPi.stdout.trim() !== requiredPiVersion || manifest.piVersion !== requiredPiVersion) throw new Error(`Resolved Pi runtime ${actualPi.stdout.trim() || actualPi.stderr.trim()} does not match requested/installed ${requiredPiVersion}`);
  if (manifest.piSubagentsCommit !== requiredSubagentsCommit) throw new Error(`Installed native package ${manifest.piSubagentsCommit} does not match requested pin ${requiredSubagentsCommit}`);
  const sourceCommit = await git(PROJECT_ROOT, ["rev-parse", "HEAD"]);
  if (manifest.candidateCommit !== sourceCommit) throw new Error(`Candidate install ${manifest.candidateCommit} does not match source ${sourceCommit}`);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const sandbox = await mkdtemp(join(tmpdir(), `forgedock-${mode}-replay-`));
  const repository = await createRepository(mode, sandbox);
  const prepared = await prepareIntegration(repository.source, sandbox);
  const issueNumber = mode === "owner" ? 201 : undefined;
  const issueInput = readJson(repository.issueFile);
  const issueRows = Array.isArray(issueInput) ? issueInput : Array.isArray(issueInput.issues) ? issueInput.issues : [issueInput];
  const pullRequests = [...new Set(issueRows.map((issue) => Number(issue.number)).filter((number) => Number.isSafeInteger(number) && number > 0))];
  const github = await fakeGithub(sandbox, { originUrl: `file://${repository.remote}`, pullRequests });
  const env = {
    HOME: process.env.HOME ?? ".",
    PATH: `${github.directory}:${process.env.PATH ?? ""}`,
    TERM: process.env.TERM ?? "dumb",
    GIT_TERMINAL_PROMPT: "0",
    PI_CODING_AGENT_DIR: join(installRoot, "pi-agent"),
    PI_CODING_AGENT_SESSION_DIR: join(installRoot, "sessions"),
    FORGEDOCK_CANDIDATE_INSTALL_ROOT: installRoot,
    FORGEDOCK_CANDIDATE_BIN: join(installRoot, "package", "bin", "forgedock-candidate.mjs"),
    FORGEDOCK_REPLAY_EVIDENCE: output,
    FORGEDOCK_CANDIDATE_ARTIFACT_ROOT: join(output, "candidate-artifacts"),
    FORGEDOCK_SAFE_ARTIFACT_ROOT: join(output, "safe-artifacts"),
    FORGEDOCK_LOCAL_GH_STATE: github.stateFile,
    FORGEDOCK_LOCAL_GH_LOG: github.log,
    ...(mode === "orchestrate" ? { FORGEDOCK_LOCAL_ORCHESTRATION: "1", FORGEDOCK_CANDIDATE_DELIVERY_MODE: "local-replay", FORGEDOCK_CANDIDATE_DISPATCH_ISSUES_FILE: repository.issueFile } : {}),
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const preflight = await verifyReplayOperations({ installRoot, manifest, model, thinking, mode, prepared, repository, issueFile: repository.issueFile, github, output, env });
  await writeFile(join(output, "preflight.json"), json(preflight), { mode: 0o600 });
  if (values.has("preflight-only")) {
    process.stdout.write(json({ ...preflight, sandbox, integration: prepared.out, evidence: join(output, "preflight.json") }));
    return;
  }
  const prompt = mode === "owner"
    ? [
      "Run one fresh native ForgeDock owner child for this local qualification replay. Do not edit the product workspace in the parent.",
      `Launch agent forgedock-owner with context=fresh, async=false, worktree=true, cwd=${prepared.out}, model=${model}:${thinking}.`,
      ownerTask({ issueFile: repository.issueFile, integration: prepared.out, output, baseHead: repository.baseHead, issueNumber }),
    ].join("\n")
    : [
      "Run the installed ForgeDock orchestration route for this local qualification replay. Do not edit the product workspace in the parent.",
      dispatcherTask({ issueFile: repository.issueFile, integration: prepared.out, output }),
    ].join("\n");
  const launchInput = { schema: "forgedock.qualification-launch/v1", mode, installRoot, candidateCommit: manifest.candidateCommit, piVersion: manifest.piVersion, piSubagentsCommit: manifest.piSubagentsCommit, model, thinking, sandbox, source: repository.source, integration: prepared.out, issueFile: repository.issueFile, baseHead: repository.baseHead, prompt: "redacted from sanitized summary", githubWrites: "disabled; fake gh permits only source-bound local readback", localGithubState: github.stateFile, preflight: join(output, "preflight.json") };
  await writeFile(join(output, "launch-input.json"), json(launchInput), { mode: 0o600 });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const launch = await run(prepared.out, EXEC, ["--mode", "json", "--no-session", "--no-approve", "--model", model, "--thinking", thinking, "-p", prompt], env);
  const finishedAt = new Date().toISOString();
  const elapsedMs = Date.now() - startedMs;
  await writeFile(join(output, "parent.jsonl"), launch.stdout, { mode: 0o600 });
  await writeFile(join(output, "parent.stderr.log"), launch.stderr, { mode: 0o600 });
  const events = parseEvents(launch.stdout);
  const textual = events.flatMap((event) => {
    if (event.type === "message_end" && event.message?.role === "assistant") return (event.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
    if (event.type === "tool_execution_end") return (event.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
    return [];
  });
  const allText = textual.join("\n");
  const markers = allText.match(/^FORGE_WORK_ON_RESULT status=(?:DONE|GATED|FAILED) issue=\d+ pr=(?:\d+|none) dependency=(?:SATISFIED|UNSATISFIED)$/gm) ?? [];
  const reviewResults = allText.match(/^FORGE_REVIEW_RESULT role=[a-z][a-z0-9-]* report=\S+ publication=(?:published|saved|failed) verdict=(?:APPROVE|BLOCK|FOLLOW_UP)$/gm) ?? [];
  const nativeCalls = events.filter((event) => event.type === "tool_execution_start" && event.toolName === "subagent").map((event) => ({ agent: event.args?.agent ?? null, action: event.args?.action ?? null, workflowScriptPath: event.args?.workflowScriptPath ?? null, cwd: event.args?.cwd ?? null, model: event.args?.model ?? null, async: event.args?.async ?? null }));
  const runRecords = [...new Map(collectRuns(events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent").map((event) => event.result)).map((record) => [`${record.runId}:${record.agent ?? ""}`, record])).values()];
  const interventionTools = events.filter((event) => event.type === "tool_execution_start" && ["ask_user_question", "contact_supervisor", "subagent_supervisor"].includes(event.toolName)).map((event) => ({ tool: event.toolName, callId: event.toolCallId ?? null }));
  let deliveredHead = null;
  try { deliveredHead = await git(repository.remote, ["rev-parse", "refs/heads/integration"]); } catch { /* remote may remain at baseline */ }
  const sourceWorktrees = (await git(prepared.out, ["worktree", "list", "--porcelain"])).split(/\n\n+/).filter(Boolean).map((entry) => Object.fromEntries(entry.split("\n").map((line) => line.split(" ", 2)).filter(([key, value]) => key && value)));
  const summary = {
    schema: "forgedock.qualification-result/v1",
    mode,
    exitCode: launch.code,
    startedAt,
    finishedAt,
    elapsedMs,
    parentSessionId: events.find((event) => event.type === "session")?.id ?? null,
    installRoot,
    runtime: { piVersion: manifest.piVersion, nodeVersion: process.version, candidateCommit: manifest.candidateCommit, piSubagentsCommit: manifest.piSubagentsCommit, model, thinking },
    preflight,
    sandbox,
    integration: prepared.out,
    issueFile: repository.issueFile,
    baseHead: repository.baseHead,
    deliveredHead,
    nativeCalls,
    runs: runRecords,
    operatorInterventions: { count: interventionTools.length, tools: interventionTools },
    markers,
    reviewResults,
    firstPass: (mode === "owner" ? [201] : [101, 102]).every((issue) => markers.some((marker) => new RegExp(`^FORGE_WORK_ON_RESULT status=DONE issue=${issue} pr=(?:\\d+|none) dependency=SATISFIED$`).test(marker))) && !reviewResults.some((result) => /verdict=BLOCK/.test(result)) ? "accepted-local" : "not-accepted-local",
    github: { writes: "unexecuted", fakeGhLog: github.log, localState: github.stateFile, reason: "Local fake gh returns only exact Git-verified PR identity and empty comments; all writes and unsupported endpoints are rejected" },
    sourceWorktrees,
    retainedEvidence: { directory: output, rawParentEvents: join(output, "parent.jsonl"), stderr: join(output, "parent.stderr.log") },
  };
  await writeFile(join(output, "result.json"), json(summary), { mode: 0o600 });
  process.stdout.write(json({ ...summary, prompt: undefined }));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
