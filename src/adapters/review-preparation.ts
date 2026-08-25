import { GitHubIssueProjector } from "./github-projection.ts";
import { GitHubStateBranchStore } from "./github-state.ts";
import { GitHubWorkflowAdapter } from "./github-workflow.ts";
import type { GitHubTransport } from "./github-api.ts";
import {
  runProcess,
  safeEnvironment,
  type ProcessResult,
} from "./verification.ts";

export interface ReviewPreparationBinding {
  runId: string;
  repository: string;
  issueNumber: number;
  stateBranch: string;
  worktreeRoot: string;
  branch: string;
  baseBranch: string;
}

export interface ReviewPreparationResult {
  content: [{ type: "text"; text: string }];
  details: {
    pullNumber: number;
    pullUrl: string;
    headSha: string;
    baseSha: string;
    baseRef: string;
  };
}

export class ForgeReviewPreparationService {
  readonly #binding: ReviewPreparationBinding;
  readonly #transportFactory: (
    signal?: AbortSignal,
  ) => Promise<GitHubTransport>;
  readonly #push: (
    root: string,
    branch: string,
    signal?: AbortSignal,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;

  constructor(input: {
    binding: ReviewPreparationBinding;
    transportFactory: (
      signal?: AbortSignal,
    ) => Promise<GitHubTransport>;
    push: (
      root: string,
      branch: string,
      signal?: AbortSignal,
    ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  }) {
    this.#binding = input.binding;
    this.#transportFactory = input.transportFactory;
    this.#push = input.push;
  }

  async prepare(signal?: AbortSignal): Promise<ReviewPreparationResult> {
    const env = safeEnvironment(this.#binding.runId);
    const status = await runProcess(
      "git",
      ["-C", this.#binding.worktreeRoot, "status", "--porcelain"],
      {
        cwd: this.#binding.worktreeRoot,
        timeoutMs: 30_000,
        env,
        ...(signal ? { signal } : {}),
      },
    );
    assertProcessSuccess(status, "git status");
    if (status.stdout.trim()) {
      throw new Error(
        "Review preparation requires a clean committed worktree. Run forge_commit again for residual formatting or review-fix changes.",
      );
    }

    const head = await runProcess(
      "git",
      ["-C", this.#binding.worktreeRoot, "rev-parse", "HEAD"],
      {
        cwd: this.#binding.worktreeRoot,
        timeoutMs: 30_000,
        env,
        ...(signal ? { signal } : {}),
      },
    );
    assertProcessSuccess(head, "git rev-parse HEAD");
    const headSha = head.stdout.trim();
    if (!headSha) throw new Error("Unable to resolve review HEAD.");

    const push = await this.#push(
      this.#binding.worktreeRoot,
      this.#binding.branch,
      signal,
    );
    if (push.code !== 0)
      throw new Error(`Bound branch push failed: ${push.stderr || push.stdout}`);

    const transport = await this.#transportFactory(signal);
    const github = new GitHubWorkflowAdapter(
      transport,
      this.#binding.repository,
    );
    const issue = await github.getIssue(this.#binding.issueNumber, signal);
    const pull = await github.createPullRequest({
      title: issue.title,
      body: `## Summary\n\nImplements #${this.#binding.issueNumber} through ForgeDock Pi run \`${this.#binding.runId}\`.\n\n## Testing\n\nRequired checks passed before review.\n\nCloses #${this.#binding.issueNumber}\n\n**Reviewed head**: \`${headSha}\``,
      head: this.#binding.branch,
      base: this.#binding.baseBranch,
      ...(signal ? { signal } : {}),
    });
    if (pull.headSha !== headSha)
      throw new Error(
        `Created PR head ${pull.headSha} does not match frozen review head ${headSha}.`,
      );

    const store = new GitHubStateBranchStore(
      transport,
      this.#binding.repository,
      this.#binding.stateBranch,
    );
    const current = await store.readRun(this.#binding.runId, signal);
    const event = current.events.at(-1);
    if (!event)
      throw new Error("Cannot post review-started artifact without a run event.");
    const projector = new GitHubIssueProjector(
      transport,
      this.#binding.repository,
    );
    await projector.postArtifact({
      issueNumber: this.#binding.issueNumber,
      runId: this.#binding.runId,
      eventId: event.eventId,
      artifactKey: "review-started",
      markdown: `PR #${pull.number} created targeting \`${this.#binding.baseBranch}\`. The isolated review route is active for the required domains at commit \`${headSha}\`.\n\nReview will verify the builder contract, acceptance evidence, changed behavior, and absence of security/regression findings before merge.\n\n<!-- FORGE:REVIEW_STARTED -->`,
      ...(signal ? { signal } : {}),
    });
    await projector.setWorkflowLabel(
      this.#binding.issueNumber,
      "workflow:in-review",
      signal,
    );
    await github.postPullArtifact({
      pullNumber: pull.number,
      marker: `<!-- FORGE:REVIEW_ROUTE mode=single-pr spec=review-pr.md sha=${headSha.slice(0, 7)} -->`,
      body: `Review domains: correctness, security.\nTarget: ${this.#binding.baseBranch}.`,
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
  }
}

function assertProcessSuccess(result: ProcessResult, operation: string): void {
  if (result.exitCode !== 0)
    throw new Error(`${operation} failed (${String(result.exitCode)}): ${result.stderr}`);
}
