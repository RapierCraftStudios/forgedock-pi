import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerForgeWorktreeContainment } from "../src/worktree-containment.ts";

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

async function fixture(linked: boolean) {
  const base = await mkdtemp(join(tmpdir(), "forgedock-containment-"));
  const anchor = join(base, "anchor");
  const worktree = linked ? join(base, "worktree") : anchor;
  await mkdir(join(anchor, ".git"), { recursive: true });
  if (linked) await mkdir(worktree, { recursive: true });

  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    exec: async (_program: string, args: string[]) => ({
      code: 0,
      stdout: args.includes("--show-toplevel")
        ? `${worktree}\n`
        : `${join(anchor, ".git")}\n`,
      stderr: "",
    }),
  } as unknown as ExtensionAPI;
  registerForgeWorktreeContainment(pi);
  await handlers.get("session_start")?.({}, { cwd: worktree });

  return {
    anchor,
    worktree,
    toolCall: (toolName: string, input: unknown) =>
      handlers.get("tool_call")?.({ toolName, input }, { cwd: worktree }),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

test("linked Forge worktrees block anchor checkout access", async () => {
  const value = await fixture(true);
  try {
    assert.deepEqual(
      await value.toolCall("edit", { path: join(value.anchor, "src", "file.ts") }),
      {
        block: true,
        reason:
          "edit cannot access the anchor checkout from an isolated Forge worktree. Use the assigned worktree cwd as the repository root.",
      },
    );
    assert.deepEqual(
      await value.toolCall("bash", {
        command: `git -C ${value.anchor} status --short`,
      }),
      {
        block: true,
        reason:
          "bash cannot access the anchor checkout from an isolated Forge worktree. Use the assigned worktree cwd as the repository root.",
      },
    );
    assert.deepEqual(
      await value.toolCall("forgedock_preflight", {
        repositoryRoot: value.anchor,
      }),
      {
        block: true,
        reason:
          "forgedock_preflight cannot access the anchor checkout from an isolated Forge worktree. Use the assigned worktree cwd as the repository root.",
      },
    );
    assert.equal(
      await value.toolCall("write", {
        path: join(value.worktree, "src", "file.ts"),
      }),
      undefined,
    );
    assert.equal(
      await value.toolCall("forgedock_github", {
        path: "/repos/acme/app/issues/1",
      }),
      undefined,
    );
  } finally {
    await value.cleanup();
  }
});

test("primary checkout sessions do not install an anchor denial", async () => {
  const value = await fixture(false);
  try {
    assert.equal(
      await value.toolCall("edit", { path: join(value.anchor, "src", "file.ts") }),
      undefined,
    );
  } finally {
    await value.cleanup();
  }
});
