import assert from "node:assert/strict";
import test from "node:test";
import { renderProfile } from "../src/render.mjs";

const profile = { id: "USR-7", name: "  Ada Lovelace  " };

test("rendering applies the display-boundary decision", () => {
  assert.equal(renderProfile(profile), "USR-7:ada lovelace");
  assert.equal(profile.id, "USR-7");
  assert.equal(profile.name, "  Ada Lovelace  ");
});
