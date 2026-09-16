import assert from "node:assert/strict";
import test from "node:test";

import { FORGEDOCK_ALIASES, rewriteForgePromptAlias } from "../../candidate/extension.ts";

test("routes only the familiar candidate commands", () => {
  assert.equal(rewriteForgePromptAlias("/work-on 42"), "/skill:forgedock-work-on 42");
  assert.equal(rewriteForgePromptAlias("/forge:orchestrate next 2"), "/skill:forgedock-orchestrate next 2");
  assert.equal(rewriteForgePromptAlias("/review-pr-staging 9"), "/skill:forgedock-review-pr-staging 9");
  assert.equal(rewriteForgePromptAlias("/quality-gate 1"), undefined);
  assert.equal(Object.keys(FORGEDOCK_ALIASES).length, 4);
});
