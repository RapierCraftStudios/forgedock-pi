// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ForgeDock for Pi: /work-on, /orchestrate and /forge-runs over the ForgeDock engine (`forgedock run-issue`,
 * `forgedock orchestrate`) with every builder/reviewer session on the Pi harness. The engine owns the lifecycle
 * (lease, worktree, labels, stage comments, review, PR, merge, close); this extension only starts runs and shows them.
 * Runs are detached and log to files, so they survive this Pi session; FD runs are lease-held and resumable.
 */
import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { buildForgeArgv, ForgeArgsError, forgeEnv, type ForgeCommand } from "./commands.ts";

interface Run { id: string; label: string; log: string; startedAt: number; exit?: number | null }

const TAIL_LINES = 4;
/** Last `n` non-empty lines of a log, reading only its final 8 KB (orchestrate logs grow). */
export function tail(file: string, n: number): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n);
  } catch { return []; } finally { if (fd !== null) closeSync(fd); }
}

export default function forgedockPi(pi: ExtensionAPI): void {
  const runs = new Map<string, Run>();
  const logDir = join(homedir(), ".forge", "pi-runs");
  const bin = process.env.FORGEDOCK_BIN || "forgedock";
  let timer: NodeJS.Timeout | null = null;
  let ui: ExtensionUIContext | null = null;

  const active = () => [...runs.values()].filter((r) => r.exit === undefined);
  const render = () => {
    if (!ui) return;
    const live = active();
    ui.setStatus("forgedock", live.length ? `forgedock: ${live.length} running` : undefined);
    ui.setWidget("forgedock", live.length ? live.flatMap((r) => [`▸ ${r.label}`, ...tail(r.log, TAIL_LINES).map((l) => `  ${l}`)]) : undefined);
    if (!live.length && timer) { clearInterval(timer); timer = null; }
  };

  const start = (command: ForgeCommand, args: string, ctx: ExtensionCommandContext) => {
    let argv: string[];
    try { argv = buildForgeArgv(command, args); } catch (e) {
      ctx.ui.notify(e instanceof ForgeArgsError ? e.message : String(e), "error");
      return;
    }
    mkdirSync(logDir, { recursive: true });
    const id = `${Date.now().toString(36)}-${argv.slice(1).filter((a) => /^\d+$/.test(a)).join("-") || "resume"}`;
    const log = join(logDir, `${id}.log`);
    const fd = openSync(log, "a");
    const child = spawn(bin, argv, { cwd: ctx.cwd, env: forgeEnv(process.env), stdio: ["ignore", fd, fd], detached: true });
    closeSync(fd);
    const run: Run = { id, label: `/${command} ${args.trim()}`, log, startedAt: Date.now() };
    runs.set(id, run);
    child.on("error", (e) => {
      run.exit = -1;
      ctx.ui.notify(`${run.label}: could not start ${bin} (${e.message}). Install ForgeDock (npm i -g forgedock) or set FORGEDOCK_BIN.`, "error");
      render();
    });
    child.on("exit", (code) => {
      run.exit = code;
      const mins = ((Date.now() - run.startedAt) / 60000).toFixed(1);
      const last = tail(log, 6).join("\n");
      ctx.ui.notify(`${run.label} ${code === 0 ? "finished" : `exited ${code}`} after ${mins} min`, code === 0 ? "info" : "warning");
      pi.sendMessage({ customType: "forgedock-run", content: `ForgeDock ${run.label} ${code === 0 ? "finished" : `exited with code ${code}`} after ${mins} min. Log: ${log}\n\n${last}`, display: true },
        { deliverAs: "nextTurn" });
      render();
    });
    child.unref();
    ui = ctx.ui;
    ctx.ui.notify(`Started ${run.label} (log: ${log})`, "info");
    if (!timer) { timer = setInterval(render, 1000); timer.unref?.(); }
    render();
  };

  pi.registerCommand("work-on", {
    description: "ForgeDock: fix one GitHub issue end to end on the Pi harness (forgedock run-issue)",
    handler: async (args, ctx) => start("work-on", args, ctx),
  });
  pi.registerCommand("orchestrate", {
    description: "ForgeDock: run several issues in parallel with Depends-on ordering (forgedock orchestrate)",
    handler: async (args, ctx) => start("orchestrate", args, ctx),
  });
  pi.registerCommand("forge-runs", {
    description: "ForgeDock: list runs started from this session",
    handler: async (_args, ctx) => {
      if (!runs.size) { ctx.ui.notify("No ForgeDock runs started from this session.", "info"); return; }
      const lines = [...runs.values()].map((r) => `${r.exit === undefined ? "running" : `exit ${r.exit}`}  ${r.label}  ${r.log}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
