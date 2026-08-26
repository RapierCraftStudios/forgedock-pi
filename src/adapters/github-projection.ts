import type { RunEvent } from "../core/events.ts";
import {
  GitHubApiError,
  type GitHubTransport,
  repositoryApiPath,
  requireGitHubSuccess,
} from "./github-api.ts";

interface IssueComment {
  id: number;
  body: string;
}

interface IssueLabel {
  name: string;
}

interface IssueResponse {
  labels: IssueLabel[];
}

export interface ProjectIssueEventInput {
  issueNumber: number;
  event: RunEvent;
  markdown: string;
  addLabels?: readonly string[];
  signal?: AbortSignal;
}

export interface ProjectionResult {
  commentId: number;
  created: boolean;
  labelsAdded: readonly string[];
}

export class GitHubIssueProjector {
  readonly #transport: GitHubTransport;
  readonly #apiRoot: string;

  constructor(transport: GitHubTransport, repository: string) {
    this.#transport = transport;
    this.#apiRoot = repositoryApiPath(repository);
  }

  async projectEvent(input: ProjectIssueEventInput): Promise<ProjectionResult> {
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1)
      throw new TypeError("Issue number must be positive.");
    const marker = `<!-- FORGEDOCK-EVENT:${input.event.eventId} -->`;
    const existing = await this.#findComment(
      input.issueNumber,
      marker,
      input.signal,
    );
    let commentId = existing?.id;
    let created = false;

    if (!commentId) {
      const path = `${this.#apiRoot}/issues/${input.issueNumber}/comments`;
      const body = `${marker}\n<!-- FORGEDOCK-RUN:${input.event.runId} -->\n${input.markdown.trim()}\n`;
      const response = await this.#transport.request<IssueComment>({
        method: "POST",
        path,
        body: { body },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const comment = requireGitHubSuccess(response, path, [201]);
      commentId = comment.id;
      created = true;
      const readBack = await this.#findComment(
        input.issueNumber,
        marker,
        input.signal,
      );
      if (!readBack || readBack.id !== commentId) {
        throw new GitHubApiError(422, path, {
          message: `Projection read-back missing ${marker}`,
        });
      }
    }

    const labelsAdded = await this.#addMissingLabels(
      input.issueNumber,
      input.addLabels ?? [],
      input.signal,
    );
    return { commentId, created, labelsAdded };
  }

  async postArtifact(input: {
    issueNumber: number;
    runId: string;
    eventId: string;
    artifactKey: string;
    markdown: string;
    signal?: AbortSignal;
  }): Promise<number> {
    if (!/^[a-z0-9-]+$/.test(input.artifactKey))
      throw new TypeError("Artifact keys must be lowercase kebab-case.");
    const marker = `<!-- FORGEDOCK-ARTIFACT:${input.eventId}:${input.artifactKey} -->`;
    const existing = await this.#findComment(
      input.issueNumber,
      marker,
      input.signal,
    );
    if (existing) return existing.id;
    const path = `${this.#apiRoot}/issues/${input.issueNumber}/comments`;
    const body = `${marker}\n<!-- FORGEDOCK-RUN:${input.runId} -->\n${input.markdown.trim()}\n`;
    const response = await this.#transport.request<IssueComment>({
      method: "POST",
      path,
      body: { body },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const comment = requireGitHubSuccess(response, path, [201]);
    const readBack = await this.#findComment(
      input.issueNumber,
      marker,
      input.signal,
    );
    if (!readBack || readBack.id !== comment.id) {
      throw new GitHubApiError(422, path, {
        message: `Artifact read-back missing ${marker}`,
      });
    }
    return comment.id;
  }

  async appendToLatestComment(input: {
    issueNumber: number;
    marker: string;
    append: string;
    skipIfContains?: string;
    signal?: AbortSignal;
  }): Promise<number> {
    const comments = await this.#listComments(input.issueNumber, input.signal);
    const target = comments
      .filter((comment) => comment.body.includes(input.marker))
      .filter(
        (comment) =>
          !input.skipIfContains || !comment.body.includes(input.skipIfContains),
      )
      .at(-1);
    if (!target)
      throw new Error(`No comment found for marker ${input.marker}.`);
    const path = `${this.#apiRoot}/issues/comments/${target.id}`;
    const body = `${target.body.trimEnd()}\n\n${input.append.trim()}\n`;
    const response = await this.#transport.request<IssueComment>({
      method: "PATCH",
      path,
      body: { body },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const updated = requireGitHubSuccess(response, path, [200]);
    if (!updated.body.includes(input.append.trim()))
      throw new GitHubApiError(422, path, {
        message: "Comment append read-back failed",
      });
    return updated.id;
  }

  async setWorkflowLabel(
    issueNumber: number,
    workflowLabel: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!workflowLabel.startsWith("workflow:"))
      throw new TypeError("Workflow labels must start with workflow:.");
    const issuePath = `${this.#apiRoot}/issues/${issueNumber}`;
    const issueResponse = await this.#transport.request<IssueResponse>({
      method: "GET",
      path: issuePath,
      ...(signal ? { signal } : {}),
    });
    const issue = requireGitHubSuccess(issueResponse, issuePath, [200]);
    const labelsPath = `${this.#apiRoot}/issues/${issueNumber}/labels`;
    const existingWorkflowLabels = issue.labels
      .map((label) => label.name)
      .filter(
        (label) =>
          label.startsWith("workflow:") && label !== workflowLabel,
      );

    for (const label of existingWorkflowLabels) {
      const labelPath = `${labelsPath}/${encodeURIComponent(label)}`;
      const response = await this.#transport.request<IssueLabel[]>({
        method: "DELETE",
        path: labelPath,
        ...(signal ? { signal } : {}),
      });
      if (response.status !== 404)
        requireGitHubSuccess(response, labelPath, [200]);
    }

    const response = await this.#transport.request<IssueLabel[]>({
      method: "POST",
      path: labelsPath,
      body: { labels: [workflowLabel] },
      ...(signal ? { signal } : {}),
    });
    requireGitHubSuccess(response, labelsPath, [200]);
  }

  async #findComment(
    issueNumber: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<IssueComment | undefined> {
    const comments = await this.#listComments(issueNumber, signal);
    return comments.find((comment) => comment.body.includes(marker));
  }

  async #listComments(
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<IssueComment[]> {
    const path = `${this.#apiRoot}/issues/${issueNumber}/comments?per_page=100`;
    const response = await this.#transport.request<IssueComment[]>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
    return requireGitHubSuccess(response, path, [200]);
  }

  async #addMissingLabels(
    issueNumber: number,
    labels: readonly string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const requested = [
      ...new Set(
        labels.filter((label) => label.trim()).map((label) => label.trim()),
      ),
    ];
    if (requested.length === 0) return [];
    const issuePath = `${this.#apiRoot}/issues/${issueNumber}`;
    const issueResponse = await this.#transport.request<IssueResponse>({
      method: "GET",
      path: issuePath,
      ...(signal ? { signal } : {}),
    });
    const issue = requireGitHubSuccess(issueResponse, issuePath, [200]);
    const current = new Set(issue.labels.map((label) => label.name));
    const missing = requested.filter((label) => !current.has(label));
    if (missing.length === 0) return [];

    const labelsPath = `${this.#apiRoot}/issues/${issueNumber}/labels`;
    const response = await this.#transport.request<IssueLabel[]>({
      method: "POST",
      path: labelsPath,
      body: { labels: missing },
      ...(signal ? { signal } : {}),
    });
    requireGitHubSuccess(response, labelsPath, [200]);
    return missing;
  }
}
