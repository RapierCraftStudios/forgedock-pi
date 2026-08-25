import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const TRUNCATED_OUTPUT_MARKER = "[output truncated to last";

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
  maxOutputBytes?: number;
}

export interface VerificationToolUpdate {
  content: [{ type: "text"; text: string }];
  details: { name: string; status: "running" };
}

export interface ApprovedVerificationResult {
  content: [{ type: "text"; text: string }];
  details: {
    name: string;
    required: boolean;
    status: "passed" | "failed" | "unknown";
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  };
}

export function validateBoundCommand(
  name: string,
  value: unknown,
): asserts value is BoundVerificationCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Verification binding ${name} must be an object.`);
  const command = value as Record<string, unknown>;
  if (
    !Array.isArray(command.argv) ||
    command.argv.length === 0 ||
    command.argv.some((entry) => typeof entry !== "string" || !entry)
  ) {
    throw new Error(
      `Verification binding ${name}.argv must be a non-empty string array.`,
    );
  }
  if (typeof command.required !== "boolean")
    throw new Error(`Verification binding ${name}.required must be boolean.`);
  if (
    !Number.isSafeInteger(command.timeoutMs) ||
    (command.timeoutMs as number) < 1_000
  ) {
    throw new Error(
      `Verification binding ${name}.timeoutMs must be at least 1000.`,
    );
  }
}

export class ApprovedVerificationRunner {
  readonly #root: string;
  readonly #runId: string;

  constructor(root: string, runId: string) {
    this.#root = root;
    this.#runId = runId;
  }

  async run(
    name: string,
    command: BoundVerificationCommand,
    signal?: AbortSignal,
    onUpdate?: (update: VerificationToolUpdate) => void,
  ): Promise<ApprovedVerificationResult> {
    const [program, ...args] = command.argv;
    if (!program)
      throw new Error(
        `Verification command '${name}' has an empty argv.`,
      );
    onUpdate?.({
      content: [{ type: "text", text: `Running approved check ${name}...` }],
      details: { name, status: "running" },
    });
    const result = await runProcess(program, args, {
      cwd: this.#root,
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
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
      content: [
        {
          type: "text",
          text:
            truncateTail(output, MAX_OUTPUT_BYTES) ||
            `${name}: ${status}`,
        },
      ],
      details: {
        name,
        required: command.required,
        status,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
      },
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
      stdout = appendBounded(
        stdout,
        chunk,
        options.maxOutputBytes ?? MAX_OUTPUT_BYTES * 2,
      );
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(
        stderr,
        chunk,
        options.maxOutputBytes ?? MAX_OUTPUT_BYTES * 2,
      );
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

export function appendBounded(
  current: string,
  chunk: string,
  maxBytes: number,
): string {
  return truncateTail(current + chunk, maxBytes);
}

export function truncateTail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return value;
  return `[output truncated to last ${maxBytes} bytes]\n${buffer
    .subarray(buffer.byteLength - maxBytes)
    .toString("utf8")}`;
}
