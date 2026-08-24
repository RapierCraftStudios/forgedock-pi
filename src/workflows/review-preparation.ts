import {
  FetchGitHubTransport,
  type GitHubTransport,
} from "../adapters/github-api.ts";
import { GitHubIssueProjector } from "../adapters/github-projection.ts";
import { GitHubStateBranchStore } from "../adapters/github-state.ts";
import { GitHubWorkflowAdapter } from "../adapters/github-workflow.ts";

export interface ReviewPreparationBinding {
  runId: string;
  issueNumber: number;
  repository: string;
  stateBranch: string;
  branch: string;
  baseBranch: string;
}

export interface ReviewIdentity {
  pullNumber: number;
  pullUrl: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
}

export interface ReviewPreparationInput {
  binding: ReviewPreparationBinding;
  headSha: string;
  token: string;
  signal?: AbortSignal;
}

/**
 * Owns the network-visible review identity. A PR is not considered prepared
 * until GitHub reads back the exact committed head SHA and all review-route
 * artifacts are projected idempotently.
 */
export class ReviewPreparationService {
  readonly #transportFactory: (token: string) => GitHubTransport;

  constructor(
    transportFactory: (token: string) => GitHubTransport = (token) =>
      new FetchGitHubTransport({ token }),
  ) {
    this.#transportFactory = transportFactory;
  }

  async prepare(input: ReviewPreparationInput): Promise<ReviewIdentity> {
    if (!input.headSha.trim())
      throw new TypeError("Review head SHA must be non-empty.");
    const transport = this.#transportFactory(input.token);
    const github = new GitHubWorkflowAdapter(
      transport,
      input.binding.repository,
    );
    const issue = await github.getIssue(input.binding.issueNumber, input.signal);
    const pull = await github.createPullRequest({
      title: issue.title,
      body: `## Summary\n\nImplements #${input.binding.issueNumber} through ForgeDock Pi run \`${input.binding.runId}\`.\n\n## Testing\n\nRequired checks passed before review.\n\nCloses #${input.binding.issueNumber}\n\n**Reviewed head**: \`${input.headSha}\``,
      head: input.binding.branch,
      base: input.binding.baseBranch,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (pull.headSha !== input.headSha)
      throw new Error(
        `Created PR head ${pull.headSha} does not match frozen review head ${input.headSha}.`,
      );

    const store = new GitHubStateBranchStore(
      transport,
      input.binding.repository,
      input.binding.stateBranch,
    );
    const current = await store.readRun(input.binding.runId, input.signal);
    const event = current.events.at(-1);
    if (!event)
      throw new Error("Cannot post review-started artifact without a run event.");
    const projector = new GitHubIssueProjector(
      transport,
      input.binding.repository,
    );
    await projector.postArtifact({
      issueNumber: input.binding.issueNumber,
      runId: input.binding.runId,
      eventId: event.eventId,
      artifactKey: "review-started",
      markdown: `PR #${pull.number} created targeting \`${input.binding.baseBranch}\`. The isolated review route is active for the required domains at commit \`${input.headSha}\`.\n\nReview will verify the builder contract, acceptance evidence, changed behavior, and absence of security/regression findings before merge.\n\n<!-- FORGE:REVIEW_STARTED -->`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await projector.setWorkflowLabel(
      input.binding.issueNumber,
      "workflow:in-review",
      input.signal,
    );
    await github.postPullArtifact({
      pullNumber: pull.number,
      marker: `<!-- FORGE:REVIEW_ROUTE mode=single-pr spec=review-pr.md sha=${input.headSha.slice(0, 7)} -->`,
      body: "Review domains: correctness, security.\nTarget: " +
        `${input.binding.baseBranch}.`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      pullNumber: pull.number,
      pullUrl: pull.htmlUrl,
      headSha: input.headSha,
      baseSha: pull.baseSha,
      baseRef: pull.baseRef,
    };
  }
}
