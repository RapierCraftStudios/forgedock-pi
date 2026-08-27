import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { OrchestrationState } from "../../src/core/orchestration.ts";
import {
  confirmOrchestrationDispatch,
  confirmWorkOnDispatch,
  ensureIntegrationBranchPreservation,
  issueResolverPrompt,
  registerForgeCommands,
  renderOrchestrationStatus,
} from "../../src/ui/commands.ts";

const input = {
  issueNumbers: [2, 16, 41],
  sourceExpression: "https://github.com/owner/repo/issues",
  resolutionSummary: "Three eligible open issues; active-owned lanes excluded.",
};

test("Forge init disables merged-head deletion and verifies read-back", async () => {
  let reads = 0;
  let patches = 0;
  const pi = {
    exec: async (_command: string, args: string[]) => {
      if (args.includes("PATCH")) {
        patches += 1;
        return { code: 0, stdout: "{}", stderr: "" };
      }
      reads += 1;
      return {
        code: 0,
        stdout: reads === 1 ? "true\n" : "false\n",
        stderr: "",
      };
    },
  } as unknown as ExtensionAPI;

  await ensureIntegrationBranchPreservation(pi, "/repo", "owner/repo");
  assert.equal(patches, 1);
  assert.equal(reads, 2);
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

test("orchestration status renders authoritative lane details", () => {
  const state: OrchestrationState = {
    schema: "forgedock.orchestration-state/v1",
    orchestrationId: "orchestration-1",
    repository: "owner/repo",
    integrationBranch: "staging",
    status: "running",
    maxConcurrent: 2,
    leaseEpoch: 1,
    sequence: 4,
    lastEventHash: "sha256:event",
    lanes: [
      {
        issueNumber: 2,
        ordinal: 0,
        status: "merged",
        forgeRunId: "forge-run-2",
        subagentRunId: "child-2",
        refreshes: 0,
        pullNumber: 6,
      },
      { issueNumber: 16, ordinal: 1, status: "queued", refreshes: 0 },
    ],
    dependencies: [
      {
        fromIssue: 2,
        toIssue: 16,
        kind: "explicit",
        reason: "#16 is blocked by #2",
      },
    ],
    graphHash: "sha256:graph",
    idempotencyKeys: {},
    createdAt: "2026-08-26T00:00:00.000Z",
  };
  const lines = renderOrchestrationStatus({
    link: {
      orchestrationId: state.orchestrationId,
      repository: state.repository,
      repositoryRoot: "/repo",
      stateBranch: "forgedock/state/v1",
      issueNumbers: [2, 16],
      integrationBranch: state.integrationBranch,
      maxConcurrent: state.maxConcurrent,
      status: "running",
    },
    state,
  });
  assert.match(lines[0] ?? "", /running\s+orchestration orchestration-1/);
  assert.ok(
    lines.some((line) => /sha256:graph · 1 dependency edge/.test(line)),
  );
  assert.ok(
    lines.some((line) =>
      /merged\s+#2 · run forge-run-2 · child child-2 · PR #6/.test(line),
    ),
  );
  assert.ok(lines.some((line) => /queued\s+#16 · after #2/.test(line)));
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
  assert.match(prompt, /sole authoritative interactive confirmation/);
  assert.doesNotMatch(prompt, /obtain conversational confirmation/);
  assert.match(prompt, /Original expression:/);
  assert.doesNotMatch(prompt, /call forge_orchestrate exactly once/);
});

test("orchestration resolver keeps an explicit set narrow and ordered", () => {
  const prompt = issueResolverPrompt("orchestrate", "#92 #94 #111 --auto");
  assert.match(prompt, /set and order are already fully specified/);
  assert.match(prompt, /Read only \.forge\/config\.json/);
  assert.match(
    prompt,
    /review-finding and needs-validation labels are eligible/,
  );
  assert.match(prompt, /Do not inspect comments, PRs, label definitions/);
  assert.match(
    prompt,
    /Do not search conversation\/session history, memory, git history/,
  );
  assert.match(prompt, /call forge_orchestrate exactly once/);
  assert.match(prompt, /sole authoritative interactive confirmation/);
  assert.doesNotMatch(prompt, /obtain conversational confirmation/);
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

test("standalone review commands and compatibility aliases are registered", () => {
  type CommandDefinition = {
    handler: (args: string, ctx: ExtensionContext) => unknown;
  };
  const commands = new Map<string, CommandDefinition>();
  const tools: string[] = [];
  const pi = {
    registerCommand: (name: string, definition: CommandDefinition) => {
      commands.set(name, definition);
    },
    registerTool: (definition: { name: string }) => {
      tools.push(definition.name);
    },
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  registerForgeCommands(
    pi,
    {} as never,
    {} as never,
    { list: () => [] } as never,
  );

  for (const name of [
    "forge:review-pr",
    "review-pr",
    "forge:review-pr-staging",
    "review-pr-staging",
  ])
    assert.ok(commands.has(name), `missing command ${name}`);
  assert.equal(tools.includes("forge_review_pr"), true);
  assert.equal(tools.includes("forge_review_pr_staging"), true);
});

test("resume command reconciles linked orchestration state", async () => {
  type CommandDefinition = {
    handler: (args: string, ctx: ExtensionContext) => unknown;
  };
  const commands = new Map<string, CommandDefinition>();
  const pi = {
    registerCommand: (name: string, definition: CommandDefinition) => {
      commands.set(name, definition);
    },
    registerTool: () => {},
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  let resumes = 0;
  registerForgeCommands(
    pi,
    {} as never,
    {
      resume: async () => {
        resumes += 1;
      },
    } as never,
  );
  const notifications: string[] = [];
  const handler = commands.get("forge:resume")?.handler;
  assert.ok(handler);
  await handler("", {
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext);
  assert.equal(resumes, 1);
  assert.match(notifications[0] ?? "", /reconciliation completed/);
});
