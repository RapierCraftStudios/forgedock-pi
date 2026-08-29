import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  assertForgeGitHubOperationAllowed,
  assertForgeRepositoryApiPath,
  registerForgeRuntimeTools,
} from "../src/runtime-tools.ts";

test("repository GitHub paths reject raw and encoded scope traversal", () => {
  for (const path of [
    "/repos/acme/app/../other/issues",
    "/repos/acme/app/%2e%2e/other/issues",
    "/repos/acme/app/issues%2F1",
  ]) {
    assert.throws(
      () => assertForgeRepositoryApiPath(path, "acme/app"),
      /dot or encoded path segments|normalization changed/,
    );
  }
});

test("GitHub mutations use a narrow workflow operation allowlist", () => {
  assert.doesNotThrow(() =>
    assertForgeGitHubOperationAllowed(
      "POST",
      "/repos/acme/app/issues/42/comments",
      "acme/app",
    ),
  );
  assert.doesNotThrow(() =>
    assertForgeGitHubOperationAllowed(
      "POST",
      "/repos/acme/app/git/refs",
      "acme/app",
      {
        ref: "refs/heads/staging-1",
        sha: "0123456789abcdef0123456789abcdef01234567",
      },
    ),
  );
  for (const body of [
    {
      ref: "refs/tags/staging-1",
      sha: "0123456789abcdef0123456789abcdef01234567",
    },
    {
      ref: "refs/heads/../main",
      sha: "0123456789abcdef0123456789abcdef01234567",
    },
    { ref: "refs/heads/staging-1", sha: "not-a-commit" },
  ]) {
    assert.throws(
      () =>
        assertForgeGitHubOperationAllowed(
          "POST",
          "/repos/acme/app/git/refs",
          "acme/app",
          body,
        ),
      /outside the ForgeDock operation allowlist/,
    );
  }
  assert.throws(
    () =>
      assertForgeGitHubOperationAllowed(
        "PATCH",
        "/repos/acme/app/git/refs/heads/main",
        "acme/app",
      ),
    /outside the ForgeDock operation allowlist/,
  );
});

test("GitHub runtime tool refuses calls before repository preflight", async () => {
  const tools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }> = [];
  const pi = {
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<unknown> }) => {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  registerForgeRuntimeTools(pi);
  const github = tools.find((tool) => tool.name === "forgedock_github");
  const laneBase = tools.find((tool) => tool.name === "forge_prepare_lane_base");
  const laneScope = tools.find((tool) => tool.name === "forge_verify_lane_scope");
  assert.ok(github);
  assert.ok(laneBase);
  assert.ok(laneScope);
  await assert.rejects(
    github.execute(
      "call-1",
      { method: "GET", path: "/repos/RapierCraftStudios/forgedock-pi/issues" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    ),
    /forgedock_preflight must succeed/,
  );
  await assert.rejects(
    laneBase.execute(
      "call-2",
      {
        targetRef: "staging",
        targetSha: "0123456789abcdef0123456789abcdef01234567",
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    ),
    /forgedock_preflight must succeed before lane-base initialization/,
  );
  await assert.rejects(
    laneScope.execute(
      "call-3",
      {
        targetRef: "staging",
        routeBaseRef: "staging",
        baseSha: "0123456789abcdef0123456789abcdef01234567",
        headSha: "89abcdef0123456789abcdef0123456789abcdef",
        claimedPaths: ["src/**"],
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    ),
    /forgedock_preflight must succeed before lane-scope verification/,
  );
});
