import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  registerSubagentCapabilityCeiling,
  type SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";

import { FetchGitHubTransport } from "../adapters/github-api.ts";
import { parseChangedGitPaths } from "../adapters/git.ts";
import { GitHubIssueProjector } from "../adapters/github-projection.ts";
import { GitHubStateBranchStore } from "../adapters/github-state.ts";
import { GitHubWorkflowAdapter } from "../adapters/github-workflow.ts";
import {
  assertBuilderContractPaths,
  type BuilderPathContract,
  validateBuilderPathContract,
} from "../core/builder-contract.ts";
import {
  RUN_PHASES,
  type RunEvent,
  type RunEventType,
  type RunPhase,
} from "../core/events.ts";
import { RunJournal } from "../adapters/run-journal.ts";
import { phaseArtifactValidationError } from "../core/comment-contract.ts";
import {
  canonicalizePotentialPath,
  isPathWithin,
  toolPath,
} from "./child-containment.ts";
import {
  FORGE_NODE_OUTPUT_SCHEMA,
  FORGE_REVIEWER_OUTPUT_SCHEMA,
  FORGE_WORK_ON_OUTPUT_SCHEMA,
  isForgeNodeResult,
  isForgeReviewerResult,
  isForgeWorkOnResult,
} from "./contracts.ts";
import {
  FORGE_REVIEW_CORRECTNESS_AGENT,
  FORGE_REVIEW_SECURITY_AGENT,
  registerForgeAgents,
} from "./register.ts";

const BINDING_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
const BINDING_NAMESPACE = "forgedock.pi/1";
const MAX_OUTPUT_BYTES = 50 * 1024;

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
  leaseOwnerRunId: string;
  stateBranch: string;
  worktreeRoot: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  maxReviewRounds: number;
  verificationCommands: Readonly<Record<string, BoundVerificationCommand>>;
  builderContract?: BuilderPathContract;
  nodeId?: string;
  node?: string;
  nodeAttempt?: number;
  reviewHeadSha?: string;
  refresh: boolean;
  previousReviewRounds?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}

export class ForgeOutputLimitError extends Error {
  readonly code = "forgedock-output-truncated";

  constructor(operation: string) {
    super(`${operation} exceeded the trusted output limit; refusing to consume incomplete security evidence.`);
    this.name = "ForgeOutputLimitError";
  }
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

const RefreshBaseParameters = Type.Object({});

const DiffParameters = Type.Object({
  mode: StringEnum(["patch", "name-only", "stat"] as const),
});

const CommitParameters = Type.Object({
  kind: StringEnum(["implementation", "review-fixes"] as const),
});

const PrepareReviewParameters = Type.Object({});

const FinalizeReviewerParameters = Type.Object({
  value: Type.Unsafe(FORGE_REVIEWER_OUTPUT_SCHEMA),
});

const FinalizeNodeParameters = Type.Object({
  value: Type.Unsafe(FORGE_NODE_OUTPUT_SCHEMA),
});

const FinalizeWorkOnParameters = Type.Object({
  value: Type.Unsafe(FORGE_WORK_ON_OUTPUT_SCHEMA),
});

export default function forgeChildRuntime(pi: ExtensionAPI): void {
  const binding = readBinding();
  const agentRegistrations = registerForgeAgents(pi);
  let ceiling: SubagentCapabilityCeilingHandle | undefined;
  let canonicalRoot: string | undefined;
  let caseInsensitivePaths: boolean | undefined;
  let githubToken: string | undefined;
  let refreshPushLeaseSha: string | undefined;
  let reviewDiffCoverage:
    | { headSha: string; sha256: string; bytes: number }
    | undefined;

  pi.on("session_start", async (_event, ctx) => {
    canonicalRoot = await realpath(binding.worktreeRoot);
    caseInsensitivePaths = await checkoutIgnoresCase(
      canonicalRoot,
      binding.runId,
    );
    if (
      !isPathWithin(
        canonicalRoot,
        await realpath(ctx.cwd),
        caseInsensitivePaths,
      )
    ) {
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
    const denial = boundedToolDenial(binding.node, event.toolName);
    if (denial) return { block: true, reason: denial };
    if (event.toolName.startsWith("forge_") || event.toolName === "subagent") {
      const allowed = allowedNodeTools(binding.node);
      if (!allowed.has(event.toolName)) return { block: true, reason: `${event.toolName} is not allowed for bounded node ${binding.node ?? "legacy"}.` };
    }
    if (
      !["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)
    )
      return;
    const root = canonicalRoot ?? (await realpath(binding.worktreeRoot));
    const pathValue = toolPath(event.input);
    if (!pathValue) return;
    const target = await canonicalizePotentialPath(ctx.cwd, pathValue);
    const ignoreCase =
      caseInsensitivePaths ?? (await checkoutIgnoresCase(root, binding.runId));
    if (!isPathWithin(root, target, ignoreCase)) {
      return {
        block: true,
        reason: `${event.toolName} path is outside the assigned Forge worktree.`,
      };
    }
    if (
      isPathWithin(join(root, ".pi"), target, ignoreCase) ||
      isPathWithin(join(root, ".git"), target, ignoreCase)
    ) {
      return {
        block: true,
        reason: `${event.toolName} cannot access Forge runtime or Git control files.`,
      };
    }
  });

  pi.registerTool({
    name: "forge_refresh_base",
    label: "Forge Refresh Base",
    description:
      "Rebase the owned clean branch onto the bound latest integration SHA using a guarded remote-branch lease",
    parameters: RefreshBaseParameters,
    async execute(_toolCallId, _params, signal) {
      if (!binding.refresh)
        throw new Error(
          "forge_refresh_base is only available to a bound refresh-review run.",
        );
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
      assertCompleteProcessOutput(status, "Refresh worktree path listing");
      const refreshStatus = nonRuntimeStatus(
        status.stdout,
        caseInsensitivePaths ?? (await checkoutIgnoresCase(root, binding.runId)),
      );
      if (status.exitCode !== 0 || refreshStatus)
        throw new Error(
          `Base refresh requires a clean worktree: ${status.stderr || refreshStatus}`,
        );
      const fetched = await runProcess(
        "git",
        [
          "-C",
          root,
          "fetch",
          "--no-tags",
          "origin",
          binding.baseBranch,
          binding.branch,
        ],
        {
          cwd: root,
          timeoutMs: 120_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      if (fetched.exitCode !== 0)
        throw new Error(`Unable to fetch refresh refs: ${fetched.stderr}`);
      const base = await runProcess(
        "git",
        ["-C", root, "rev-parse", `origin/${binding.baseBranch}^{commit}`],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      const actualBaseSha = base.stdout.trim();
      if (base.exitCode !== 0 || actualBaseSha !== binding.baseSha)
        throw new Error(
          `Bound refresh base ${binding.baseSha} changed to ${actualBaseSha || "unknown"}; restart refresh with a new binding.`,
        );
      const remote = await runProcess(
        "git",
        ["-C", root, "rev-parse", `origin/${binding.branch}^{commit}`],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      if (remote.exitCode !== 0 || !remote.stdout.trim())
        throw new Error(
          "Cannot refresh a lane without the existing owned remote branch.",
        );
      refreshPushLeaseSha = remote.stdout.trim();
      const rebased = await runProcess(
        "git",
        ["-C", root, "rebase", binding.baseSha],
        {
          cwd: root,
          timeoutMs: 120_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      if (rebased.exitCode !== 0) {
        await runProcess("git", ["-C", root, "rebase", "--abort"], {
          cwd: root,
          timeoutMs: 30_000,
          env,
        });
        throw new Error(
          `Controlled rebase failed and was aborted: ${rebased.stderr || rebased.stdout}`,
        );
      }
      const head = await runProcess(
        "git",
        ["-C", root, "rev-parse", "HEAD"],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      if (head.exitCode !== 0 || !head.stdout.trim())
        throw new Error(`Unable to resolve refreshed HEAD: ${head.stderr}`);
      return {
        content: [
          {
            type: "text",
            text: `Rebased the owned lane onto ${binding.baseSha}; refreshed HEAD is ${head.stdout.trim()}.`,
          },
        ],
        details: {
          baseSha: binding.baseSha,
          headSha: head.stdout.trim(),
          remoteLeaseSha: refreshPushLeaseSha,
        },
      };
    },
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
      const reviewerHead = binding.node?.startsWith("review-")
        ? binding.reviewHeadSha
        : undefined;
      if (binding.node?.startsWith("review-") && !reviewerHead)
        throw new Error("Reviewer diff requires an exact frozen head SHA.");
      if (reviewerHead && params.mode !== "patch")
        throw new Error("Reviewer diff coverage requires the complete patch mode.");
      if (reviewerHead) {
        const actualHead = await runProcess(
          "git",
          ["-C", root, "rev-parse", "HEAD"],
          {
            cwd: root,
            timeoutMs: 30_000,
            env: safeEnvironment(binding.runId),
            ...(signal ? { signal } : {}),
          },
        );
        assertCompleteProcessOutput(actualHead, "review HEAD resolution");
        if (actualHead.exitCode !== 0 || actualHead.stdout.trim() !== reviewerHead)
          throw new Error(
            `Reviewer diff is bound to ${reviewerHead}, found ${actualHead.stdout.trim() || "unknown"}.`,
          );
      }
      const result = await runProcess(
        "git",
        [
          "-C",
          root,
          "diff",
          ...modeArgs,
          binding.baseSha,
          ...(reviewerHead ? [reviewerHead] : []),
          "--",
        ],
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
      assertCompleteReviewDiff(result, MAX_OUTPUT_BYTES);
      const headSha = reviewerHead ?? await gitHead(root, binding.runId, signal);
      const patchSha256 = createHash("sha256").update(result.stdout).digest("hex");
      if (reviewerHead)
        reviewDiffCoverage = {
          headSha: reviewerHead,
          sha256: patchSha256,
          bytes: Buffer.byteLength(result.stdout),
        };
      return {
        content: [
          {
            type: "text",
            text: result.stdout || "No diff.",
          },
        ],
        details: {
          mode: params.mode,
          baseSha: binding.baseSha,
          headSha,
          exitCode: result.exitCode,
          coverage: {
            complete: true,
            bytes: Buffer.byteLength(result.stdout),
            sha256: patchSha256,
          },
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
      const ignoreCase =
        caseInsensitivePaths ?? (await checkoutIgnoresCase(root, binding.runId));
      const status = await runProcess(
        "git",
        ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "-z"],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      assertCompleteProcessOutput(status, "Git worktree path listing");
      if (status.exitCode !== 0)
        throw new Error(`git status failed: ${status.stderr}`);
      const changedPaths = parseGitStatusPaths(status.stdout);
      const runtimePaths = changedPaths.filter((path) =>
        isForgeRuntimePath(path, ignoreCase),
      );
      if (runtimePaths.length > 0)
        throw new Error(
          `Refusing to commit Forge runtime paths: ${runtimePaths.join(", ")}.`,
        );
      if (changedPaths.length === 0)
        throw new Error("Cannot create a Forge commit with no worktree changes.");
      if (binding.node === "implement" && !binding.builderContract)
        throw new Error(
          "Implementation commit refused without an accepted builder contract.",
        );
      if (binding.builderContract)
        assertBuilderContractPaths(binding.builderContract, changedPaths);
      const added = await runProcess(
        "git",
        ["-C", root, "add", "-A", "--", ...changedPaths],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      assertCompleteProcessOutput(added, "Git staging");
      if (added.exitCode !== 0) throw new Error(`git add failed: ${added.stderr}`);
      const staged = await runProcess(
        "git",
        [
          "-C",
          root,
          "diff",
          "--cached",
          "--name-status",
          "--find-renames",
          "-z",
          "--",
        ],
        {
          cwd: root,
          timeoutMs: 30_000,
          env,
          ...(signal ? { signal } : {}),
        },
      );
      assertCompleteProcessOutput(staged, "Git staged path listing");
      if (staged.exitCode !== 0)
        throw new Error(`staged-path validation failed: ${staged.stderr}`);
      const stagedPaths = parseChangedGitPaths(staged.stdout);
      if (stagedPaths.some((path) => isForgeRuntimePath(path, ignoreCase)))
        throw new Error("Refusing to commit staged Forge runtime paths.");
      if (stagedPaths.length === 0)
        throw new Error(
          "Cannot create a Forge commit with no validated implementation changes.",
        );
      if (binding.builderContract)
        assertBuilderContractPaths(binding.builderContract, stagedPaths);
      const preCommitHead = await gitHead(root, binding.runId, signal);
      const stagedTreeResult = await runProcess("git", ["-C", root, "write-tree"], {
        cwd: root,
        timeoutMs: 30_000,
        env,
        ...(signal ? { signal } : {}),
      });
      assertCompleteProcessOutput(stagedTreeResult, "Git staged tree resolution");
      if (stagedTreeResult.exitCode !== 0 || !stagedTreeResult.stdout.trim())
        throw new Error(`Unable to resolve staged tree: ${stagedTreeResult.stderr}`);
      const stagedTree = stagedTreeResult.stdout.trim();
      const message =
        params.kind === "implementation"
          ? `forge: implement issue #${binding.issueNumber}`
          : `forge: address review for issue #${binding.issueNumber}`;
      const hooksPath = mkdtempSync(join(tmpdir(), "forgedock-empty-hooks-"));
      let committed: ProcessResult;
      try {
        committed = await runProcess(
          "git",
          forgeCommitArguments(root, hooksPath, message),
          {
            cwd: root,
            timeoutMs: 120_000,
            env,
            ...(signal ? { signal } : {}),
          },
        );
      } finally {
        rmSync(hooksPath, { recursive: true, force: true });
      }
      assertCompleteProcessOutput(committed, "Git commit");
      if (committed.exitCode !== 0)
        throw new Error(`git commit failed: ${committed.stderr || committed.stdout}`);
      const headSha = await gitHead(root, binding.runId, signal);
      const tree = await runProcess(
        "git",
        ["-C", root, "show", "-s", "--format=%T", headSha],
        { cwd: root, timeoutMs: 30_000, env, ...(signal ? { signal } : {}) },
      );
      const parent = await runProcess(
        "git",
        ["-C", root, "rev-parse", `${headSha}^`],
        { cwd: root, timeoutMs: 30_000, env, ...(signal ? { signal } : {}) },
      );
      const committedPathsResult = await runProcess(
        "git",
        ["-C", root, "diff", "--name-only", "-z", preCommitHead, headSha, "--"],
        { cwd: root, timeoutMs: 30_000, env, ...(signal ? { signal } : {}) },
      );
      assertCompleteProcessOutput(tree, "Committed tree resolution");
      assertCompleteProcessOutput(parent, "Commit parent resolution");
      assertCompleteProcessOutput(committedPathsResult, "Committed path listing");
      if (tree.exitCode !== 0 || parent.exitCode !== 0 || committedPathsResult.exitCode !== 0)
        throw new Error("Unable to revalidate the Forge-owned commit.");
      const committedPaths = committedPathsResult.stdout
        .split("\0")
        .filter(Boolean);
      assertCommittedTree({
        preCommitHead,
        actualParent: parent.stdout.trim(),
        stagedTree,
        committedTree: tree.stdout.trim(),
        stagedPaths,
        committedPaths,
        ignoreCase,
      });
      if (binding.builderContract) {
        const contractPaths = await runProcess(
          "git",
          [
            "-C",
            root,
            "diff",
            "--name-status",
            "--find-renames",
            "-z",
            binding.baseSha,
            headSha,
            "--",
          ],
          {
            cwd: root,
            timeoutMs: 30_000,
            env,
            ...(signal ? { signal } : {}),
          },
        );
        assertCompleteProcessOutput(
          contractPaths,
          "Builder contract committed path listing",
        );
        if (contractPaths.exitCode !== 0)
          throw new Error(
            `Unable to validate committed builder contract paths: ${contractPaths.stderr}`,
          );
        assertBuilderContractPaths(
          binding.builderContract,
          parseChangedGitPaths(contractPaths.stdout),
        );
      }
      return {
        content: [{ type: "text", text: `Created ${params.kind} commit ${headSha}.` }],
        details: {
          kind: params.kind,
          headSha,
          message,
          treeSha: stagedTree,
          committedPaths,
          hooksDisabled: true,
        },
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
      onUpdate?.({
        content: [
          { type: "text", text: `Running approved check ${params.name}...` },
        ],
        details: { name: params.name, status: "running" },
      });
      const result = await runProcess(program, args, {
        cwd: root,
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
      assertCompleteProcessOutput(status, "Review worktree path listing");
      if (status.exitCode !== 0)
        throw new Error(`git status failed: ${status.stderr}`);
      if (
        nonRuntimeStatus(
          status.stdout,
          caseInsensitivePaths ?? (await checkoutIgnoresCase(root, binding.runId)),
        )
      ) {
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
      if (binding.builderContract) {
        const committedPaths = await runProcess(
          "git",
          [
            "-C",
            root,
            "diff",
            "--name-status",
            "--find-renames",
            "-z",
            binding.baseSha,
            headSha,
            "--",
          ],
          {
            cwd: root,
            timeoutMs: 30_000,
            env: safeEnvironment(binding.runId),
            ...(signal ? { signal } : {}),
          },
        );
        if (committedPaths.exitCode !== 0)
          throw new Error(`git committed diff failed: ${committedPaths.stderr}`);
        assertBuilderContractPaths(
          binding.builderContract,
          parseChangedGitPaths(committedPaths.stdout),
        );
      }
      if (binding.refresh && !refreshPushLeaseSha)
        throw new Error(
          "Refreshed review cannot push before forge_refresh_base establishes the remote branch lease.",
        );
      const pushArgs = [
        "-C",
        root,
        "push",
        "--set-upstream",
        ...(binding.refresh
          ? [
              `--force-with-lease=refs/heads/${binding.branch}:${refreshPushLeaseSha}`,
            ]
          : []),
        "origin",
        binding.branch,
      ];
      const push = await pi.exec("git", pushArgs, {
        cwd: root,
        timeout: 120_000,
        ...(signal ? { signal } : {}),
      });
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
    name: "forge_finalize_reviewer",
    label: "Forge Finalize Reviewer",
    description:
      "Persist one schema-valid read-only reviewer result at the trusted bound result path",
    parameters: FinalizeReviewerParameters,
    async execute(_toolCallId, params) {
      if (!binding.nodeId || !binding.node?.startsWith("review-"))
        throw new Error(
          "forge_finalize_reviewer requires a bounded reviewer binding.",
        );
      if (!isForgeReviewerResult(params.value))
        throw new Error("Final reviewer result failed schema validation.");
      assertReviewerDiffCoverage(reviewDiffCoverage, binding.reviewHeadSha);
      const expectedReviewer = binding.node === "review-security"
        ? "security"
        : "correctness";
      if (
        params.value.runId !== binding.runId ||
        (params.value.reviewer !== expectedReviewer &&
          params.value.reviewer !== `forge-review-${expectedReviewer}`) ||
        params.value.headSha !== binding.reviewHeadSha
      )
        throw new Error(
          "Final reviewer result identity does not match its binding.",
        );
      const root = canonicalRoot ?? (await realpath(binding.worktreeRoot));
      const resultPath = resolve(binding.resultPath);
      if (!isPathWithin(join(root, ".pi", "forge"), resultPath))
        throw new Error(
          "Bound reviewer result path is outside the protected Forge result directory.",
        );
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
            text: `Persisted ${binding.nodeId} reviewer result.`,
          },
        ],
        details: { resultPath, nodeId: binding.nodeId },
      };
    },
  });

  pi.registerTool({
    name: "forge_finalize_node",
    label: "Forge Finalize Node",
    description:
      "Persist one schema-valid bounded node result at the trusted bound result path",
    parameters: FinalizeNodeParameters,
    async execute(_toolCallId, params) {
      if (!binding.nodeId || !binding.node || !binding.nodeAttempt)
        throw new Error("forge_finalize_node requires a bounded node binding.");
      if (!isForgeNodeResult(params.value)) {
        const artifact =
          params.value && typeof params.value === "object" && !Array.isArray(params.value)
            ? (params.value as { artifact?: unknown }).artifact
            : undefined;
        throw new Error(
          `Final node result failed schema validation: ${phaseArtifactValidationError(artifact)}.`,
        );
      }
      if (
        params.value.runId !== binding.runId ||
        params.value.issueNumber !== binding.issueNumber ||
        params.value.nodeId !== binding.nodeId ||
        params.value.node !== binding.node ||
        params.value.branch !== binding.branch ||
        params.value.baseSha !== binding.baseSha
      )
        throw new Error("Final node result identity does not match its binding.");
      const root = canonicalRoot ?? (await realpath(binding.worktreeRoot));
      const resultPath = resolve(binding.resultPath);
      if (!isPathWithin(join(root, ".pi", "forge"), resultPath))
        throw new Error(
          "Bound node result path is outside the protected Forge result directory.",
        );
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
            text: `Persisted ${binding.nodeId} result for run ${binding.runId}.`,
          },
        ],
        details: { resultPath, nodeId: binding.nodeId },
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
      if (
        binding.refresh &&
        params.value.review.rounds !==
          (binding.previousReviewRounds ?? 0) + 1
      ) {
        throw new Error(
          "Refreshed work-on result must increment the prior review round exactly once.",
        );
      }
      if (params.value.baseSha !== binding.baseSha)
        throw new Error(
          "Final work-on result base SHA does not match the bound base.",
        );
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
      if (binding.refresh)
        throw new Error(
          "Refresh-review runs cannot mutate the original phase journal.",
        );
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
        current.lease.ownerRunId !== binding.leaseOwnerRunId
      ) {
        throw new Error(
          `Bound lease epoch ${binding.leaseEpoch} no longer authorizes run ${binding.runId}.`,
        );
      }
      const idempotencyKey = `phase:${params.phase}:${params.attempt}:${params.action}`;
      const priorEventId = current.state.idempotencyKeys[idempotencyKey];
      const journal = new RunJournal(store);
      const snapshot = await journal.append({
        runId: binding.runId,
        type: checkpointEventType(params.action),
        payload: checkpointPayload(params, binding),
        idempotencyKey,
        sessionId: ctx.sessionManager.getSessionId(),
        message: `Checkpoint ${binding.runId} ${params.phase} ${params.action}`,
        ...(signal ? { signal } : {}),
      });
      const eventId = snapshot.state.idempotencyKeys[idempotencyKey];
      const event = snapshot.events.find(
        (candidate) => candidate.eventId === eventId,
      );
      if (!event)
        throw new Error(
          `Checkpoint event ${String(eventId)} is missing from the journal.`,
        );
      const sequence = snapshot.state.sequence;
      const stateTip = snapshot.tip;
      const idempotent = priorEventId !== undefined;

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
    "leaseOwnerRunId",
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
  const builderContract = value.builderContract;
  if (builderContract !== undefined) validateBuilderPathContract(builderContract);
  const commands = value.verificationCommands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands))
    throw new Error("Forge binding verificationCommands must be an object.");
  const verificationCommands: Record<string, BoundVerificationCommand> = {};
  for (const [name, commandValue] of Object.entries(commands)) {
    validateBoundCommand(name, commandValue);
    verificationCommands[name] = commandValue;
  }
  const node = typeof value.node === "string" ? value.node : undefined;
  if (
    node &&
    (typeof value.nodeId !== "string" ||
      !value.nodeId.trim() ||
      !Number.isSafeInteger(value.nodeAttempt) ||
      (value.nodeAttempt as number) < 1)
  )
    throw new Error(
      "Bounded node bindings require nodeId and a positive nodeAttempt.",
    );
  if (
    node?.startsWith("review-") &&
    (typeof value.reviewHeadSha !== "string" || !value.reviewHeadSha.trim())
  )
    throw new Error("Reviewer bindings require reviewHeadSha.");
  const refresh = value.refresh === true;
  const previousReviewRounds = value.previousReviewRounds;
  if (
    refresh &&
    (!Number.isSafeInteger(previousReviewRounds) ||
      (previousReviewRounds as number) < 1 ||
      (previousReviewRounds as number) >= (value.maxReviewRounds as number))
  ) {
    throw new Error(
      "Refresh binding previousReviewRounds must allow one additional review round.",
    );
  }
  return {
    runId: value.runId as string,
    resultPath: value.resultPath as string,
    repository: value.repository as string,
    issueNumber: value.issueNumber as number,
    leaseEpoch: value.leaseEpoch as number,
    leaseOwnerRunId: value.leaseOwnerRunId as string,
    stateBranch: value.stateBranch as string,
    worktreeRoot: value.worktreeRoot as string,
    branch: value.branch as string,
    baseBranch: value.baseBranch as string,
    baseSha: value.baseSha as string,
    maxReviewRounds: value.maxReviewRounds as number,
    verificationCommands,
    ...(builderContract ? { builderContract } : {}),
    ...(node
      ? {
          nodeId: value.nodeId as string,
          node,
          nodeAttempt: value.nodeAttempt as number,
          ...(typeof value.reviewHeadSha === "string"
            ? { reviewHeadSha: value.reviewHeadSha }
            : {}),
        }
      : {}),
    refresh,
    ...(refresh
      ? { previousReviewRounds: previousReviewRounds as number }
      : {}),
  };
}

export function allowedNodeTools(node: string | undefined): ReadonlySet<string> {
  if (!node) return new Set(["forge_refresh_base", "forge_verify", "forge_diff", "forge_commit", "forge_prepare_review", "forge_finalize_work_on"]);
  if (node === "review-correctness" || node === "review-security")
    return new Set(["forge_diff", "forge_finalize_reviewer"]);
  const common = ["forge_diff", "forge_finalize_node"];
  if (node === "implement") return new Set([...common, "forge_commit"]);
  if (node === "verify") return new Set([...common, "forge_verify"]);
  if (node === "prepare-pr")
    return new Set(["forge_prepare_review", "forge_finalize_node"]);
  return new Set(common);
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
      markdown: `<!-- FORGE:FAST_PATH -->\n## Legacy Routing Classification\n\n**Complexity**: NOT RECORDED\n**Task type**: NOT RECORDED\n**Rationale**: This in-flight legacy checkpoint supplied raw Markdown rather than a typed routing artifact. No classification is inferred.\n**Phases skipped**: NOT RECORDED`,
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
      markdown: `<!-- FORGE:CHECKPOINT -->\n${JSON.stringify({ phase: "BUILD", status: "COMPLETE", next_phase: "REVIEW", timestamp: event.occurredAt, commit: params.commitSha ?? null, local_verification: "COMPLETE", github_ci: "PENDING_PARENT_GATE" })}`,
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
      "<!-- FORGE:LOCAL_VERIFICATION -->",
      "<!-- FORGE:IMPLEMENTATION_READY_FOR_CI -->",
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

const READ_ONLY_NODES = new Set(["resolve", "investigate", "plan"]);

export function boundedToolDenial(
  node: string | undefined,
  toolName: string,
): string | undefined {
  if (toolName === "bash" && READ_ONLY_NODES.has(node ?? ""))
    return `Shell execution is disabled for read-only ${node} nodes; use repository read tools and supplied context.`;
  if (READ_ONLY_NODES.has(node ?? "") && (toolName === "write" || toolName === "edit"))
    return `${toolName} is not allowed for read-only ${node} nodes.`;
  return undefined;
}

function normalizeRepositoryPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function isForgeRuntimePath(
  value: string,
  caseInsensitive = false,
): boolean {
  const normalized = normalizeRepositoryPath(value);
  const path = caseInsensitive ? normalized.toLocaleLowerCase("en-US") : normalized;
  return (
    path === ".pi" ||
    path.startsWith(".pi/") ||
    path === ".forge/cache" ||
    path.startsWith(".forge/cache/") ||
    path === ".forge/worktrees" ||
    path.startsWith(".forge/worktrees/")
  );
}

export function parseGitStatusPaths(output: string): string[] {
  const records = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const path = record.length >= 3 ? record.slice(3) : record;
    if (path) paths.push(normalizeRepositoryPath(path));
    if (
      (record[0] === "R" ||
        record[0] === "C" ||
        record[1] === "R" ||
        record[1] === "C") &&
      records[index + 1]
    ) {
      paths.push(normalizeRepositoryPath(records[index + 1] as string));
      index += 1;
    }
  }
  return [...new Set(paths)];
}

export function forgeCommitArguments(
  root: string,
  hooksPath: string,
  message: string,
): string[] {
  return [
    "-C",
    root,
    "-c",
    `core.hooksPath=${hooksPath}`,
    "commit",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    message,
  ];
}

export function assertCommittedTree(input: {
  preCommitHead: string;
  actualParent: string;
  stagedTree: string;
  committedTree: string;
  stagedPaths: readonly string[];
  committedPaths: readonly string[];
  ignoreCase?: boolean;
}): void {
  if (input.actualParent !== input.preCommitHead)
    throw new Error("Committed parent changed after staged-path validation.");
  if (input.committedTree !== input.stagedTree)
    throw new Error("Committed tree differs from the validated staged tree.");
  const normalize = (path: string) => {
    const value = normalizeRepositoryPath(path);
    return input.ignoreCase ? value.toLocaleLowerCase("en-US") : value;
  };
  const staged = [...new Set(input.stagedPaths.map(normalize))].sort();
  const committed = [...new Set(input.committedPaths.map(normalize))].sort();
  if (
    staged.length !== committed.length ||
    staged.some((path, index) => path !== committed[index])
  )
    throw new Error("Committed paths differ from the validated staged paths.");
  if (committed.some((path) => isForgeRuntimePath(path, input.ignoreCase)))
    throw new Error("Committed tree contains Forge runtime paths.");
}

function nonRuntimeStatus(output: string, caseInsensitive = false): string {
  return output
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      const path = line.length > 3 ? line.slice(3).trim() : line.trim();
      return !(line.startsWith("??") && isForgeRuntimePath(path, caseInsensitive));
    })
    .join("\n")
    .trim();
}

async function checkoutIgnoresCase(
  root: string,
  runId: string,
): Promise<boolean> {
  const result = await runProcess(
    "git",
    ["-C", root, "config", "--bool", "core.ignorecase"],
    {
      cwd: root,
      timeoutMs: 30_000,
      env: safeEnvironment(runId),
    },
  );
  assertCompleteProcessOutput(result, "Git case-sensitivity detection");
  if (result.exitCode === 1 && !result.stdout.trim()) return false;
  if (result.exitCode !== 0)
    throw new Error(`Unable to read Git case-sensitivity contract: ${result.stderr}`);
  const value = result.stdout.trim();
  if (value !== "true" && value !== "false")
    throw new Error(`Invalid core.ignorecase value: ${value || "empty"}.`);
  return value === "true";
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

export function assertCompleteProcessOutput(
  result: Pick<ProcessResult, "stdoutTruncated" | "stderrTruncated">,
  operation: string,
): void {
  if (result.stdoutTruncated || result.stderrTruncated)
    throw new ForgeOutputLimitError(operation);
}

export function assertCompleteReviewDiff(
  result: Pick<ProcessResult, "stdout" | "stdoutTruncated" | "stderrTruncated">,
  maxBytes = MAX_OUTPUT_BYTES,
): void {
  assertCompleteProcessOutput(result, "Forge review diff");
  if (Buffer.byteLength(result.stdout) > maxBytes)
    throw new ForgeOutputLimitError("Forge review diff");
}

export function assertReviewerDiffCoverage(
  coverage: { headSha: string; sha256: string; bytes: number } | undefined,
  expectedHeadSha: string | undefined,
): void {
  if (
    !coverage ||
    !expectedHeadSha ||
    coverage.headSha !== expectedHeadSha ||
    !/^[a-f0-9]{64}$/.test(coverage.sha256) ||
    !Number.isSafeInteger(coverage.bytes) ||
    coverage.bytes < 0
  )
    throw new Error(
      "Reviewer finalization requires complete forge_diff coverage for the exact frozen head SHA.",
    );
}

async function gitHead(
  root: string,
  runId: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runProcess("git", ["-C", root, "rev-parse", "HEAD"], {
    cwd: root,
    timeoutMs: 30_000,
    env: safeEnvironment(runId),
    ...(signal ? { signal } : {}),
  });
  assertCompleteProcessOutput(result, "Git HEAD resolution");
  if (result.exitCode !== 0 || !result.stdout.trim())
    throw new Error(`Unable to resolve HEAD: ${result.stderr}`);
  return result.stdout.trim();
}

async function runProcess(
  program: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
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
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const next = appendBounded(stdout, chunk, MAX_OUTPUT_BYTES * 2);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk: string) => {
      const next = appendBounded(stderr, chunk, MAX_OUTPUT_BYTES * 2);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
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
      resolvePromise({
        exitCode,
        signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
      });
    });
  });
}

export function appendBounded(
  current: string,
  chunk: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const combined = current + chunk;
  return {
    value: truncateTail(combined, maxBytes),
    truncated: Buffer.byteLength(combined) > maxBytes,
  };
}

function truncateTail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return value;
  return `[output truncated to last ${maxBytes} bytes]\n${buffer.subarray(buffer.byteLength - maxBytes).toString("utf8")}`;
}
