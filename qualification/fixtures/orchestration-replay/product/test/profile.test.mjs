import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDisplayName } from "../src/profile.mjs";

test("producer normalizes only display text", () => {
  assert.equal(normalizeDisplayName("  Ada Lovelace  "), "ada lovelace");
});
