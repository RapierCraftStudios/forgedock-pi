#!/usr/bin/env node
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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
    if (key === "help") values.set(key, "true");
    else values.set(key, argv[++index]);
  }
  return values;
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return resolve(value);
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

async function fakeGithub(sandbox) {
  const directory = join(sandbox, "fake-bin");
  await mkdir(directory, { recursive: true });
  const log = join(sandbox, "github-write-attempts.log");
  const script = join(directory, "gh");
  await writeFile(script, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");\nprocess.stderr.write("GitHub is intentionally unavailable in this local replay\\n");\nprocess.exit(77);\n`);
  await chmod(script, 0o755);
  return { directory, log };
}

function ownerTask({ issueFile, integration, output, baseHead, issueNumber }) {
  return [
    "This is an authorized local/disposable ForgeDock qualification replay. You are the sole issue owner and writer; the parent must not solve the task or make product decisions.",
    `Issue input: ${issueFile}. Issue number: ${issueNumber}. Product workspace: ${integration}. Candidate helper: ${process.env.FORGEDOCK_CANDIDATE_BIN ?? join(PROJECT_ROOT, "bin", "forgedock-candidate.mjs")}.`,
    `Use the forgedock-work-on skill inline. Prepare intake with --issue ${issueNumber} --issue-file ${issueFile} --cwd "$PWD". Preserve the complete original body and acceptance obligations from that file.`,
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
    `Use the forgedock-orchestrate skill with selector '#101 #102', cwd ${integration}, and issue input ${issueFile}. Invoke the candidate helper with --issues-file ${issueFile} so it retains both complete issue bodies and acceptance obligations.`,
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

async function main() {
  const values = parseArgs(process.argv.slice(2));
  if (values.has("help")) {
    process.stdout.write("Usage: run-replay.mjs --install-root DIR --mode owner|orchestrate --out DIR\n");
    return;
  }
  const installRoot = required(values, "install-root");
  const mode = values.get("mode") ?? "owner";
  if (mode !== "owner" && mode !== "orchestrate") throw new Error("--mode must be owner or orchestrate");
  const output = required(values, "out");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const sandbox = await mkdtemp(join(tmpdir(), `forgedock-${mode}-replay-`));
  const repository = await createRepository(mode, sandbox);
  const prepared = await prepareIntegration(repository.source, sandbox);
  const github = await fakeGithub(sandbox);
  const issueNumber = mode === "owner" ? 201 : undefined;
  const prompt = mode === "owner"
    ? [
      "Run one fresh native ForgeDock owner child for this local qualification replay. Do not edit the product workspace in the parent.",
      `Launch agent forgedock-owner with context=fresh, async=false, worktree=true, cwd=${prepared.out}, model=openai-codex/gpt-5.6-luna:low.`,
      ownerTask({ issueFile: repository.issueFile, integration: prepared.out, output, baseHead: repository.baseHead, issueNumber }),
    ].join("\n")
    : [
      "Run the installed ForgeDock orchestration route for this local qualification replay. Do not edit the product workspace in the parent.",
      dispatcherTask({ issueFile: repository.issueFile, integration: prepared.out, output }),
    ].join("\n");
  const launchInput = { schema: "forgedock.qualification-launch/v1", mode, installRoot, sandbox, source: repository.source, integration: prepared.out, issueFile: repository.issueFile, baseHead: repository.baseHead, prompt: "redacted from sanitized summary", model: "openai-codex/gpt-5.6-luna:low", githubWrites: "fake gh exits 77; no remote GitHub target" };
  await writeFile(join(output, "launch-input.json"), json(launchInput), { mode: 0o600 });
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
    ...(mode === "orchestrate" ? { FORGEDOCK_LOCAL_ORCHESTRATION: "1" } : {}),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const launch = await run(prepared.out, EXEC, ["--mode", "json", "--no-session", "--offline", "--no-approve", "--model", "openai-codex/gpt-5.6-luna:low", "-p", prompt], env);
  await writeFile(join(output, "parent.jsonl"), launch.stdout, { mode: 0o600 });
  await writeFile(join(output, "parent.stderr.log"), launch.stderr, { mode: 0o600 });
  const events = parseEvents(launch.stdout);
  const textual = events.flatMap((event) => {
    if (event.type === "message_end" && event.message?.role === "assistant") return (event.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
    if (event.type === "tool_execution_end") return (event.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
    return [];
  });
  const markers = textual.join("\n").match(/FORGE_(?:WORK_ON|REVIEW)_RESULT[^\n]*/g) ?? [];
  const nativeCalls = events.filter((event) => event.type === "tool_execution_start" && event.toolName === "subagent").map((event) => ({ agent: event.args?.agent ?? null, action: event.args?.action ?? null, workflowScriptPath: event.args?.workflowScriptPath ?? null, cwd: event.args?.cwd ?? null, model: event.args?.model ?? null, async: event.args?.async ?? null }));
  const runRecords = collectRuns(events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent").map((event) => event.result));
  let deliveredHead = null;
  try { deliveredHead = await git(repository.remote, ["rev-parse", "refs/heads/integration"]); } catch { /* remote may remain at baseline */ }
  const sourceWorktrees = (await git(prepared.out, ["worktree", "list", "--porcelain"])).split(/\n\n+/).filter(Boolean).map((entry) => Object.fromEntries(entry.split("\n").map((line) => line.split(" ", 2)).filter(([key, value]) => key && value)));
  const summary = {
    schema: "forgedock.qualification-result/v1",
    mode,
    exitCode: launch.code,
    parentSessionId: events.find((event) => event.type === "session")?.id ?? null,
    installRoot,
    candidateCommit: readJson(join(installRoot, "manifest.json")).candidateCommit,
    piVersion: readJson(join(installRoot, "manifest.json")).piVersion,
    piSubagentsCommit: readJson(join(installRoot, "manifest.json")).piSubagentsCommit,
    model: "openai-codex/gpt-5.6-luna:low",
    sandbox,
    integration: prepared.out,
    issueFile: repository.issueFile,
    baseHead: repository.baseHead,
    deliveredHead,
    nativeCalls,
    runs: runRecords,
    markers,
    firstPass: markers.some((marker) => /FORGE_WORK_ON_RESULT status=DONE/.test(marker)) && !markers.some((marker) => /CHANGES_REQUESTED|IMMEDIATE REPAIR/.test(marker)) ? "accepted-local" : "not-accepted-local",
    github: { writes: "unexecuted", fakeGhLog: github.log, reason: "No disposable remote GitHub write authority was provided" },
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
