import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  confirmExpiredLeaseTakeover,
  confirmOrchestrationDispatch,
  confirmWorkOnDispatch,
  issueResolverPrompt,
  registerForgeCommands,
  validateForgeInitVerification,
} from "../../src/ui/commands.ts";

const input = {
  issueNumbers: [2, 16, 41],
  sourceExpression: "https://github.com/owner/repo/issues",
  resolutionSummary: "Three eligible open issues; active-owned lanes excluded.",
};

test("/forge:init preserves package-local checks and makes CI-only verification explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-init-verification-"));
  const bin = join(root, "bin");
  try {
    await mkdir(join(root, "web"), { recursive: true });
    await mkdir(bin);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    await writeFile(
      join(root, "web", "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    await writeFile(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "npm"), 0o755);

    const packageCommand = {
      argv: ["npm", "test"],
      cwd: "web",
      required: true,
      timeoutMs: 60_000,
    };
    const retained = await validateForgeInitVerification(
      root,
      "/repo/.forge/config.json",
      { webTest: packageCommand },
      { path: bin },
    );
    assert.equal(retained.webTest?.cwd, "web");

    await assert.rejects(
      validateForgeInitVerification(
        root,
        "/repo/.forge/config.json",
        { test: { ...packageCommand, cwd: "." } },
        { path: bin },
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(
          "/repo/.forge/config.json verification.commands.test.argv",
        ) &&
        error.message.includes("set cwd to the package that defines it") &&
        error.message.includes("CI-only verification"),
    );

    assert.deepEqual(
      await validateForgeInitVerification(
        root,
        "/repo/.forge/config.json",
        {},
        { path: "" },
      ),
      {},
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model-callable orchestration fails closed without interactive confirmation", async () => {
  const ui = {
    confirm: async () => true,
  } as unknown as ExtensionContext["ui"];
  await assert.rejects(
    confirmOrchestrationDispatch({ hasUI: false, ui }, input),
    /requires interactive operator confirmation/,
  );

  const deniedUi = {
    confirm: async () => false,
  } as unknown as ExtensionContext["ui"];
  await assert.rejects(
    confirmOrchestrationDispatch({ hasUI: true, ui: deniedUi }, input),
    /not confirmed by the operator/,
  );
});

test("expired lease takeover requires a separate operator authorization", async () => {
  const noUi = {
    confirm: async () => true,
  } as unknown as ExtensionContext["ui"];
  assert.equal(
    await confirmExpiredLeaseTakeover(
      { hasUI: false, ui: noUi },
      "expired-run",
    ),
    false,
  );

  let message = "";
  const deniedUi = {
    confirm: async (_title: string, body: string) => {
      message = body;
      return false;
    },
  } as unknown as ExtensionContext["ui"];
  assert.equal(
    await confirmExpiredLeaseTakeover(
      { hasUI: true, ui: deniedUi },
      "expired-run",
    ),
    false,
  );
  assert.match(message, /expired-run/);
  assert.match(message, /cancellation and takeover/);
});

test("orchestration confirmation names only the trusted exact issue set", async () => {
  let prompt = "";
  const ui = {
    confirm: async (_title: string, message: string) => {
      prompt = message;
      return true;
    },
  } as unknown as ExtensionContext["ui"];

  await confirmOrchestrationDispatch({ hasUI: true, ui }, input);
  assert.match(prompt, /Issues: #2, #16, #41/);
  assert.match(prompt, /may merge changes/);
  assert.doesNotMatch(prompt, /github\.com/);
  assert.doesNotMatch(prompt, /eligible open issues/);
});

test("work-on confirmation fails closed and names only the exact issue", async () => {
  const workOnInput = {
    issueNumber: 92,
    sourceExpression: "the workflow label bug",
    resolutionSummary: "Resolved from untrusted GitHub search results.",
  };
  const noUi = {
    confirm: async () => true,
  } as unknown as ExtensionContext["ui"];
  await assert.rejects(
    confirmWorkOnDispatch({ hasUI: false, ui: noUi }, workOnInput),
    /requires interactive operator confirmation/,
  );

  let prompt = "";
  const ui = {
    confirm: async (_title: string, message: string) => {
      prompt = message;
      return true;
    },
  } as unknown as ExtensionContext["ui"];
  await confirmWorkOnDispatch({ hasUI: true, ui }, workOnInput);
  assert.match(prompt, /Issue: #92/);
  assert.match(prompt, /may merge changes/);
  assert.doesNotMatch(prompt, /workflow label bug/);
  assert.doesNotMatch(prompt, /untrusted GitHub/);

  const deniedUi = {
    confirm: async () => false,
  } as unknown as ExtensionContext["ui"];
  await assert.rejects(
    confirmWorkOnDispatch({ hasUI: true, ui: deniedUi }, workOnInput),
    /not confirmed by the operator/,
  );
});

test("work-on resolver accepts free-form intent but requires exactly one issue", () => {
  const prompt = issueResolverPrompt(
    "work-on",
    "https://github.com/owner/repo/issues?q=label%3Abug",
  );
  assert.match(prompt, /single-issue intent resolver/);
  assert.match(prompt, /Resolve exactly one eligible issue/);
  assert.match(prompt, /ask the user to disambiguate/);
  assert.match(prompt, /forge_work_on exactly once/);
  assert.match(prompt, /interactive exact-issue confirmation/);
  assert.match(prompt, /Original expression:/);
  assert.doesNotMatch(prompt, /call forge_orchestrate exactly once/);
});

test("work-on slash command sends free-form intent to the resolver", async () => {
  type CommandDefinition = {
    handler: (args: string, ctx: ExtensionContext) => unknown;
  };
  const commands = new Map<string, CommandDefinition>();
  const tools: string[] = [];
  const messages: string[] = [];
  const pi = {
    registerCommand: (name: string, definition: CommandDefinition) => {
      commands.set(name, definition);
    },
    registerTool: (definition: { name: string }) => {
      tools.push(definition.name);
    },
    sendUserMessage: (message: string) => {
      messages.push(message);
    },
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  registerForgeCommands(pi, {} as never, {} as never);

  const handler = commands.get("forge:work-on")?.handler;
  assert.ok(handler);
  await handler(
    "the oldest eligible workflow bug --auto",
    {} as ExtensionContext,
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /oldest eligible workflow bug/);
  assert.match(messages[0] ?? "", /forge_work_on exactly once/);
  assert.equal(tools.includes("forge_work_on"), true);
  assert.equal(tools.includes("forge_orchestrate"), true);
});
