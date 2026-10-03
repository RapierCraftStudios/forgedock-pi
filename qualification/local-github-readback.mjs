#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const statePath = process.env.FORGEDOCK_LOCAL_GH_STATE;
const logPath = process.env.FORGEDOCK_LOCAL_GH_LOG;
const cwd = process.cwd();

function log(result, extra = {}) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ transport: "local-only", args, cwd, result, ...extra })}\n`, { mode: 0o600 });
}

function fail(message) {
  log("blocked", { reason: message });
  const error = new Error(`Local fake gh rejected request: ${message}`);
  error.exitCode = 77;
  throw error;
}

function git(argv) {
  return execFileSync("git", ["-C", cwd, ...argv], { encoding: "utf8", timeout: 10_000 }).trim();
}

async function main() {
  if (!statePath || !logPath) fail("missing bound local transport state or log path");
  let state;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); }
  catch { fail("local transport state is unreadable"); }
  if (state?.schema !== "forgedock.local-github-readback/v1" || state.publication !== "disabled" || !Array.isArray(state.pullRequests) || !Array.isArray(state.comments)) {
    fail("local transport state is not a publication-disabled fixture");
  }
  if (args.some((argument) => /^--method(?:=|$)/i.test(argument) || /^-x/i.test(argument))) {
    fail("explicit HTTP methods are disabled in local replay");
  }

  function localIdentity(repository, pullRequest) {
    let origin;
    let remoteRepository;
    try { origin = git(["remote", "get-url", "origin"]); }
    catch { fail("current checkout has no origin"); }
    let parsed;
    try { parsed = new URL(origin); }
    catch { fail("current checkout origin is not a parseable URL"); }
    if (parsed.protocol !== "file:") fail("local replay requires a file:// origin and never reads a live remote");
    const parts = parsed.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
    remoteRepository = parts.slice(-2).join("/");
    if (origin !== state.originUrl || remoteRepository?.toLowerCase() !== state.repository.toLowerCase()) fail("current checkout origin does not match the local transport binding");
    if (repository.toLowerCase() !== state.repository.toLowerCase() || !state.pullRequests.includes(pullRequest)) fail("repository or synthetic pull-request identity is outside the local fixture");
    let head;
    let baseSha;
    try {
      head = git(["rev-parse", "HEAD"]);
      baseSha = git(["rev-parse", `refs/remotes/origin/${state.integrationBranch}^{commit}`]);
    } catch { fail("local source head or configured integration ref is unavailable"); }
    if (!/^[a-f0-9]{40,64}$/.test(head) || !/^[a-f0-9]{40,64}$/.test(baseSha)) fail("local source identity is malformed");
    const ancestry = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", baseSha, head], { encoding: "utf8", timeout: 10_000 });
    if (ancestry.status !== 0) fail("frozen local source does not descend from its configured base");
    return {
      headRefOid: head,
      baseRefName: state.integrationBranch,
      baseRefOid: baseSha,
      // Local git ancestry is not a GitHub mergeability/status check.
      mergeable: null,
      mergeStateStatus: null,
      state: null,
      isDraft: null,
      url: null,
    };
  }

  if (args[0] === "pr" && args[1] === "view") {
    if (args.length !== 7) fail("PR read only supports the exact bound identity query shape");
    const pullRequest = Number(args[2]);
    const repositoryIndex = args.indexOf("-R");
    const repository = repositoryIndex >= 0 ? args[repositoryIndex + 1] : undefined;
    const jsonIndex = args.indexOf("--json");
    const fields = jsonIndex >= 0 ? String(args[jsonIndex + 1] ?? "").split(",").filter(Boolean) : [];
    if (!Number.isSafeInteger(pullRequest) || !repository || fields.length === 0) fail("PR read requires an exact fixture identity and field list");
    const values = localIdentity(repository, pullRequest);
    if (fields.some((field) => !Object.hasOwn(values, field))) fail("PR read requested an unsupported field");
    log("local-pr-read", { repository, pullRequest, head: values.headRefOid, baseRef: values.baseRefName, baseSha: values.baseRefOid });
    process.stdout.write(`${JSON.stringify(Object.fromEntries(fields.map((field) => [field, values[field]])))}\n`);
    return;
  }

  if (args[0] === "api") {
    if (args.length !== 4 || !args.slice(1, 3).includes("--paginate") || !args.slice(1, 3).includes("--slurp")) fail("only the exact local comment-list read shape is available in local replay");
    const endpoint = args[3] ?? "";
    const match = endpoint.match(/^repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([0-9]+)\/comments$/);
    if (!match) fail("only the bound issue-comment list read is available in local replay");
    const repository = match[1];
    const pullRequest = Number(match[2]);
    const identity = localIdentity(repository, pullRequest);
    if (state.comments.length !== 0) fail("local replay comment store is not empty; refusing to fabricate readback");
    log("local-empty-comments-read", { repository, pullRequest, head: identity.headRefOid, baseRef: identity.baseRefName, baseSha: identity.baseRefOid });
    // gh --paginate --slurp represents the one local empty page as [ [] ].
    process.stdout.write(`${JSON.stringify([state.comments])}\n`);
    return;
  }

  fail("writes and unsupported GitHub endpoints are disabled in local replay");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1;
});
