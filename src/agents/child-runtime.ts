import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  registerSubagentCapabilityCeiling,
  type SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";

import { FetchGitHubTransport } from "../adapters/github-api.ts";
import { GitHubIssueProjector } from "../adapters/github-projection.ts";
import { GitHubStateBranchStore } from "../adapters/github-state.ts";
import { GitHubWorkflowAdapter } from "../adapters/github-workflow.ts";
import { resolveVerificationCommandDirectory } from "../adapters/verification-preflight.ts";
import {
  createRunEvent,
  RUN_PHASES,
  type RunEvent,
  type RunEventType,
  type RunPhase,
} from "../core/events.ts";
import { applyRunEvent } from "../core/state.ts";
import {
  FORGE_WORK_ON_OUTPUT_SCHEMA,
  isForgeWorkOnResult,
} from "./contracts.ts";
import {
  FORGE_REVIEW_CORRECTNESS_AGENT,
  FORGE_REVIEW_SECURITY_AGENT,
  registerForgeAgents,
} from "./register.ts";
import {
  FORGE_RUNTIME_GIT_PATHSPECS,
  FORGE_RUNTIME_PATHS,
  isForgeRuntimePath,
  parseNullDelimitedGitPaths,
} from "./runtime-paths.ts";

const BINDING_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
const BINDING_NAMESPACE = "forgedock.pi/1";
const MAX_OUTPUT_BYTES = 50 * 1024;

interface BoundVerificationCommand {
  argv: readonly string[];
  cwd: string;
  required: boolean;
  timeoutMs: number;
}

interface ForgeChildBinding {
  runId: string;
  resultPath: string;
  repository: string;
  issueNumber: number;
  leaseEpoch: number;
  stateBranch: string;
  worktreeRoot: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  maxReviewRounds: number;
  verificationCommands: Readonly<Record<string, BoundVerificationCommand>>;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const TRUNCATED_OUTPUT_MARKER = "[output truncated to last";
const MAX_RUNTIME_STATUS_BYTES = 1_024 * 1_024;

const CheckpointParameters = Type.Object({
  phase: StringEnum(RUN_PHASES),
  attempt: Type.Integer({ minimum: 1 }),
  action: StringEnum([
    "queue",
    "start",
    "complete",
    "fail",
    "block",
    "needs-human",
    "abandon",
  ] as const),
  restartAction: Type.Optional(Type.String({ minLength: 1 })),
  logicalNodeId: Type.Optional(Type.String({ minLength: 1 })),
  inputArtifactHash: Type.Optional(Type.String({ minLength: 1 })),
  outputArtifactHash: Type.Optional(Type.String({ minLength: 1 })),
  commitSha: Type.Optional(Type.String({ minLength: 7 })),
  evidence: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  report: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
  reason: Type.Optional(Type.String({ minLength: 1 })),
});

const VerifyParameters = Type.Object({
  name: Type.String({
    minLength: 1,
    description: "Tracked verification command name",
  }),
});

const DiffParameters = Type.Object({
  mode: StringEnum(["patch", "name-only", "stat"] as const),
});

const CommitParameters = Type.Object({
  kind: StringEnum(["implementation", "review-fixes"] as const),
});

const PrepareReviewParameters = Type.Object({});

const FinalizeWorkOnParameters = Type.Object({
  value: Type.Unsafe(FORGE_WORK_ON_OUTPUT_SCHEMA),
});

export default function forgeChildRuntime(pi: ExtensionAPI): void {
  const binding = readBinding();
  const agentRegistrations = registerForgeAgents(pi);
  let ceiling: SubagentCapabilityCeilingHandle | undefined;
  let canonicalRoot: string | undefined;
  let githubToken: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    canonicalRoot = await realpath(binding.worktreeRoot);
    if (!isPathWithin(canonicalRoot, await realpath(ctx.cwd))) {
      throw new Error(
        `Forge child cwd ${ctx.cwd} is outside bound worktree ${canonicalRoot}.`,
      );
    }
    ceiling?.dispose();
    ceiling = registerSubagentCapabilityCeiling({
      sessionId: ctx.sessionManager.getSessionId(),
      source: "forgedock-work-on",
      ceiling: {
        allowedAgents: [
          FORGE_REVIEW_CORRECTNESS_AGENT,
          FORGE_REVIEW_SECURITY_AGENT,
        ],
        allowedTools: ["read", "grep", "find", "ls"],
        denyExtensions: true,
      },
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      return {
        block: true,
        reason: "Raw bash is disabled in Forge work-on children.",
      };
    }
    if (
      !["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)
    )
      return;
    const root = canonicalRoot ?? (await realpath(binding.worktreeRoot));
    const pathValue = toolPath(event.input);
    if (!pathValue) return;
    const target = await canonicalizePotentialPath(ctx.cwd, pathValue);
    if (!isPathWithin(root, target)) {
      return {
        block: true,
        reason: `${event.toolName} path is outside the assigned Forge worktree.`,
      };
    }
    if (
      isPathWithin(join(root, ".pi"), target) ||
      isPathWithin(join(root, ".git"), target)
    ) {
      return {
        block: true,
        reason: `${event.toolName} cannot access Forge runtime or Git control files.`,
      };
    }
  });

  pi.registerTool({
    name: "forge_diff",
    label: "Forge Diff",
    description:
      "Read the current assigned worktree diff against the frozen base SHA",
    parameters: DiffParameters,
    async execute(_toolCallId, params, signal) {
      const root = canonicalRoot ?? (await realpath(binding.worktreeRoot));
      const modeArgs =
        params.mode === "name-only"
          ? ["--name-only"]
          : params.mode === "stat"
            ? ["--stat"]
            : ["--no-ext-diff", "--unified=80"];
      const result = await runProcess(
        "git",
        ["-C", root, "diff", ...modeArgs, binding.baseSha, "--"],
        {
          cwd: root,
          timeoutMs: 60_000,
          env: safeEnvironment(binding.runId),
          ...(signal ? { signal } : {}),
        },
      );
      if (result.exitCode !== 0)
        throw new Error(
          `git diff failed (${String(result.exitCode)}): ${result.stderr}`,
        );
      return {
        content: [
          {
            type: "text",
            text: truncateTail(result.stdout, MAX_OUTPUT_BYTES) || "No diff.",
          },
        ],
        details: {
          mode: params.mode,
          baseSha: binding.baseSha,
          exitCode: result.exitCode,
        },
      };
    },
  });

  pi.registerTool({
    name: "forge_commit",
    label: "Forge Commit",
    description:
      "Create an owned local commit from the assigned worktree without pushing",
    parameters: CommitParameters,
    async execute(_toolCallId, params, signal) {
      const root = canonicalRoot ?? (await realpath(binding.worktreeRoot));
      const env = safeEnvironment(binding.runId);
      const status = await runProcess(
        "git",
        ["-C", root, "status", "--porcelain"],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      if (status.exitCode !== 0)
        throw new Error(`git status failed: ${status.stderr}`);
      if (!status.stdout.trim())
        throw new Error(
          "Cannot create a Forge commit with no worktree changes.",
        );
      const trackedRuntime = await runProcess(
        "git",
        [
          "-C",
          root,
          "ls-tree",
          "-r",
          "-z",
          "--name-only",
          "HEAD",
          "--",
          ...FORGE_RUNTIME_PATHS,
        ],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      if (trackedRuntime.exitCode !== 0)
        throw new Error(`git ls-tree failed: ${trackedRuntime.stderr}`);
      const trackedRuntimePaths = new Set(
        parseNullDelimitedGitPaths(trackedRuntime.stdout),
      );

      const added = await runProcess(
        "git",
        ["-C", root, "add", "-A", "--", ".", ...FORGE_RUNTIME_GIT_PATHSPECS],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      if (added.exitCode !== 0)
        throw new Error(`git add failed: ${added.stderr}`);

      const trackedRuntimeUpdated = await runProcess(
        "git",
        ["-C", root, "add", "-u", "--", "."],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      if (trackedRuntimeUpdated.exitCode !== 0)
        throw new Error(`git add -u failed: ${trackedRuntimeUpdated.stderr}`);

      const staged = await runProcess(
        "git",
        [
          "-C",
          root,
          "diff",
          "--cached",
          "--name-only",
          "-z",
          "--",
          ...FORGE_RUNTIME_PATHS,
        ],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          maxOutputBytes: MAX_RUNTIME_STATUS_BYTES,
          ...(signal ? { signal } : {}),
        },
      );
      if (staged.exitCode !== 0)
        throw new Error(`git diff --cached failed: ${staged.stderr}`);
      if (staged.stdout.includes(TRUNCATED_OUTPUT_MARKER))
        throw new Error(
          "Forge commit refused to validate runtime paths because Git output was truncated.",
        );
      const newlyStagedRuntimePaths = [
        ...new Set(
          parseNullDelimitedGitPaths(staged.stdout).filter(
            (path) =>
              isForgeRuntimePath(path) && !trackedRuntimePaths.has(path),
          ),
        ),
      ];
      if (newlyStagedRuntimePaths.length > 0) {
        const reset = await runProcess(
          "git",
          ["-C", root, "reset", "--", ...newlyStagedRuntimePaths],
          {
            cwd: root,
            timeoutMs: 30_000,
            env,
            ...(signal ? { signal } : {}),
          },
        );
        if (reset.exitCode !== 0)
          throw new Error(`git reset failed: ${reset.stderr}`);
        throw new Error(
          `Forge commit refused newly staged runtime paths: ${newlyStagedRuntimePaths.join(", ")}`,
        );
      }

      const message =
        params.kind === "implementation"
          ? `forge: implement issue #${binding.issueNumber}`
          : `forge: address review for issue #${binding.issueNumber}`;
      const committed = await runProcess(
        "git",
        [
          "-C",
          root,
          "commit",
          "--no-gpg-sign",
          "--no-verify",
          "-m",
          message,
        ],
        {
          cwd: root,
          timeoutMs: 120_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      if (committed.exitCode !== 0)
        throw new Error(
          `git commit failed: ${committed.stderr || committed.stdout}`,
        );
      const head = await runProcess("git", ["-C", root, "rev-parse", "HEAD"], {
        cwd: root,
        timeoutMs: 30_000,
        env,
        ...(signal ? { signal } : {}),
      });
      if (head.exitCode !== 0 || !head.stdout.trim())
        throw new Error(`Unable to resolve committed HEAD: ${head.stderr}`);
      return {
        content: [
          {
            type: "text",
            text: `Created ${params.kind} commit ${head.stdout.trim()}.`,
          },
        ],
        details: { kind: params.kind, headSha: head.stdout.trim(), message },
      };
    },
  });

  pi.registerTool({
    name: "forge_verify",
    label: "Forge Verify",
    description:
      "Run one operator-approved verification command by tracked name; arbitrary shell is not accepted",
    parameters: VerifyParameters,
    async execute(_toolCallId, params, signal, onUpdate) {
      const command = binding.verificationCommands[params.name];
      if (!command)
        throw new Error(
          `Verification command '${params.name}' is not approved for this run.`,
        );
      const [program, ...args] = command.argv;
      if (!program)
        throw new Error(
          `Verification command '${params.name}' has an empty argv.`,
        );
      const root = canonicalRoot ?? (await realpath(binding.worktreeRoot));
      const cwd = await resolveVerificationCommandDirectory(root, command.cwd);
      onUpdate?.({
        content: [
          { type: "text", text: `Running approved check ${params.name}...` },
        ],
        details: { name: params.name, status: "running" },
      });
      const result = await runProcess(program, args, {
        cwd,
        timeoutMs: command.timeoutMs,
        env: safeEnvironment(binding.runId),
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
              `${params.name}: ${status}`,
          },
        ],
        details: {
          name: params.name,
          cwd,
          required: command.required,
          status,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
        },
      };
    },
  });

  pi.registerTool({
    name: "forge_prepare_review",
    label: "Forge Prepare Review",
    description:
      "Push the bound clean branch, create or reuse its PR, post FORGE:REVIEW_STARTED, and return the frozen review identity",
    parameters: PrepareReviewParameters,
    async execute(_toolCallId, _params, signal) {
      const root = canonicalRoot ?? (await realpath(binding.worktreeRoot));
      const status = await runProcess(
        "git",
        ["-C", root, "status", "--porcelain"],
        {
          cwd: root,
          timeoutMs: 30_000,
          env: safeEnvironment(binding.runId),
          ...(signal ? { signal } : {}),
        },
      );
      if (status.exitCode !== 0)
        throw new Error(`git status failed: ${status.stderr}`);
      if (status.stdout.trim()) {
        throw new Error(
          "Review preparation requires a clean committed worktree. Run forge_commit again for residual formatting or review-fix changes.",
        );
      }
      const head = await runProcess("git", ["-C", root, "rev-parse", "HEAD"], {
        cwd: root,
        timeoutMs: 30_000,
        env: safeEnvironment(binding.runId),
        ...(signal ? { signal } : {}),
      });
      const headSha = head.stdout.trim();
      if (head.exitCode !== 0 || !headSha)
        throw new Error(`Unable to resolve review HEAD: ${head.stderr}`);
      const push = await pi.exec(
        "git",
        ["-C", root, "push", "--set-upstream", "origin", binding.branch],
        {
          cwd: root,
          timeout: 120_000,
          ...(signal ? { signal } : {}),
        },
      );
      if (push.code !== 0)
        throw new Error(
          `Bound branch push failed: ${push.stderr || push.stdout}`,
        );

      const token =
        githubToken ??
        (await resolveGitHubToken(pi, binding.worktreeRoot, signal));
      githubToken = token;
      const transport = new FetchGitHubTransport({ token });
      const github = new GitHubWorkflowAdapter(transport, binding.repository);
      const issue = await github.getIssue(binding.issueNumber, signal);
      const pull = await github.createPullRequest({
        title: issue.title,
        body: `## Summary\n\nImplements #${binding.issueNumber} through ForgeDock Pi run \`${binding.runId}\`.\n\n## Testing\n\nRequired checks passed before review.\n\nCloses #${binding.issueNumber}\n\n**Reviewed head**: \`${headSha}\``,
        head: binding.branch,
        base: binding.baseBranch,
        ...(signal ? { signal } : {}),
      });
      if (pull.headSha !== headSha)
        throw new Error(
          `Created PR head ${pull.headSha} does not match frozen review head ${headSha}.`,
        );

      const store = new GitHubStateBranchStore(
        transport,
        binding.repository,
        binding.stateBranch,
      );
      const current = await store.readRun(binding.runId, signal);
      const event = current.events.at(-1);
      if (!event)
        throw new Error(
          "Cannot post review-started artifact without a run event.",
        );
      const projector = new GitHubIssueProjector(transport, binding.repository);
      await projector.postArtifact({
        issueNumber: binding.issueNumber,
        runId: binding.runId,
        eventId: event.eventId,
        artifactKey: "review-started",
        markdown: `PR #${pull.number} created targeting \`${binding.baseBranch}\`. The isolated review route is active for the required domains at commit \`${headSha}\`.\n\nReview will verify the builder contract, acceptance evidence, changed behavior, and absence of security/regression findings before merge.\n\n<!-- FORGE:REVIEW_STARTED -->`,
        ...(signal ? { signal } : {}),
      });
      await projector.setWorkflowLabel(
        binding.issueNumber,
        "workflow:in-review",
        signal,
      );
      await github.postPullArtifact({
        pullNumber: pull.number,
        marker: `<!-- FORGE:REVIEW_ROUTE mode=single-pr spec=review-pr.md sha=${headSha.slice(0, 7)} -->`,
        body: `Review domains: correctness, security.\nTarget: ${binding.baseBranch}.`,
        ...(signal ? { signal } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: `PR #${pull.number} is ready for nested review at ${headSha}.`,
          },
        ],
        details: {
          pullNumber: pull.number,
          pullUrl: pull.htmlUrl,
          headSha,
          baseSha: pull.baseSha,
          baseRef: pull.baseRef,
        },
      };
    },
  });

  pi.registerTool({
    name: "forge_finalize_work_on",
    label: "Forge Finalize Work-On",
    description:
      "Persist the schema-valid final work-on result for deterministic parent reconciliation",
    parameters: FinalizeWorkOnParameters,
    async execute(_toolCallId, params) {
      if (!isForgeWorkOnResult(params.value))
        throw new Error("Final work-on result failed schema validation.");
      if (
        params.value.runId !== binding.runId ||
        params.value.issueNumber !== binding.issueNumber
      ) {
        throw new Error(
          "Final work-on result identity does not match the bound run.",
        );
      }
      const root = canonicalRoot ?? (await realpath(binding.worktreeRoot));
      const resultPath = resolve(binding.resultPath);
      if (!isPathWithin(join(root, ".pi", "forge"), resultPath)) {
        throw new Error(
          "Bound result path is outside the protected Forge result directory.",
        );
      }
      await mkdir(dirname(resultPath), { recursive: true, mode: 0o700 });
      await writeFile(
        resultPath,
        `${JSON.stringify(params.value, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return {
        content: [
          {
            type: "text",
            text: `Persisted final work-on result for run ${binding.runId}.`,
          },
        ],
        details: { resultPath },
      };
    },
  });

  pi.registerTool({
    name: "forge_checkpoint",
    label: "Forge Checkpoint",
    description:
      "Request a typed, core-validated phase transition in the authoritative GitHub run journal",
    parameters: CheckpointParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const token =
        githubToken ??
        (await resolveGitHubToken(pi, binding.worktreeRoot, signal));
      githubToken = token;
      const transport = new FetchGitHubTransport({ token });
      const store = new GitHubStateBranchStore(
        transport,
        binding.repository,
        binding.stateBranch,
      );
      const current = await store.readRun(binding.runId, signal);
      if (!current.state || !current.lease)
        throw new Error(
          `Authoritative run ${binding.runId} is not initialized.`,
        );
      if (
        current.lease.epoch !== binding.leaseEpoch ||
        current.lease.ownerRunId !== binding.runId
      ) {
        throw new Error(
          `Bound lease epoch ${binding.leaseEpoch} no longer owns run ${binding.runId}.`,
        );
      }
      const idempotencyKey = `phase:${params.phase}:${params.attempt}:${params.action}`;
      const priorEventId = current.state.idempotencyKeys[idempotencyKey];
      let event: RunEvent;
      let sequence: number;
      let stateTip = current.tip;
      let idempotent = false;

      if (priorEventId) {
        const priorEvent = current.events.find(
          (candidate) => candidate.eventId === priorEventId,
        );
        if (!priorEvent)
          throw new Error(
            `Checkpoint event ${priorEventId} is missing from the journal.`,
          );
        event = priorEvent;
        sequence = current.state.sequence;
        idempotent = true;
      } else {
        event = createRunEvent({
          runId: binding.runId,
          repository: binding.repository,
          sequence: current.state.sequence + 1,
          previousEventHash: current.state.lastEventHash,
          type: checkpointEventType(params.action),
          actor: {
            kind: "extension",
            sessionId: ctx.sessionManager.getSessionId(),
            leaseEpoch: binding.leaseEpoch,
          },
          idempotencyKey,
          payload: checkpointPayload(params, binding),
        });
        const nextState = applyRunEvent(current.state, event);
        stateTip = await store.commitRunState({
          expectedTip: current.tip,
          events: [...current.events, event],
          state: nextState,
          lease: current.lease,
          message: `Checkpoint ${binding.runId} ${params.phase} ${params.action}`,
          ...(signal ? { signal } : {}),
        });
        sequence = nextState.sequence;
      }

      if (params.action !== "queue") {
        const projector = new GitHubIssueProjector(
          transport,
          binding.repository,
        );
        if (params.action !== "start") {
          await projectPhaseReport(projector, event, params, binding, signal);
        }
        const workflowLabel = workflowLabelForCheckpoint(params);
        if (workflowLabel)
          await projector.setWorkflowLabel(
            binding.issueNumber,
            workflowLabel,
            signal,
          );
        await postDerivedPhaseArtifacts(
          projector,
          event,
          params,
          binding,
          signal,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: idempotent
              ? `Checkpoint already recorded by event ${event.eventId}.`
              : `Recorded ${params.phase} ${params.action} at sequence ${sequence}.`,
          },
        ],
        details: {
          eventId: event.eventId,
          idempotent,
          sequence,
          stateTip,
        },
      };
    },
  });

  pi.on("session_shutdown", () => {
    ceiling?.dispose();
    ceiling = undefined;
    for (const registration of agentRegistrations) registration.dispose();
  });
}

function readBinding(): ForgeChildBinding {
  const raw = process.env[BINDING_ENV];
  if (!raw)
    throw new Error(`${BINDING_ENV} is required for the Forge child runtime.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid ${BINDING_ENV}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Forge extension bindings must be an object.");
  const binding = (parsed as Record<string, unknown>)[BINDING_NAMESPACE];
  if (!binding || typeof binding !== "object" || Array.isArray(binding))
    throw new Error(`Missing ${BINDING_NAMESPACE} binding.`);
  const value = binding as Record<string, unknown>;
  const requiredStrings = [
    "runId",
    "resultPath",
    "repository",
    "stateBranch",
    "worktreeRoot",
    "branch",
    "baseBranch",
    "baseSha",
  ] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || !(value[field] as string).trim())
      throw new Error(`Forge binding ${field} is required.`);
  }
  if (
    !Number.isSafeInteger(value.issueNumber) ||
    (value.issueNumber as number) < 1
  )
    throw new Error("Forge binding issueNumber must be positive.");
  if (
    !Number.isSafeInteger(value.leaseEpoch) ||
    (value.leaseEpoch as number) < 1
  )
    throw new Error("Forge binding leaseEpoch must be positive.");
  if (
    !Number.isSafeInteger(value.maxReviewRounds) ||
    (value.maxReviewRounds as number) < 1 ||
    (value.maxReviewRounds as number) > 5
  ) {
    throw new Error("Forge binding maxReviewRounds must be from 1 through 5.");
  }
  const commands = value.verificationCommands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands))
    throw new Error("Forge binding verificationCommands must be an object.");
  const verificationCommands: Record<string, BoundVerificationCommand> = {};
  for (const [name, commandValue] of Object.entries(commands)) {
    validateBoundCommand(name, commandValue);
    verificationCommands[name] = commandValue;
  }
  return {
    runId: value.runId as string,
    resultPath: value.resultPath as string,
    repository: value.repository as string,
    issueNumber: value.issueNumber as number,
    leaseEpoch: value.leaseEpoch as number,
    stateBranch: value.stateBranch as string,
    worktreeRoot: value.worktreeRoot as string,
    branch: value.branch as string,
    baseBranch: value.baseBranch as string,
    baseSha: value.baseSha as string,
    maxReviewRounds: value.maxReviewRounds as number,
    verificationCommands,
  };
}

function validateBoundCommand(
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
  if (typeof command.cwd !== "string" || !command.cwd.trim())
    throw new Error(`Verification binding ${name}.cwd must be a non-empty path.`);
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

function checkpointEventType(
  action:
    | "queue"
    | "start"
    | "complete"
    | "fail"
    | "block"
    | "needs-human"
    | "abandon",
): RunEventType {
  const eventTypes: Record<typeof action, RunEventType> = {
    queue: "phase.queued",
    start: "phase.started",
    complete: "phase.completed",
    fail: "phase.failed",
    block: "phase.blocked",
    "needs-human": "phase.needs-human",
    abandon: "phase.abandoned",
  };
  return eventTypes[action];
}

function checkpointPayload(
  params: {
    phase: RunPhase;
    attempt: number;
    action:
      | "queue"
      | "start"
      | "complete"
      | "fail"
      | "block"
      | "needs-human"
      | "abandon";
    restartAction?: string;
    logicalNodeId?: string;
    inputArtifactHash?: string;
    outputArtifactHash?: string;
    commitSha?: string;
    evidence?: string[];
    report?: string;
    reason?: string;
  },
  binding: ForgeChildBinding,
): Record<string, unknown> {
  const common = { phase: params.phase, attempt: params.attempt };
  if (params.action === "queue") {
    return {
      ...common,
      restartAction:
        params.restartAction ??
        `resume ${params.phase} attempt ${params.attempt}`,
      ...(params.inputArtifactHash
        ? { inputArtifactHash: params.inputArtifactHash }
        : {}),
    };
  }
  if (params.action === "start") {
    return {
      ...common,
      logicalNodeId:
        params.logicalNodeId ?? `${params.phase}-${params.attempt}`,
      worktreePath: binding.worktreeRoot,
      branch: binding.branch,
      baseSha: binding.baseSha,
    };
  }
  if (params.action === "complete") {
    return {
      ...common,
      evidence: params.evidence ?? [],
      ...(params.report ? { report: params.report } : {}),
      ...(params.outputArtifactHash
        ? { outputArtifactHash: params.outputArtifactHash }
        : {}),
      ...(params.commitSha ? { commitSha: params.commitSha } : {}),
    };
  }
  return {
    ...common,
    reason:
      params.reason ??
      `${params.phase} attempt ${params.attempt} ${params.action}`,
  };
}

async function projectPhaseReport(
  projector: GitHubIssueProjector,
  event: RunEvent,
  params: {
    phase: RunPhase;
    attempt: number;
    action:
      | "queue"
      | "start"
      | "complete"
      | "fail"
      | "block"
      | "needs-human"
      | "abandon";
    evidence?: string[];
    report?: string;
    reason?: string;
  },
  binding: ForgeChildBinding,
  signal?: AbortSignal,
): Promise<void> {
  if (
    params.action === "complete" &&
    (params.phase === "resolve" ||
      params.phase === "prepare-worktree" ||
      params.phase === "review")
  )
    return;
  if (
    params.phase === "plan" &&
    params.action === "complete" &&
    params.report
  ) {
    const blocks = splitPlanReport(params.report);
    for (const block of blocks) {
      await projector.postArtifact({
        issueNumber: binding.issueNumber,
        runId: binding.runId,
        eventId: event.eventId,
        artifactKey: block.key,
        markdown: block.body,
        ...(signal ? { signal } : {}),
      });
    }
    return;
  }
  await projector.projectEvent({
    issueNumber: binding.issueNumber,
    event,
    markdown: checkpointMarkdown(params, binding.runId),
    addLabels: ["fail", "block", "needs-human"].includes(params.action)
      ? ["needs-human"]
      : [],
    ...(signal ? { signal } : {}),
  });
}

function splitPlanReport(report: string): Array<{ key: string; body: string }> {
  const markers = [
    { key: "builder-contract", marker: "<!-- FORGE:CONTRACT -->" },
    { key: "implementation-context", marker: "<!-- FORGE:CONTEXT -->" },
    { key: "architecture-plan", marker: "<!-- FORGE:ARCHITECT -->" },
  ];
  return markers.map((entry, index) => {
    const start = report.indexOf(entry.marker);
    if (start < 0) throw new Error(`Plan report is missing ${entry.marker}.`);
    const nextMarker = markers[index + 1];
    const end = nextMarker
      ? report.indexOf(nextMarker.marker, start + entry.marker.length)
      : report.length;
    if (end < 0)
      throw new Error(
        `Plan report markers are out of order near ${entry.marker}.`,
      );
    return { key: entry.key, body: report.slice(start, end).trim() };
  });
}

function checkpointMarkdown(
  params: {
    phase: RunPhase;
    attempt: number;
    action:
      | "queue"
      | "start"
      | "complete"
      | "fail"
      | "block"
      | "needs-human"
      | "abandon";
    evidence?: string[];
    report?: string;
    reason?: string;
  },
  runId: string,
): string {
  if (params.action === "complete" && params.report) {
    validatePhaseReport(params.phase, params.report);
    return params.report.trim();
  }
  const evidence = params.evidence?.length
    ? `\n\n### Evidence\n${params.evidence.map((entry) => `- ${entry}`).join("\n")}`
    : "";
  const reason = params.reason ? `\n\n**Reason**: ${params.reason}` : "";
  return `## ForgeDock Phase — ${params.phase}\n\n**Status**: ${params.action}\n**Attempt**: ${params.attempt}\n**Run**: \`${runId}\`${reason}${evidence}`;
}

async function postDerivedPhaseArtifacts(
  projector: GitHubIssueProjector,
  event: RunEvent,
  params: {
    phase: RunPhase;
    attempt: number;
    action:
      | "queue"
      | "start"
      | "complete"
      | "fail"
      | "block"
      | "needs-human"
      | "abandon";
    commitSha?: string;
    report?: string;
  },
  binding: ForgeChildBinding,
  signal?: AbortSignal,
): Promise<void> {
  if (params.action !== "complete") return;
  if (params.phase === "investigate") {
    await projector.postArtifact({
      issueNumber: binding.issueNumber,
      runId: binding.runId,
      eventId: event.eventId,
      artifactKey: "investigation-checkpoint",
      markdown: `<!-- FORGE:CHECKPOINT -->\n\`\`\`json\n${JSON.stringify({ phase: "INVESTIGATION", status: "COMPLETE", next_phase: "BUILD", timestamp: event.occurredAt })}\n\`\`\``,
      ...(signal ? { signal } : {}),
    });
    await projector.postArtifact({
      issueNumber: binding.issueNumber,
      runId: binding.runId,
      eventId: event.eventId,
      artifactKey: "fast-path",
      markdown: `<!-- FORGE:FAST_PATH -->\n## Fast-Path Classification\n\n**COMPLEXITY_BAND**: STANDARD\n**Task type**: Bug Fix\n**Rationale**: Full Pi-native work-on pipeline selected from the confirmed investigation.\n**Phases skipped**: none — full pipeline`,
      ...(signal ? { signal } : {}),
    });
  }
  if (params.phase === "verify") {
    await projector.appendToLatestComment({
      issueNumber: binding.issueNumber,
      marker: "<!-- FORGE:BUILDER -->",
      append: "<!-- FORGE:BUILDER:COMPLETE -->",
      skipIfContains: "<!-- FORGE:BUILDER:COMPLETE -->",
      ...(signal ? { signal } : {}),
    });
    await projector.postArtifact({
      issueNumber: binding.issueNumber,
      runId: binding.runId,
      eventId: event.eventId,
      artifactKey: "build-checkpoint",
      markdown: `<!-- FORGE:CHECKPOINT -->\n${JSON.stringify({ phase: "BUILD", status: "COMPLETE", next_phase: "REVIEW", timestamp: event.occurredAt, commit: params.commitSha ?? null, acceptance_gate: "PASSED" })}`,
      ...(signal ? { signal } : {}),
    });
  }
}

function workflowLabelForCheckpoint(params: {
  phase: RunPhase;
  action:
    | "queue"
    | "start"
    | "complete"
    | "fail"
    | "block"
    | "needs-human"
    | "abandon";
  report?: string;
}): string | undefined {
  if (params.action === "start") {
    if (params.phase === "investigate") return "workflow:investigating";
    if (
      params.phase === "plan" ||
      params.phase === "prepare-worktree" ||
      params.phase === "implement" ||
      params.phase === "verify"
    ) {
      return "workflow:building";
    }
    if (params.phase === "review") return "workflow:in-review";
  }
  if (params.action === "complete" && params.phase === "investigate") {
    return params.report?.includes("**Verdict**: INVALID")
      ? "workflow:invalid"
      : "workflow:ready-to-build";
  }
  return undefined;
}

function validatePhaseReport(phase: RunPhase, report: string): void {
  const requiredByPhase: Partial<Record<RunPhase, readonly string[]>> = {
    investigate: [
      "<!-- FORGE:INVESTIGATOR -->",
      "## Investigation Report",
      "### Root Cause",
      "### Evidence",
      "### Acceptance Spec",
      "<!-- INVESTIGATION:COMPLETE -->",
    ],
    plan: [
      "<!-- FORGE:CONTRACT -->",
      "## Builder Contract",
      "<!-- FORGE:CONTEXT -->",
      "<!-- FORGE:CONTEXT:COMPLETE -->",
      "<!-- FORGE:ARCHITECT -->",
      "<!-- FORGE:ARCHITECT:COMPLETE -->",
    ],
    implement: [
      "<!-- FORGE:BUILDER -->",
      "## Implementation Complete",
      "### Approach",
      "### Changes",
      "### Acceptance Criteria Status",
      "### Testing Checklist",
    ],
    verify: [
      "<!-- FORGE:ACCEPTANCE_GATE -->",
      "<!-- FORGE:ACCEPTANCE_GATE:PASSED -->",
    ],
  };
  const missing = (requiredByPhase[phase] ?? []).filter(
    (marker) => !report.includes(marker),
  );
  if (missing.length > 0) {
    throw new Error(
      `Phase ${phase} report is missing canonical ForgeDock fields: ${missing.join(", ")}.`,
    );
  }
}

function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const value = (input as Record<string, unknown>).path;
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function canonicalizePotentialPath(
  cwd: string,
  inputPath: string,
): Promise<string> {
  const absolute = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(cwd, inputPath);
  const missingSegments: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missingSegments);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isPathWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function resolveGitHubToken(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await pi.exec("gh", ["auth", "token"], {
    cwd,
    timeout: 10_000,
    ...(signal ? { signal } : {}),
  });
  const token = result.stdout.trim();
  if (result.code !== 0 || !token)
    throw new Error(
      "Unable to resolve GitHub authentication for Forge checkpoint writes.",
    );
  return token;
}

function safeEnvironment(runId: string): NodeJS.ProcessEnv {
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

async function runProcess(
  program: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
  },
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

function appendBounded(
  current: string,
  chunk: string,
  maxBytes: number,
): string {
  return truncateTail(current + chunk, maxBytes);
}

function truncateTail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return value;
  return `[output truncated to last ${maxBytes} bytes]\n${buffer.subarray(buffer.byteLength - maxBytes).toString("utf8")}`;
}
