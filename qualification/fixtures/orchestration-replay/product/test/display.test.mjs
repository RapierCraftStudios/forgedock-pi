import assert from "node:assert/strict";
import test from "node:test";
import { renderProfile } from "../src/render.mjs";

const profile = { id: "User-7", name: "  ALICE  " };

test("rendering consumes the producer behavior and keeps the absent-team two-segment output", () => {
  assert.equal(renderProfile(profile), "User-7:alice");
  assert.deepEqual(profile, { id: "User-7", name: "  ALICE  " });
});

test("rendering includes an optional team label verbatim as the third segment", () => {
  const input = { id: "User-7", name: "  ALICE  ", teamLabel: "Platform" };
  assert.equal(renderProfile(input), "User-7:alice:Platform");
  assert.deepEqual(input, { id: "User-7", name: "  ALICE  ", teamLabel: "Platform" });
});

test("rendering does not normalize or trim the team-label segment", () => {
  const input = { id: "User-7", name: "  ALICE  ", teamLabel: "  Platform  " };
  assert.equal(renderProfile(input), "User-7:alice:  Platform  ");
  assert.deepEqual(input, { id: "User-7", name: "  ALICE  ", teamLabel: "  Platform  " });
});
