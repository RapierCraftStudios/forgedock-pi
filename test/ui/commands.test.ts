import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  confirmExpiredLeaseTakeover,
  confirmOrchestrationDispatch,
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

test("orchestration confirmation names the exact issue set and resolution", async () => {
  let prompt = "";
  const ui = {
    confirm: async (_title: string, message: string) => {
      prompt = message;
      return true;
    },
  } as unknown as ExtensionContext["ui"];

  await confirmOrchestrationDispatch({ hasUI: true, ui }, input);
  assert.match(prompt, /Issues: #2, #16, #41/);
  assert.match(prompt, /Source: https:\/\/github\.com\/owner\/repo\/issues/);
  assert.match(prompt, /Three eligible open issues/);
  assert.match(prompt, /may merge changes/);
});
