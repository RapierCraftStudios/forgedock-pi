import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const MAX_OUTPUT_BYTES = 50 * 1024;

export interface BoundVerificationCommand {
  argv: readonly string[];
  required: boolean;
  timeoutMs: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}

export interface ApprovedVerificationResult {
  name: string;
  required: boolean;
  status: "passed" | "failed" | "unknown";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The only entry point for policy-bound verification commands. It validates
 * the tracked command name before spawning with shell=false and a bounded
 * Forge-owned environment.
 */
export class ApprovedVerificationRunner {
  readonly #commands: Readonly<Record<string, BoundVerificationCommand>>;
  readonly #runId: string;

  constructor(
    commands: Readonly<Record<string, BoundVerificationCommand>>,
    runId: string,
  ) {
    this.#commands = commands;
    this.#runId = runId;
  }

  command(name: string): BoundVerificationCommand {
    const command = this.#commands[name];
    if (!command)
      throw new Error(
        `Verification command '${name}' is not approved for this run.`,
      );
    return command;
  }

  async run(
    name: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ApprovedVerificationResult> {
    const command = this.command(name);
    const [program, ...args] = command.argv;
    if (!program)
      throw new Error(
        `Verification command '${name}' has an empty argv.`,
      );
    const result = await runProcess(program, args, {
      cwd,
      timeoutMs: command.timeoutMs,
      env: safeEnvironment(this.#runId),
      ...(signal ? { signal } : {}),
    });
    const status =
      result.timedOut || result.exitCode === null
        ? "unknown"
        : result.exitCode === 0
          ? "passed"
          : "failed";
    return {
      name,
      required: command.required,
      status,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

export function safeEnvironment(runId: string): NodeJS.ProcessEnv {
  const home = resolve(tmpdir(), `forgedock-verify-${runId}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const source = process.env;
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: resolve(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    CI: "1",
    FORGEDOCK_RUN_ID: runId,
    GIT_AUTHOR_NAME: "ForgeDock Pi",
    GIT_AUTHOR_EMAIL: "forgedock-pi@users.noreply.github.com",
    GIT_COMMITTER_NAME: "ForgeDock Pi",
    GIT_COMMITTER_EMAIL: "forgedock-pi@users.noreply.github.com",
  };
  for (const name of [
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (source[name]) env[name] = source[name];
  }
  return env;
}

export async function runProcess(
  program: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

export function truncateTail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return value;
  return `[output truncated to last ${maxBytes} bytes]\n${buffer
    .subarray(buffer.byteLength - maxBytes)
    .toString("utf8")}`;
}

function appendBounded(current: string, chunk: string): string {
  return truncateTail(current + chunk, MAX_OUTPUT_BYTES * 2);
}
