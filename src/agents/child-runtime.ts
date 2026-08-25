import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  registerSubagentCapabilityCeiling,
  type SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";

import { resolveGitHubToken } from "../adapters/github-auth.ts";
import { FetchGitHubTransport } from "../adapters/github-api.ts";
import { GitHubIssueProjector } from "../adapters/github-projection.ts";
import { GitHubStateBranchStore } from "../adapters/github-state.ts";
import { ReviewPreparationService } from "../adapters/review-preparation.ts";
import {
  ApprovedVerificationRunner,
  MAX_OUTPUT_BYTES,
  MAX_RUNTIME_STATUS_BYTES,
  TRUNCATED_OUTPUT_MARKER,
  runProcess,
  safeEnvironment,
  truncateTail,
} from "../adapters/verification.ts";
import {
  CheckpointProjectionService,
  checkpointEventType,
  checkpointPayload,
  workflowLabelForCheckpoint,
} from "../adapters/checkpoint-service.ts";
import { createRunEvent, type RunEvent } from "../core/events.ts";
import { applyRunEvent } from "../core/state.ts";
import {
  FORGE_WORK_ON_OUTPUT_SCHEMA,
  isForgeWorkOnResult,
} from "./contracts.ts";
import {
  checkToolPath,
  isPathWithin,
  resolveBoundWorktreeRoot,
  writeBoundResult,
} from "./child-containment.ts";
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
const CHILD_RUN_PHASES = [
  "resolve",
  "investigate",
  "plan",
  "prepare-worktree",
  "implement",
  "verify",
  "review",
] as const;

interface BoundVerificationCommand {
  argv: readonly string[];
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

const CheckpointParameters = Type.Object({
  phase: StringEnum(CHILD_RUN_PHASES),
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
  const verificationRunner = new ApprovedVerificationRunner(
    binding.verificationCommands,
  );
  let ceiling: SubagentCapabilityCeilingHandle | undefined;
  let canonicalRoot: string | undefined;
  let githubToken: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    canonicalRoot = await resolveBoundWorktreeRoot(
      binding.worktreeRoot,
      ctx.cwd,
    );
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
    const root =
      canonicalRoot ??
      (await resolveBoundWorktreeRoot(binding.worktreeRoot, ctx.cwd));
    const denial = await checkToolPath(root, ctx.cwd, event.input, event.toolName);
    if (denial) return { block: true, reason: denial };
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
      const root =
        canonicalRoot ??
        (await resolveBoundWorktreeRoot(binding.worktreeRoot, binding.worktreeRoot));
      onUpdate?.({
        content: [
          { type: "text", text: `Running approved check ${params.name}...` },
        ],
        details: { name: params.name, status: "running" },
      });
      const result = await verificationRunner.execute(params.name, {
        cwd: root,
        runId: binding.runId,
        ...(signal ? { signal } : {}),
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              truncateTail(output, MAX_OUTPUT_BYTES) ||
              `${params.name}: ${result.status}`,
          },
        ],
        details: {
          name: result.name,
          required: result.required,
          status: result.status,
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
      const service = new ReviewPreparationService(
        {
          exec: (command, args, options) => pi.exec(command, [...args], options),
        },
        async (cwd, tokenSignal) => {
          const token =
            githubToken ??
            (await resolveGitHubToken(
              pi,
              cwd,
              tokenSignal,
              "Unable to resolve GitHub authentication for Forge checkpoint writes.",
            ));
          githubToken = token;
          return token;
        },
      );
      const prepared = await service.prepare({
        root,
        binding,
        ...(signal ? { signal } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: `PR #${prepared.pullNumber} is ready for nested review at ${prepared.headSha}.`,
          },
        ],
        details: prepared,
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
      await writeBoundResult(
        root,
        resultPath,
        `${JSON.stringify(params.value, null, 2)}\n`,
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
      if (!(CHILD_RUN_PHASES as readonly string[]).includes(params.phase))
        throw new Error(`Child checkpoints cannot target phase ${params.phase}.`);
      const token =
        githubToken ??
        (await resolveGitHubToken(
          pi,
          binding.worktreeRoot,
          signal,
          "Unable to resolve GitHub authentication for Forge checkpoint writes.",
        ));
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
        const projection = new CheckpointProjectionService(projector, binding);
        if (params.action !== "start") {
          await projection.project(event, params, signal);
        }
        const workflowLabel = workflowLabelForCheckpoint(params);
        if (workflowLabel)
          await projector.setWorkflowLabel(
            binding.issueNumber,
            workflowLabel,
            signal,
          );
        await projection.postDerived(event, params, signal);
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

