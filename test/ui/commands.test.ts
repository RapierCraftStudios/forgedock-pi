import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  confirmExpiredLeaseTakeover,
  confirmOrchestrationDispatch,
  orchestrationResolverPrompt,
} from "../../src/ui/commands.ts";

const input = {
  issueNumbers: [2, 16, 41],
  sourceExpression: "https://github.com/owner/repo/issues",
  resolutionSummary: "Three eligible open issues; active-owned lanes excluded.",
};

test("resolver keeps failed attempts eligible for explicit retry", () => {
  const prompt = orchestrationResolverPrompt("49,50,51 --confirm");

  assert.match(prompt, /prior failed, blocked, needs-human, or cancelled attempt is retryable/i);
  assert.match(prompt, /issue remains open and no live run owns it/i);
  assert.match(prompt, /successfully terminal issues \(merged or closed\)/i);
  assert.match(prompt, /Original expression: "49,50,51 --confirm"/);
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
