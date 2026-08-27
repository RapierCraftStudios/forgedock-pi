import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  chooseLocalVerificationCommands,
  confirmWorkOnDispatch,
  issueResolverPrompt,
  registerForgeCommands,
} from "../../src/ui/commands.ts";

const input = {
  issueNumbers: [2, 16, 41],
  sourceExpression: "https://github.com/owner/repo/issues",
  resolutionSummary: "Three eligible open issues; active-owned lanes excluded.",
};

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

test("init local verification selection is manifest-backed and package-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-init-verification-"));
  try {
    await mkdir(join(root, "web"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    await writeFile(
      join(root, "web", "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    let offered: string[] = [];
    const ui = {
      select: async (_title: string, choices: string[]) => {
        offered = choices;
        return choices.find((choice) => choice === "Use npm test in web") ?? "";
      },
    } as never;
    const selected = await chooseLocalVerificationCommands(
      { ui },
      root,
      {},
    );
    assert.ok(offered.includes("GitHub CI only (no local verification commands)"));
    assert.equal(offered.includes("Use npm test in ."), false);
    assert.deepEqual(selected, {
      "web-test": {
        argv: ["npm", "test"],
        cwd: "web",
        required: true,
        timeoutMs: 600_000,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init local verification selection makes CI-only and preservation explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-init-verification-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    const current = {
      test: {
        argv: ["npm", "test"],
        cwd: ".",
        required: true,
        timeoutMs: 60_000,
      },
    };
    const keepUi = {
      select: async (_title: string, choices: string[]) => choices[0] ?? "",
    } as never;
    assert.deepEqual(
      await chooseLocalVerificationCommands({ ui: keepUi }, root, current),
      current,
    );
    const ciUi = {
      select: async (_title: string, choices: string[]) =>
        choices.find((choice) => choice.startsWith("GitHub CI only")) ?? "",
    } as never;
    assert.deepEqual(
      await chooseLocalVerificationCommands({ ui: ciUi }, root, current),
      {},
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
