import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildForgeArgv, ForgeArgsError, forgeEnv } from "../src/commands.ts";
import forgedockPi, { tail } from "../src/extension.ts";

test("/work-on maps to forgedock run-issue with whitelisted flags", () => {
  assert.deepEqual(buildForgeArgv("work-on", "12"), ["run-issue", "12"]);
  assert.deepEqual(buildForgeArgv("work-on", " #12  --lane milestone/v2 --model openai-codex/gpt-6-luna:high"),
    ["run-issue", "12", "--lane", "milestone/v2", "--model", "openai-codex/gpt-6-luna:high"]);
  for (const bad of ["", "12 13", "abc", "12 --path full", "12 --lane", "12 --lane --retry", "12 --model a;rm", "12 --retry"]) {
    assert.throws(() => buildForgeArgv("work-on", bad), ForgeArgsError, bad);
  }
});

test("/orchestrate maps issues and batch flags, or a resume, never both", () => {
  assert.deepEqual(buildForgeArgv("orchestrate", "3 4 #5 --parallel 8 --no-prefilter"), ["orchestrate", "3", "4", "5", "--parallel", "8", "--no-prefilter"]);
  assert.deepEqual(buildForgeArgv("orchestrate", "--resume b_123"), ["orchestrate", "--resume", "b_123"]);
  assert.throws(() => buildForgeArgv("orchestrate", ""), ForgeArgsError);
  assert.throws(() => buildForgeArgv("orchestrate", "3 --resume b_1"), ForgeArgsError);
  assert.throws(() => buildForgeArgv("orchestrate", "3 --retry"), ForgeArgsError, "--retry is a work-on flag");
});

test("every run is forced onto the Pi runtime", () => {
  assert.equal(forgeEnv({ FORGEDOCK_LEAN_RUNTIME: "claude", PATH: "/bin" }).FORGEDOCK_LEAN_RUNTIME, "pi");
});

test("tail returns the last non-empty lines and tolerates a missing file", () => {
  const d = mkdtempSync(join(tmpdir(), "fdpi-tail-"));
  try {
    writeFileSync(join(d, "log"), `${"x\n".repeat(10000)}a\n\nb\nc\n`);
    assert.deepEqual(tail(join(d, "log"), 3), ["a", "b", "c"]);
    assert.deepEqual(tail(join(d, "missing"), 3), []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("/work-on starts a detached forgedock run on the pi runtime and reports its exit", async () => {
  const d = mkdtempSync(join(tmpdir(), "fdpi-ext-"));
  const prevBin = process.env.FORGEDOCK_BIN, prevHome = process.env.HOME;
  try {
    const bin = join(d, "forgedock");
    writeFileSync(bin, `#!/bin/sh\necho "argv: $*"\necho "runtime: $FORGEDOCK_LEAN_RUNTIME"\nexit 0\n`);
    chmodSync(bin, 0o755);
    process.env.FORGEDOCK_BIN = bin;
    process.env.HOME = d;
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const sent: Array<{ content: string }> = [];
    const notes: string[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const pi = {
      registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c),
      sendMessage: (m: { content: string }) => { sent.push(m); done(); },
    };
    forgedockPi(pi as never);
    assert.deepEqual([...commands.keys()].sort(), ["forge-runs", "orchestrate", "work-on"]);
    const ui = { notify: (m: string) => notes.push(m), setWidget: () => {}, setStatus: () => {} };
    await commands.get("work-on")!.handler("42 --lane staging", { cwd: d, ui });
    await finished;
    assert.match(sent[0]!.content, /\/work-on 42 --lane staging finished/);
    const log = /Log: (\S+)/.exec(sent[0]!.content)![1]!;
    assert.match(readFileSync(log, "utf8"), /argv: run-issue 42 --lane staging\nruntime: pi/);
    await commands.get("work-on")!.handler("not-a-number", { cwd: d, ui });
    assert.match(notes.at(-1)!, /not an issue number/);
  } finally {
    if (prevBin === undefined) delete process.env.FORGEDOCK_BIN; else process.env.FORGEDOCK_BIN = prevBin;
    process.env.HOME = prevHome;
    rmSync(d, { recursive: true, force: true });
  }
});
