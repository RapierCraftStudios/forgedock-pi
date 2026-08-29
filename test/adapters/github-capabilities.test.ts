import assert from "node:assert/strict";
import test from "node:test";
import { preflightGitHubCapabilities, GitHubCapabilityError } from "../../src/adapters/github-capabilities.ts";
import type { GitHubTransport } from "../../src/adapters/github-api.ts";

function transport(responses: Record<string, unknown>): GitHubTransport {
  return { request: async ({ path }) => ({ status: responses[path] === undefined ? 404 : 200, data: responses[path], headers: {} }) } as GitHubTransport;
}

test("capability preflight verifies installation permissions without /user", async () => {
  const calls: string[] = [];
  const base = transport({
    "/repos/acme/app": { permissions: { pull: true, push: true } },
    "/installation": { id: 4, repository_selection: "selected", repositories: [{ full_name: "acme/app" }], permissions: { contents: "write", issues: "write", pull_requests: "write" } },
  });
  const traced = { request: async (request: Parameters<GitHubTransport["request"]>[0]) => { calls.push(request.path); return base.request(request); } } as GitHubTransport;
  const result = await preflightGitHubCapabilities({ repository: "acme/app", transport: traced, tokenSource: "installation" });
  assert.equal(result.repositoryWrite, true);
  assert.equal(calls.includes("/user"), false);
});

test("capability preflight fails closed on missing repository write permission", async () => {
  await assert.rejects(
    preflightGitHubCapabilities({ repository: "acme/app", transport: transport({ "/repos/acme/app": { permissions: { pull: true, push: false } } }), tokenSource: "operator" }),
    (error: unknown) => error instanceof GitHubCapabilityError && error.message === "ForgeDock GitHub capability failure: nonmutating repository write permission is unavailable.",
  );
});
