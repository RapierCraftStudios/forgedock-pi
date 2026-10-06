import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const localGh = resolve("qualification/local-github-readback.mjs");

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

test("local adjudication readback derives its PR identity from the disposable git source and denies writes", async () => {
  const root = await mkdtemp("/tmp/forgedock-local-github-readback-");
  const source = join(root, "source");
  const remote = join(root, "example", "product.git");
  const statePath = join(root, "local-state.json");
  const logPath = join(root, "transport.jsonl");
  try {
    await mkdir(dirname(remote), { recursive: true });
    await execFileAsync("git", ["init", "--bare", "--quiet", remote]);
    await mkdir(source, { recursive: true });
    await execFileAsync("git", ["init", "--quiet"], { cwd: source });
    await execFileAsync("git", ["config", "user.name", "Local fixture"], { cwd: source });
    await execFileAsync("git", ["config", "user.email", "local-fixture@example.invalid"], { cwd: source });
    await execFileAsync("git", ["remote", "add", "origin", `file://${remote}`], { cwd: source });
    await writeFile(join(source, "README.md"), "local base\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: source });
    await execFileAsync("git", ["commit", "--quiet", "-m", "local base"], { cwd: source });
    await execFileAsync("git", ["branch", "-M", "integration"], { cwd: source });
    await execFileAsync("git", ["push", "--quiet", "-u", "origin", "integration"], { cwd: source });
    const baseSha = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["update-ref", "refs/remotes/origin/integration", baseSha]);
    await execFileAsync("git", ["checkout", "-b", "pi-parallel-local-review"], { cwd: source });
    await writeFile(join(source, "README.md"), "local reviewed head\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: source });
    await execFileAsync("git", ["commit", "--quiet", "-m", "local reviewed head"], { cwd: source });
    const head = await git(source, ["rev-parse", "HEAD"]);
    const originUrl = await git(source, ["remote", "get-url", "origin"]);
    await writeFile(statePath, `${JSON.stringify({
      schema: "forgedock.local-github-readback/v1",
      repository: "example/product",
      originUrl,
      integrationBranch: "integration",
      pullRequests: [7],
      publication: "disabled",
      comments: [],
    }, null, 2)}\n`);
    const env = { ...process.env, FORGEDOCK_LOCAL_GH_STATE: statePath, FORGEDOCK_LOCAL_GH_LOG: logPath };

    const prView = JSON.parse((await execFileAsync("node", [localGh, "pr", "view", "7", "-R", "example/product", "--json", "headRefOid,baseRefName,baseRefOid,mergeable,mergeStateStatus,state,isDraft,url"], { cwd: source, env })).stdout) as Record<string, unknown>;
    assert.equal(prView.headRefOid, head);
    assert.equal(prView.baseRefName, "integration");
    assert.equal(prView.baseRefOid, baseSha);
    assert.equal(prView.mergeable, null, "local ancestry must not masquerade as live GitHub mergeability");
    assert.equal(prView.mergeStateStatus, null, "local transport does not invent a GitHub merge-state result");
    assert.equal(prView.state, null, "no remote pull-request state exists in this fixture");
    assert.equal(prView.isDraft, null);
    assert.equal(prView.url, null, "the fixture must not invent a GitHub URL");

    const comments = JSON.parse((await execFileAsync("node", [localGh, "api", "--paginate", "--slurp", "repos/example/product/issues/7/comments"], { cwd: source, env })).stdout) as unknown;
    assert.deepEqual(comments, [[]]);

    await assert.rejects(
      execFileAsync("node", [localGh, "api", "repos/example/product/issues/7/comments", "--method", "POST", "-F", "body=must-not-publish"], { cwd: source, env }),
      (error: NodeJS.ErrnoException) => Number(error.code) === 77,
    );
    await assert.rejects(
      execFileAsync("node", [localGh, "api", "--paginate", "--slurp", "--method=POST", "-F", "body=must-not-publish", "repos/example/product/issues/7/comments"], { cwd: source, env }),
      (error: NodeJS.ErrnoException) => Number(error.code) === 77,
      "write-style options must not be accepted as an empty-read request",
    );

    const remoteOrigin = "https://github.com/example/product.git";
    await git(source, ["remote", "set-url", "origin", remoteOrigin]);
    await writeFile(statePath, `${JSON.stringify({
      schema: "forgedock.local-github-readback/v1",
      repository: "example/product",
      originUrl: remoteOrigin,
      integrationBranch: "integration",
      pullRequests: [7],
      publication: "disabled",
      comments: [],
    }, null, 2)}\n`);
    await assert.rejects(
      execFileAsync("node", [localGh, "pr", "view", "7", "-R", "example/product", "--json", "headRefOid"], { cwd: source, env }),
      (error: NodeJS.ErrnoException) => Number(error.code) === 77,
      "even matching non-local state must not permit a remote origin",
    );
    const logText = await readFile(logPath, "utf8");
    const entries = JSON.parse(`[${logText.trim().split("\n").map((line) => line.trim()).join(",")}]`) as Array<{ result: string }>;
    assert.deepEqual(entries.map((entry) => entry.result), ["local-pr-read", "local-empty-comments-read", "blocked", "blocked", "blocked"]);
    assert.equal(await git(source, ["rev-parse", "HEAD"]), head, "the readback transport must not alter the source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
