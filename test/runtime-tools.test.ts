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
  assert.ok(github);
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
});
