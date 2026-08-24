import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
import { FORGE_BINDING_NAMESPACE } from "../core/agent-protocol.ts";
import { RUN_PHASES, type RunEvent } from "../core/events.ts";
import { applyRunEvent } from "../core/state.ts";
import {
  FORGE_WORK_ON_OUTPUT_SCHEMA,
  isForgeWorkOnResult,
} from "../core/work-on-contracts.ts";
import {
  guardChildToolPath,
  isPathWithin,
  resolveChildRoot,
} from "./child-containment.ts";
import {
  ApprovedVerificationRunner,
  MAX_OUTPUT_BYTES,
  runProcess,
  safeEnvironment,
  truncateTail,
  type BoundVerificationCommand,
} from "./verification-runner.ts";
import {
  CheckpointProjectionService,
  checkpointStartEvent,
} from "../workflows/checkpoint-service.ts";
import { ReviewPreparationService } from "../workflows/review-preparation.ts";
import {
  FORGE_REVIEW_CORRECTNESS_AGENT,
  FORGE_REVIEW_SECURITY_AGENT,
  registerForgeAgents,
} from "./register.ts";

const BINDING_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
const BINDING_NAMESPACE = FORGE_BINDING_NAMESPACE;

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
  const verificationRunner = new ApprovedVerificationRunner(
    binding.verificationCommands,
    binding.runId,
  );
  const checkpointProjection = new CheckpointProjectionService();
  const reviewPreparation = new ReviewPreparationService();
  const agentRegistrations = registerForgeAgents(pi);
  let ceiling: SubagentCapabilityCeilingHandle | undefined;
  let canonicalRoot: string | undefined;
  let githubToken: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    canonicalRoot = await resolveChildRoot(binding.worktreeRoot, ctx.cwd);
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
    return guardChildToolPath(root, ctx.cwd, event.toolName, event.input);
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
      const added = await runProcess("git", ["-C", root, "add", "-A"], {
        cwd: root,
        timeoutMs: 30_000,
        env,
        ...(signal ? { signal } : {}),
      });
      if (added.exitCode !== 0)
        throw new Error(`git add failed: ${added.stderr}`);
      const message =
        params.kind === "implementation"
          ? `forge: implement issue #${binding.issueNumber}`
          : `forge: address review for issue #${binding.issueNumber}`;
      const committed = await runProcess(
        "git",
        ["-C", root, "commit", "--no-gpg-sign", "-m", message],
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
      verificationRunner.command(params.name);
      const root = canonicalRoot ?? (await realpath(binding.worktreeRoot));
      onUpdate?.({
        content: [
          { type: "text", text: `Running approved check ${params.name}...` },
        ],
        details: { name: params.name, status: "running" },
      });
      const result = await verificationRunner.run(params.name, root, signal);
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
          name: params.name,
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
      const identity = await reviewPreparation.prepare({
        binding: {
          runId: binding.runId,
          issueNumber: binding.issueNumber,
          repository: binding.repository,
          stateBranch: binding.stateBranch,
          branch: binding.branch,
          baseBranch: binding.baseBranch,
        },
        headSha,
        token,
        ...(signal ? { signal } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: `PR #${identity.pullNumber} is ready for nested review at ${headSha}.`,
          },
        ],
        details: identity,
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
        event = checkpointStartEvent(
          binding,
          params,
          binding.repository,
          current.state.sequence + 1,
          current.state.lastEventHash,
          binding.leaseEpoch,
          ctx.sessionManager.getSessionId(),
        );
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
        await checkpointProjection.project({
          projector,
          event,
          params,
          binding,
          ...(signal ? { signal } : {}),
        });
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

