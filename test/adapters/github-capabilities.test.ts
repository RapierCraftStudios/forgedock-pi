import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubTransport } from "../../src/adapters/github-api.ts";
import type {
  GitHubInstallationTokenMetadata,
  GitHubTokenProvider,
} from "../../src/adapters/github-auth.ts";
import {
  GitHubCapabilityError,
  preflightGitHubCapabilities,
} from "../../src/adapters/github-capabilities.ts";

function transport(responses: Record<string, unknown>): GitHubTransport {
  return {
    request: async ({ path }) => ({
      status: responses[path] === undefined ? 404 : 200,
      data: responses[path],
      headers: {},
    }),
  } as GitHubTransport;
}

function installationProvider(
  metadata: GitHubInstallationTokenMetadata,
  source: "installation" | "bot-token" = "installation",
): GitHubTokenProvider {
  return {
    source,
    get: async () => "managed-token",
    refresh: async () => "managed-token",
    getInstallationMetadata: async () => metadata,
  };
}

const requiredPermissions = Object.freeze({
  contents: "write",
  issues: "write",
  pull_requests: "write",
});

test("capability preflight verifies installation metadata without collaborator booleans or /user", async () => {
  const calls: string[] = [];
  const base = transport({
    "/repos/acme/app": { permissions: { pull: false, push: false } },
    "/installation/repositories?per_page=100": {
      repositories: [{ full_name: "acme/app" }],
    },
  });
  const traced = {
    request: async (request: Parameters<GitHubTransport["request"]>[0]) => {
      calls.push(request.path);
      return base.request(request);
    },
  } as GitHubTransport;
  const result = await preflightGitHubCapabilities({
    repository: "acme/app",
    transport: traced,
    tokenProvider: installationProvider({
      repositorySelection: "selected",
      permissions: requiredPermissions,
    }),
  });

  assert.equal(result.repositoryWrite, true);
  assert.equal(result.tokenSource, "installation");
  assert.equal(calls.includes("/user"), false);
  assert.equal(calls.includes("/installation"), false);
});

test("capability preflight applies installation metadata to managed bot tokens", async () => {
  const result = await preflightGitHubCapabilities({
    repository: "acme/app",
    transport: transport({
      "/repos/acme/app": { permissions: { pull: false, push: false } },
    }),
    tokenProvider: installationProvider(
      {
        repositorySelection: "all",
        permissions: requiredPermissions,
      },
      "bot-token",
    ),
  });

  assert.equal(result.repositoryWrite, true);
  assert.equal(result.tokenSource, "bot-token");
});

test("capability preflight fails closed when installation permission metadata is unavailable", async () => {
  await assert.rejects(
    preflightGitHubCapabilities({
      repository: "acme/app",
      transport: transport({
        "/repos/acme/app": { permissions: { pull: false, push: false } },
      }),
      tokenSource: "installation",
    }),
    (error: unknown) =>
      error instanceof GitHubCapabilityError &&
      error.capability === "installation-metadata",
  );
});

test("capability preflight fails closed on missing repository write permission", async () => {
  await assert.rejects(
    preflightGitHubCapabilities({
      repository: "acme/app",
      transport: transport({
        "/repos/acme/app": { permissions: { pull: true, push: false } },
      }),
      tokenSource: "operator",
    }),
    (error: unknown) =>
      error instanceof GitHubCapabilityError &&
      error.message ===
        "ForgeDock GitHub capability failure: nonmutating repository write permission is unavailable.",
  );
});
