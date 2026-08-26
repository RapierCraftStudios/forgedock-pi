import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  configureForgePolicy,
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

test("forge:init preserves configured monorepo verification commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-init-test-"));
  const configPath = join(root, ".forge", "config.json");
  const commands = {
    "web-test": {
      argv: ["npm", "test"],
      cwd: "web",
      required: true,
      timeoutMs: 600_000,
    },
  };
  try {
    await mkdir(join(root, ".forge"), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          schema: "forgedock.config/v1",
          repository: { provider: "github", name: "owner/repo" },
          state: { branch: "forgedock/state/v1" },
          branches: {
            integration: ["staging"],
            protected: ["main"],
            autoMergeIntegration: true,
          },
          verification: {
            github: {
              required: true,
              requiredBranches: ["main"],
              waitTimeoutMs: 1_800_000,
              pollIntervalMs: 10_000,
            },
            commands,
          },
          review: { required: ["correctness", "security"], maxRounds: 3 },
          orchestration: { maxConcurrent: 2, maxIssues: 20 },
          subagents: {
            maxConcurrent: 2,
            maxDepth: 2,
            workOnTimeoutMs: 14_400_000,
            reviewerTimeoutMs: 900_000,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const selections = {
      select: async (title: string, options: string[]) => {
        if (title.startsWith("Which integration"))
          return "Keep staging (current)";
        if (title.startsWith("Which PR target"))
          return "Integration and default (staging, main)";
        return options[0] ?? "";
      },
    };
    const exec = async (_command: string, args: readonly string[]) => {
      if (args[0] === "repo")
        return { code: 0, stdout: "main\n", stderr: "" };
      return { code: 0, stdout: "main\nstaging\n", stderr: "" };
    };
    const result = await configureForgePolicy({
      pi: { exec } as never,
      ctx: { hasUI: true, ui: selections } as never,
      root,
      repository: "owner/repo",
      configPath,
    });
    const serialized = JSON.parse(await readFile(configPath, "utf8")) as {
      verification: { commands: unknown };
    };
    assert.deepEqual(serialized.verification.commands, commands);
    assert.deepEqual(result.verification.commands, commands);
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
