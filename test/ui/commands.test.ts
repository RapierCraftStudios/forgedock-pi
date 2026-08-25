import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { registerForgeCommands } from "../../src/ui/commands.ts";
import {
  OrchestrationCancellationCleanupError,
  type ForgeOrchestrationController,
} from "../../src/workflows/orchestrate.ts";
import type { ForgeWorkOnController } from "../../src/workflows/work-on.ts";

interface Notice {
  message: string;
  level: string;
}

function cancellationHarness(cancel: () => Promise<unknown>) {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const notices: Notice[] = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
      commands.set(name, command);
    },
    getAllTools: () => [],
    sendUserMessage: () => undefined,
  } as unknown as ExtensionAPI;
  const orchestrator = { cancel } as unknown as ForgeOrchestrationController;
  registerForgeCommands(
    pi,
    {} as ForgeWorkOnController,
    orchestrator,
  );
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: {
      select: async () => "Cancel and release lease",
      notify: (message: string, level: string) => notices.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;
  const handler = commands.get("forge:cancel")?.handler;
  if (!handler) throw new Error("forge:cancel was not registered");
  return { handler, ctx, notices };
}

test("forge:cancel reports confirmed durable cancellation and idempotent repeat safety", async () => {
  const harness = cancellationHarness(async () => ({ status: "cancelled" }));
  await harness.handler("orchestration-1", harness.ctx);
  assert.deepEqual(harness.notices, [
    {
      message:
        "ForgeDock orchestration orchestration-1 is cancelled; durable audit history was preserved and its lease is released. Repeating this command is safe.",
      level: "info",
    },
  ]);
});

test("forge:cancel surfaces durable failure without a false success notice", async () => {
  const failure = new Error("state branch rejected the write");
  const harness = cancellationHarness(async () => {
    throw failure;
  });
  await assert.rejects(harness.handler("orchestration-1", harness.ctx), failure);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0]?.level, "error");
  assert.match(harness.notices[0]?.message ?? "", /may still own the repository lease/);
});

test("forge:cancel warns when durable cancellation succeeds but provider cleanup fails", async () => {
  const warning = new OrchestrationCancellationCleanupError(
    { status: "cancelled" } as never,
    "Orchestration orchestration-1 is durably cancelled and its lease is released, but child-1 could not be stopped.",
  );
  const harness = cancellationHarness(async () => {
    throw warning;
  });
  await harness.handler("orchestration-1", harness.ctx);
  assert.deepEqual(harness.notices, [
    { message: warning.message, level: "warning" },
  ]);
});
