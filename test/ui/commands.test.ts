import assert from "node:assert/strict";
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
  prepareInitVerificationConfiguration,
  registerForgeCommands,
} from "../../src/ui/commands.ts";

const input = {
  issueNumbers: [2, 16, 41],
  sourceExpression: "https://github.com/owner/repo/issues",
  resolutionSummary: "Three eligible open issues; active-owned lanes excluded.",
};

test("init preserves tracked local checks and reports CI-only when none are configured", () => {
  const command = {
    argv: ["npm", "test"],
    cwd: "web",
    required: true,
    timeoutMs: 600_000,
  } as const;
  const local = prepareInitVerificationConfiguration({ test: command });
  assert.deepEqual(local.commands.test, command);
  assert.notEqual(local.commands.test, command);
  assert.notEqual(local.commands.test?.argv, command.argv);
  assert.match(local.summary, /Preserved tracked local checks: test/);

  const ciOnly = prepareInitVerificationConfiguration({});
  assert.deepEqual(ciOnly.commands, {});
  assert.match(ciOnly.summary, /CI-only verification/);
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
