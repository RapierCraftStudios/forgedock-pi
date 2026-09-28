import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import forgedockCandidateExtension, { FORGEDOCK_ALIASES, isStagingMutationBlocked, rewriteForgePromptAlias } from "../../candidate/extension.ts";

test("automatic promotion handoff activates and settles the staging guard", async () => {
  const reviewRoot = await mkdtemp(join(tmpdir(), "forgedock-route-guard-"));
  try {
    const workflowPath = join(reviewRoot, "workflow.js");
    const workflow = "const assignments = [];\n";
    await writeFile(workflowPath, workflow);
    const review = { schema: "forgedock.candidate-review/v1", artifactRoot: reviewRoot, artifactKey: "test-review", repository: "example/product", pullRequest: 7, head: "a".repeat(40), baseRef: "main", baseSha: "b".repeat(40), sourceRoot: reviewRoot, mode: "staging", roles: ["correctness"], workflowPath, workflowSha256: createHash("sha256").update(workflow).digest("hex"), config: { protectedBranch: "main" } };
    await writeFile(join(reviewRoot, "review.json"), JSON.stringify(review));
    const handlers = new Map<string, Array<(event: any) => any>>();
    const fakePi = {
      registerTool() {},
      registerCommand() {},
      getAllTools() { return []; },
      on(name: string, handler: (event: any) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    };
    forgedockCandidateExtension(fakePi as never);
    const input = handlers.get("input")?.[0];
    const result = handlers.get("tool_result")?.[0];
    const settled = handlers.get("agent_settled")?.[0];
    const toolCall = handlers.get("tool_call")?.[0];
    assert.ok(input);
    assert.ok(result);
    assert.ok(settled);
    assert.ok(toolCall);
    assert.equal(input({ source: "user", text: "/review-pr 33792" })?.action, "transform");
    assert.equal(toolCall({ toolName: "bash", input: {} }), undefined);
    result({ toolName: "forge_prepare_review", isError: false, details: { reviewRoot, artifactKey: "test-review", policySummary: { baseRef: "main" } } });
    assert.equal(toolCall({ toolName: "bash", input: {} })?.block, true);
    assert.equal(toolCall({ toolName: "subagent_supervisor", input: { action: "reply", replyTo: "request-1", message: "Continue after this authorization." } }), undefined);
    assert.equal(toolCall({ toolName: "subagent_supervisor", input: { action: "ask", message: "Start another operation" } })?.block, true);
    settled({});
    assert.equal(toolCall({ toolName: "bash", input: {} }), undefined);
    result({ toolName: "forge_prepare_review", isError: false, details: { reviewRoot, artifactKey: "test-review", policySummary: { baseRef: "staging" } } });
    assert.equal(toolCall({ toolName: "bash", input: {} }), undefined);
  } finally {
    await rm(reviewRoot, { recursive: true, force: true });
  }
});

test("staging guard resets after the route settles", () => {
  const handlers = new Map<string, Array<(event: any) => any>>();
  const fakePi = {
    registerTool() {},
    registerCommand() {},
    getAllTools() { return []; },
    on(name: string, handler: (event: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  forgedockCandidateExtension(fakePi as never);
  const input = handlers.get("input")?.[0];
  const settled = handlers.get("agent_settled")?.[0];
  const toolCall = handlers.get("tool_call")?.[0];
  assert.ok(input);
  assert.ok(settled);
  assert.ok(toolCall);
  assert.equal(input({ source: "user", text: "/review-pr-staging 576" })?.action, "transform");
  assert.equal(toolCall({ toolName: "bash", input: {} })?.block, true);
  settled({});
  assert.equal(toolCall({ toolName: "bash", input: {} }), undefined);
  assert.equal(input({ source: "user", text: "/work-on 1" })?.action, "transform");
});

test("rejects ad hoc staging reviewer workflows", () => {
  assert.equal(isStagingMutationBlocked("subagent", { workflowScript: "return runs.all([])" }), true);
  assert.equal(isStagingMutationBlocked("subagent", { agent: "forgedock-writer" }), true);
});

test("one Pi input cannot silently combine status and review commands", async () => {
  const handlers = new Map<string, Array<(event: any, context: any) => any>>();
  const commands = new Map<string, { description?: string; handler: (args: string, context: any) => Promise<void> }>();
  const notices: Array<{ message: string; level: string }> = [];
  const fakePi = {
    registerTool() {},
    registerCommand(name: string, options: { description?: string; handler: (args: string, context: any) => Promise<void> }) { commands.set(name, options); },
    getAllTools() { return [{ name: "subagent" }, { name: "forge_prepare_review" }, { name: "forge_publish_record" }]; },
    on(name: string, handler: (event: any, context: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  };
  forgedockCandidateExtension(fakePi as never);
  const input = handlers.get("input")?.[0];
  assert.ok(input);
  const context = { hasUI: true, ui: { notify(message: string, level: string) { notices.push({ message, level }); } } };
  const combined = input({ source: "interactive", text: "/forge-status\n/review-pr 33800" }, context);
  assert.deepEqual(combined, { action: "handled" });
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.message, /one slash command per input/);
  assert.match(notices[0]!.message, /none of these commands ran/);
  assert.match(notices[0]!.message, /does not depend on a prior status check/);
  const rpcNotice = input({ source: "rpc", text: "/forge-status\n/review-pr 33800" }, { hasUI: false, ui: { notify() { assert.fail("headless input must not call UI notify"); } } });
  assert.equal(rpcNotice?.action, "transform");
  assert.match(rpcNotice?.text ?? "", /one slash command per input/);
  assert.equal(input({ source: "interactive", text: "/forge-status /review-pr 33800" }, context)?.action, "handled");
  assert.equal(notices.length, 2);

  assert.equal(input({ source: "interactive", text: "/review-pr 33800" }, context)?.action, "transform");
  const status = commands.get("forge-status");
  assert.ok(status);
  assert.match(status.description ?? "", /active ForgeDock package/);
  await status.handler("", context);
  assert.match(notices.at(-1)!.message, /ForgeDock loaded; package=/);
  assert.match(notices.at(-1)!.message, /native subagent=available/);
});

test("routes only the familiar candidate commands", () => {
  assert.equal(rewriteForgePromptAlias("/work-on 42"), "/skill:forgedock-work-on 42");
  assert.equal(rewriteForgePromptAlias("/forge:orchestrate next 2"), "/skill:forgedock-orchestrate next 2");
  assert.equal(rewriteForgePromptAlias("/review-pr-staging 9"), "/skill:forgedock-review-pr-staging 9");
  assert.equal(rewriteForgePromptAlias("/quality-gate 1"), undefined);
  assert.equal(Object.keys(FORGEDOCK_ALIASES).length, 4);
  assert.equal(isStagingMutationBlocked("write", { path: "src/app.ts" }), true);
  assert.equal(isStagingMutationBlocked("bash", { command: "git push origin staging" }), true);
  assert.equal(isStagingMutationBlocked("bash", { command: "npm test" }), true);
  assert.equal(isStagingMutationBlocked("forge_run_check", { name: "test" }), false);
  assert.equal(isStagingMutationBlocked("subagent", { agent: "forgedock-owner" }), true);
  assert.equal(isStagingMutationBlocked("subagent", { agent: "forgedock-reviewer" }), true);
  assert.equal(isStagingMutationBlocked("subagent", { workflowScript: 'return runs.run("review", { agent: "forgedock-reviewer" })' }), true);
  assert.equal(isStagingMutationBlocked("unknown", {}), true);
  assert.equal(isStagingMutationBlocked("subagent_supervisor", { action: "reply", replyTo: "request-1", message: "Proceed with the verified scope." }), false);
  assert.equal(isStagingMutationBlocked("subagent_supervisor", { action: "pending" }), false);
  assert.equal(isStagingMutationBlocked("subagent_supervisor", { action: "send", message: "unsolicited" }), true);
  assert.equal(isStagingMutationBlocked("subagent_supervisor", { action: "reply", replyTo: "request-1", message: "" }), true);
  assert.equal(isStagingMutationBlocked("todo", { action: "update", id: 2, status: "completed" }), false);
  assert.equal(isStagingMutationBlocked("todo", { action: "update", id: 2, status: "in_progress" }), true);
  assert.equal(isStagingMutationBlocked("todo", { action: "create", subject: "another task" }), true);
});
