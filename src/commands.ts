// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Pure translation of Pi slash-command arguments into ForgeDock CLI argv. No I/O. */

export type ForgeCommand = "work-on" | "orchestrate";

/** Flags each command accepts, and whether the flag takes a value. Everything else is rejected. */
const FLAGS: Record<ForgeCommand, Record<string, boolean>> = {
  "work-on": { "--lane": true, "--lane-override": false, "--model": true, "--repo": true },
  orchestrate: { "--parallel": true, "--lane": true, "--lane-override": false, "--model": true, "--repo": true, "--no-prefilter": false, "--resume": true },
};

const ISSUE = /^#?([1-9]\d{0,9})$/;
const VALUE = /^[A-Za-z0-9._:/@-]+$/;

export class ForgeArgsError extends Error {}

/** `/work-on 12 --lane staging` → `["run-issue", "12", "--lane", "staging"]`; `/orchestrate 1 2 --parallel 4` → `["orchestrate", "1", "2", "--parallel", "4"]`. */
export function buildForgeArgv(command: ForgeCommand, input: string): string[] {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const issues: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("--")) {
      if (!(t in FLAGS[command])) throw new ForgeArgsError(`/${command}: unknown flag ${t}`);
      flags.push(t);
      if (FLAGS[command][t]) {
        const v = tokens[++i];
        if (v === undefined || v.startsWith("--") || !VALUE.test(v)) throw new ForgeArgsError(`/${command}: ${t} needs a value`);
        flags.push(v);
      }
      continue;
    }
    const m = ISSUE.exec(t);
    if (!m) throw new ForgeArgsError(`/${command}: "${t}" is not an issue number`);
    issues.push(m[1]!);
  }
  if (command === "work-on") {
    if (issues.length !== 1) throw new ForgeArgsError("usage: /work-on <issue> [--lane L] [--model M]");
    return ["run-issue", issues[0]!, ...flags];
  }
  const resuming = flags.includes("--resume");
  if (resuming ? issues.length > 0 : issues.length === 0) {
    throw new ForgeArgsError("usage: /orchestrate <issue...> [--parallel K] [--lane L] [--model M]  |  /orchestrate --resume <batch-id>");
  }
  return ["orchestrate", ...issues, ...flags];
}

/** Every ForgeDock session this package starts runs on the Pi harness. */
export function forgeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, FORGEDOCK_LEAN_RUNTIME: "pi" };
}
