import type { CommandExecutor } from "./git.ts";
import { runProcess, safeEnvironment } from "./verification.ts";
import { FetchGitHubTransport } from "./github-api.ts";
import { GitHubIssueProjector } from "./github-projection.ts";
import { GitHubStateBranchStore } from "./github-state.ts";
import { GitHubWorkflowAdapter } from "./github-workflow.ts";

export interface ReviewPreparationBinding {
  runId: string;
  issueNumber: number;
  repository: string;
  stateBranch: string;
  branch: string;
  baseBranch: string;
}

export interface PreparedReviewIdentity {
  pullNumber: number;
  pullUrl: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
}

export type GitHubTokenResolver = (
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * Performs the child-side review handoff. This service is intentionally limited
 * to the bound branch and review-started projections; merge and issue-close
 * authority remains in the parent workflow.
 */
export class ReviewPreparationService {
  readonly #executor: CommandExecutor;
  readonly #resolveToken: GitHubTokenResolver;

  constructor(
    executor: CommandExecutor,
    resolveToken: GitHubTokenResolver,
  ) {
    this.#executor = executor;
    this.#resolveToken = resolveToken;
  }

  async prepare(input: {
    root: string;
    binding: ReviewPreparationBinding;
    signal?: AbortSignal;
  }): Promise<PreparedReviewIdentity> {
    const { root, binding, signal } = input;
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

    const push = await this.#executor.exec(
      "git",
      ["-C", root, "push", "--set-upstream", "origin", binding.branch],
      {
        cwd: root,
        timeout: 120_000,
        ...(signal ? { signal } : {}),
      },
    );
    if (push.code !== 0)
      throw new Error(`Bound branch push failed: ${push.stderr || push.stdout}`);

    const token = await this.#resolveToken(root, signal);
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
      throw new Error("Cannot post review-started artifact without a run event.");
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
      runId: binding.runId,
      ...(signal ? { signal } : {}),
    });
    return {
      pullNumber: pull.number,
      pullUrl: pull.htmlUrl,
      headSha,
      baseSha: pull.baseSha,
      baseRef: pull.baseRef,
    };
  }
}
