import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  FORGE_PROMPT_ALIASES,
  registerForgePromptRouter,
  rewriteForgePromptAlias,
} from "../../src/prompt-router.ts";

const cases = [
  ["/work-on 42", "/skill:forgedock-work-on 42"],
  ["/forge:work-on next", "/skill:forgedock-work-on next"],
  ["/orchestrate #1 #2 --confirm", "/skill:forgedock-orchestrate #1 #2 --confirm"],
  ["/review-pr 99 --thorough", "/skill:forgedock-review-pr 99 --thorough"],
  [
    "/review-pr-staging 101",
    "/skill:forgedock-review-pr-staging 101",
  ],
] as const;

test("friendly commands rewrite lexically to native Pi skills", () => {
  for (const [input, expected] of cases)
    assert.equal(rewriteForgePromptAlias(input), expected);
});

test("alias rewriting preserves multiline arguments and rejects near matches", () => {
  assert.equal(
    rewriteForgePromptAlias('/work-on 42 --note "a b"\nsecond line'),
    '/skill:forgedock-work-on 42 --note "a b"\nsecond line',
  );
  for (const input of [
    "/review-pr-other 1",
    "/work-onward 1",
    "work-on 1",
    "/model",
    "/skill:forgedock-work-on 1",
  ])
    assert.equal(rewriteForgePromptAlias(input), undefined);
});

test("input router transforms user/RPC input and never loops extension input", () => {
  let handler:
    | ((event: { source: string; text: string }) => unknown)
    | undefined;
  registerForgePromptRouter({
    on: (name: string, value: typeof handler) => {
      assert.equal(name, "input");
      handler = value;
    },
  } as never);
  assert.ok(handler);
  assert.deepEqual(handler({ source: "interactive", text: "/work-on 42" }), {
    action: "transform",
    text: "/skill:forgedock-work-on 42",
  });
  assert.deepEqual(handler({ source: "rpc", text: "/review-pr 7" }), {
    action: "transform",
    text: "/skill:forgedock-review-pr 7",
  });
  assert.deepEqual(handler({ source: "extension", text: "/work-on 42" }), {
    action: "continue",
  });
});

test("package exposes every prompt, skill, adapter, and authoritative root spec", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    pi: { prompts: string[]; skills: string[] };
    files: string[];
  };
  assert.deepEqual(packageJson.pi.prompts, ["./prompts"]);
  assert.deepEqual(packageJson.pi.skills, ["./skills"]);
  for (const path of ["prompts/", "skills/", "specs/"])
    assert.ok(packageJson.files.includes(path));

  await access("specs/pi-adapter.md");
  for (const [command, skill] of Object.entries(FORGE_PROMPT_ALIASES)) {
    await access(`prompts/${command}.md`);
    const skillText = await readFile(`skills/${skill}/SKILL.md`, "utf8");
    assert.ok(skillText.includes(`name: ${skill}`));
    assert.match(skillText, /specs\/pi-adapter\.md/);
  }
  for (const path of [
    "specs/original/commands/orchestrate.md",
    "specs/original/commands/work-on.md",
    "specs/original/commands/review-pr.md",
    "specs/original/commands/review-pr-staging.md",
    "specs/original/commands/quality-gate.md",
    "specs/original/commands/review-pr-agents/protocols.md",
  ])
    await access(path);
});
