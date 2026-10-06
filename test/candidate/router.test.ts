import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import forgedockCandidateExtension, { FORGEDOCK_ALIASES, isStagingMutationBlocked, ownerDirectTargetPushBlockReason, ownerIssueCloseBlockReason, ownerIssueCreateBlockReason, ownerMergeBlockReason, rewriteForgePromptAlias } from "../../candidate/extension.ts";

test("automatic promotion handoff activates and settles the staging guard", async () => {
  const reviewRoot = await mkdtemp(join(tmpdir(), "forgedock-route-guard-"));
  try {
    const workflowPath = join(reviewRoot, "workflow.js");
    const workflow = "const assignments = [];\n";
    await writeFile(workflowPath, workflow);
    const review = { schema: "forgedock.candidate-review/v1", artifactRoot: reviewRoot, artifactKey: "test-review", repository: "example/product", pullRequest: 7, head: "a".repeat(40), baseRef: "main", baseSha: "b".repeat(40), sourceRoot: reviewRoot, configPath: join(reviewRoot, "forge.yaml"), configSha256: "c".repeat(64), mode: "staging", roles: ["correctness"], workflowPath, workflowSha256: createHash("sha256").update(workflow).digest("hex"), config: { protectedBranch: "main", verificationCommands: {} } };
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

test("bound PR-only authority cannot be promoted into merge or close authority", () => {
  const authority = { schema: "forgedock.candidate-owner-authority/v1" as const, repository: "example/product", issue: 33409, deliveryMode: "github" as const, target: "staging", protectedTarget: "main", mergeTargets: [], closeIssueAfterMerge: false, closeInvalidIssue: false, scope: "", createIssues: false };
  const head = "a".repeat(40);
  const merge = `gh pr merge 123 --repo example/product --squash --match-head-commit ${head}`;
  const matchingPull = { number: 123, state: "OPEN", baseRefName: "staging", headRefOid: head, mergeable: "MERGEABLE", closingIssuesReferences: [{ number: 33409, url: "https://github.com/example/product/issues/33409" }] };
  assert.match(ownerMergeBlockReason(merge, authority, matchingPull) ?? "", /not explicitly authorized/);
  assert.match(ownerIssueCloseBlockReason("gh issue close 33409 --repo example/product", authority) ?? "", /not authorized/);
  assert.match(ownerDirectTargetPushBlockReason("git push origin staging", authority) ?? "", /Direct push/);
  const localReplayAuthority = { ...authority, deliveryMode: "local-replay" as const };
  assert.equal(ownerMergeBlockReason(merge, localReplayAuthority, { state: "OPEN", baseRefName: "staging", headRefOid: head, mergeable: "MERGEABLE" })?.includes("Local replay"), true);
  assert.equal(ownerDirectTargetPushBlockReason("git push origin staging", localReplayAuthority), undefined);
  assert.match(ownerDirectTargetPushBlockReason("git push origin main", localReplayAuthority) ?? "", /Direct push/);

  const stagingAuthority = { ...authority, mergeTargets: ["staging"] };
  assert.match(ownerMergeBlockReason(merge, stagingAuthority, { ...matchingPull, baseRefName: "main" }) ?? "", /state\/base\/head/);
  assert.match(ownerMergeBlockReason(`gh pr merge 123 --auto --repo example/product --match-head-commit ${head}`, stagingAuthority, matchingPull) ?? "", /Automatic merge/);
  assert.match(ownerMergeBlockReason(merge, stagingAuthority, { ...matchingPull, closingIssuesReferences: [{ number: 33390, url: "https://github.com/example/product/issues/33390" }] }) ?? "", /not linked to the exact bound issue #33409/);
  assert.match(ownerMergeBlockReason(merge, stagingAuthority, { ...matchingPull, closingIssuesReferences: [...matchingPull.closingIssuesReferences, { number: 33390, url: "https://github.com/example/product/issues/33390" }] }) ?? "", /not linked to the exact bound issue #33409/);
  assert.match(ownerMergeBlockReason(merge, stagingAuthority, { ...matchingPull, number: 124 }) ?? "", /readback does not match the requested pull request/);
  assert.equal(ownerMergeBlockReason(merge, stagingAuthority, matchingPull), undefined);
  assert.match(ownerMergeBlockReason(`${merge} && gh pr merge 124 --repo example/product --match-head-commit ${head}`, stagingAuthority, matchingPull) ?? "", /multiple PR merge operations/);
  assert.match(ownerMergeBlockReason(`${merge} && gh api repos/example/product/pulls/124/merge -X PUT`, stagingAuthority, matchingPull) ?? "", /multiple PR merge operations/);
  assert.match(ownerMergeBlockReason(`${merge} && gh api \\\n    repos/example/product/pulls/124/merge -X PUT`, stagingAuthority, matchingPull) ?? "", /multiple PR merge operations/);
  assert.match(ownerMergeBlockReason("gh api \\\nrepos/example/product/pulls/124/merge -X PUT", stagingAuthority) ?? "", /Direct merge API calls are blocked/);
});

test("issue closure and API issue creation require exact scoped evidence", () => {
  const authority = { schema: "forgedock.candidate-owner-authority/v1" as const, scope: "", repository: "example/product", issue: 33409, deliveryMode: "github" as const, target: "staging", protectedTarget: "main", mergeTargets: ["staging"], closeIssueAfterMerge: true, closeInvalidIssue: false, createIssues: false };
  const delivery = { repository: "example/product", issue: 33409, target: "staging", pullRequest: 123, headSha: "a".repeat(40) };
  assert.match(ownerIssueCloseBlockReason("gh issue close 33409", authority) ?? "", /read-back-confirmed merged PR/);
  assert.equal(ownerIssueCloseBlockReason("gh issue close 33409", authority, delivery), undefined);
  assert.match(ownerIssueCloseBlockReason("gh issue close 33409", authority, { ...delivery, issue: 33390 }) ?? "", /read-back-confirmed merged PR/);
  assert.match(ownerIssueCloseBlockReason("gh api repos/example/product/issues/33409 -X PATCH -f state=closed", authority) ?? "", /read-back-confirmed merged PR/);
  assert.match(ownerIssueCloseBlockReason("gh api repos/example/product/issues/33409 -X PATCH \\\n    -f state=closed", authority) ?? "", /read-back-confirmed merged PR/);
  assert.equal(ownerIssueCloseBlockReason("gh api repos/example/product/issues/33409 -X PATCH -f state=closed", authority, delivery), undefined);
  assert.match(ownerIssueCloseBlockReason("gh api repos/example/product/issues/33409/ -X PATCH -f state=closed", authority) ?? "", /read-back-confirmed merged PR/);
  assert.match(ownerIssueCloseBlockReason("gh api repos/example/product/issues/33390 -X PATCH -f state=closed", authority, delivery) ?? "", /does not match a bound/);
  assert.match(ownerIssueCloseBlockReason("gh api graphql -f query='mutation { closeIssue(input: {}) { issue { number } } }'", authority, delivery) ?? "", /GraphQL issue-state changes/);
  assert.match(ownerIssueCloseBlockReason("gh api graphql -F query=@mutation.graphql", authority, delivery) ?? "", /GraphQL issue-state changes/);
  assert.match(ownerIssueCloseBlockReason("gh api graphql --input=close-mutation.graphql", authority, delivery) ?? "", /GraphQL issue-state changes/);
  assert.match(ownerIssueCloseBlockReason("gh api repos/example/product/issues/33409 -X PATCH --input=close-body.json", authority, delivery) ?? "", /Direct issue API mutations/);
  const invalidAuthority = { ...authority, closeIssueAfterMerge: false, closeInvalidIssue: true };
  assert.match(ownerIssueCloseBlockReason("gh issue close 33409", invalidAuthority) ?? "", /static scope authority alone is insufficient/);
  assert.match(ownerIssueCreateBlockReason("gh api repos/example/product/issues -X POST", authority) ?? "", /Creating additional issues/);
  assert.match(ownerIssueCreateBlockReason("gh api \\\n  repos/example/product/issues -X POST", authority) ?? "", /Creating additional issues/);
  assert.match(ownerIssueCreateBlockReason("gh api repos/example/product/issues/ -X POST", authority) ?? "", /Creating additional issues/);
  assert.match(ownerIssueCreateBlockReason("gh api graphql -f query='mutation { createIssue(input: {}) { issue { number } } }'", authority) ?? "", /GraphQL issue creation/);
  assert.match(ownerIssueCreateBlockReason("gh api graphql -F query=@create-issue.graphql", authority) ?? "", /GraphQL issue creation/);
  assert.match(ownerIssueCreateBlockReason("gh api graphql --input=create-issue.graphql", authority) ?? "", /GraphQL issue creation/);
  assert.match(ownerIssueCreateBlockReason("gh api --input=issue-body.json repos/example/product/issues", authority) ?? "", /Creating additional issues/);
});

test("owner issue closure is allowed only after exact staging merge readback", async () => {
  const previousBindings = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  const previousPath = process.env.PATH;
  const root = await mkdtemp(join(tmpdir(), "forgedock-issue-close-readback-"));
  const fakeGh = join(root, "gh");
  await writeFile(fakeGh, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === "api") { process.stdout.write(JSON.stringify([[{ event: "cross-referenced", source: { issue: { number: 123, pull_request: { url: "https://github.com/example/product/pull/123" } } } }]])); }\nelse if (args[0] === "pr" && args[1] === "view") { process.stdout.write(JSON.stringify({ number: 123, state: process.env.FAKE_PR_STATE || "MERGED", baseRefName: process.env.FAKE_PR_BASE || "staging", headRefOid: "${"a".repeat(40)}", mergedAt: "2026-10-06T12:00:00Z", closingIssuesReferences: [{ number: 33409, url: "https://github.com/example/product/issues/33409" }] })); }\nelse process.exit(2);\n`, { mode: 0o755 });
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "forgedock.candidate-owner-authority/1": { schema: "forgedock.candidate-owner-authority/v1", scope: "", repository: "example/product", issue: 33409, deliveryMode: "github", target: "staging", protectedTarget: "main", mergeTargets: ["staging"], closeIssueAfterMerge: true, closeInvalidIssue: false, createIssues: false } });
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  try {
    const handlers = new Map<string, Array<(event: any) => any>>();
    const fakePi = { registerTool() {}, registerCommand() {}, getAllTools() { return []; }, on(name: string, handler: (event: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
    forgedockCandidateExtension(fakePi as never);
    const toolCall = handlers.get("tool_call")?.[0];
    assert.ok(toolCall);
    assert.equal(toolCall({ toolName: "bash", toolCallId: "close-after-merge", input: { command: "gh issue close 33409" } }), undefined);
    process.env.FAKE_PR_BASE = "main";
    assert.match(toolCall({ toolName: "bash", toolCallId: "close-after-main", input: { command: "gh issue close 33409" } })?.reason ?? "", /read-back-confirmed merged PR/);
  } finally {
    if (previousBindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previousBindings;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.FAKE_PR_BASE;
    delete process.env.FAKE_PR_STATE;
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate child tool guard blocks direct merge under a bound PR-only authority", () => {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "forgedock.candidate-owner-authority/1": { schema: "forgedock.candidate-owner-authority/v1", repository: "example/product", issue: 33409, deliveryMode: "github", target: "staging", protectedTarget: "main", mergeTargets: [], closeIssueAfterMerge: false, closeInvalidIssue: false, scope: "", createIssues: false } });
  try {
    const handlers = new Map<string, Array<(event: any) => any>>();
    const fakePi = { registerTool() {}, registerCommand() {}, getAllTools() { return []; }, on(name: string, handler: (event: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
    forgedockCandidateExtension(fakePi as never);
    const toolCall = handlers.get("tool_call")?.[0];
    assert.ok(toolCall);
    assert.match(toolCall({ toolName: "bash", input: { command: "gh pr merge 123 --repo example/product" } })?.reason ?? "", /not explicitly authorized/);
    assert.match(toolCall({ toolName: "bash", input: { command: "gh pr merge 123 --repo example/product && gh pr merge 124 --repo example/product" } })?.reason ?? "", /multiple PR merge operations/);
    assert.match(toolCall({ toolName: "bash", input: { command: "gh issue close 33409" } })?.reason ?? "", /not authorized/);
    assert.match(toolCall({ toolName: "bash", input: { command: "gh api repos/example/product/issues/33409 -X PATCH -f state=closed" } })?.reason ?? "", /not authorized/);
    assert.match(toolCall({ toolName: "bash", input: { command: "gh issue create --repo example/product --title extra" } })?.reason ?? "", /Creating additional issues/);
    assert.match(toolCall({ toolName: "bash", input: { command: "gh api \\\nrepos/example/product/issues -X POST" } })?.reason ?? "", /Creating additional issues/);
    assert.match(toolCall({ toolName: "forge_publish_adjudication", input: { allowIssueWrites: true } })?.reason ?? "", /follow-up issue/);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous;
  }
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
