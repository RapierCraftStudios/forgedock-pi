import type { RunEvent } from "../core/events.ts";
import {
  GitHubApiError,
  type GitHubTransport,
  nextGitHubPagePath,
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

type IssueLabelValue = IssueLabel | string;

interface IssueResponse {
  labels: IssueLabelValue[];
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

function issueLabelName(label: IssueLabelValue): string {
  return typeof label === "string" ? label : label.name;
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
    const body = `${marker}\n<!-- FORGEDOCK-RUN:${input.event.runId} -->\n${input.markdown.trim()}\n`;
    const path = `${this.#apiRoot}/issues/${input.issueNumber}/comments`;
    const existing = await this.#findComment(
      input.issueNumber,
      marker,
      input.signal,
    );
    if (existing && existing.body !== body)
      throw new GitHubApiError(422, path, {
        message: `Projection ${marker} exists with a different payload.`,
      });
    let commentId = existing?.id;
    let created = false;

    if (!commentId) {
      const response = await this.#transport.request<IssueComment>({
        method: "POST",
        path,
        body: { body },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const comment = requireGitHubSuccess(response, path, [201]);
      commentId = comment.id;
      created = true;
      const readBack = await this.#readComment(comment.id, input.signal);
      if (readBack.id !== comment.id || readBack.body !== body)
        throw new GitHubApiError(422, path, {
          message: `Projection read-back mismatch for ${marker}.`,
          commentId: comment.id,
        });
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
    const marker = `<!-- FORGEDOCK-ARTIFACT:${input.runId}:${input.eventId}:${input.artifactKey} -->`;
    const identityMarker = `<!-- FORGEDOCK-ARTIFACT-IDENTITY run=${input.runId} key=${input.artifactKey} -->`;
    const revisionMarker = `<!-- FORGEDOCK-ARTIFACT-REVISION revision=${input.eventId} -->`;
    const rendered = input.markdown.trim();
    const comments = await this.#listComments(input.issueNumber, input.signal);
    const existing = comments.find(
      (comment) =>
        comment.body.includes(marker) &&
        comment.body.includes(identityMarker) &&
        comment.body.includes(revisionMarker),
    );
    if (existing) {
      if (!existing.body.includes(rendered))
        throw new GitHubApiError(
          422,
          `${this.#apiRoot}/issues/${input.issueNumber}/comments`,
          {
            message: `Artifact ${marker} exists with a different rendered payload.`,
          },
        );
      return existing.id;
    }
    const prior = comments
      .filter(
        (comment) =>
          comment.body.includes(identityMarker) ||
          comment.body.includes(`:${input.artifactKey} -->`),
      )
      .at(-1);
    const supersedes = prior
      ? `\n<!-- FORGEDOCK-SUPERSEDES comment=${prior.id} -->`
      : "";
    const path = `${this.#apiRoot}/issues/${input.issueNumber}/comments`;
    const body = `${marker}\n${identityMarker}\n${revisionMarker}${supersedes}\n<!-- FORGEDOCK-RUN:${input.runId} -->\n${rendered}\n`;
    const response = await this.#transport.request<IssueComment>({
      method: "POST",
      path,
      body: { body },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const comment = requireGitHubSuccess(response, path, [201]);
    const readBack = await this.#readComment(comment.id, input.signal);
    if (readBack.id !== comment.id || readBack.body !== body)
      throw new GitHubApiError(422, path, {
        message: `Artifact read-back mismatch for ${marker}.`,
        commentId: comment.id,
      });
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
    const matching = comments.filter((comment) =>
      comment.body.includes(input.marker),
    );
    if (input.skipIfContains) {
      const alreadyUpdated = matching.find((comment) =>
        comment.body.includes(input.skipIfContains as string),
      );
      if (alreadyUpdated) return alreadyUpdated.id;
    }
    const target = matching.at(-1);
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
    const readBack = await this.#readComment(updated.id, input.signal);
    if (readBack.body !== body)
      throw new GitHubApiError(422, path, {
        message: "Comment append read-back failed.",
        commentId: updated.id,
      });
    return updated.id;
  }

  async setWorkflowLabel(
    issueNumber: number,
    workflowLabel: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
      throw new TypeError("Issue number must be positive.");
    if (!workflowLabel.startsWith("workflow:"))
      throw new TypeError("Workflow labels must start with workflow:.");
    await this.#replaceWorkflowLabel(issueNumber, workflowLabel, signal);
  }

  async clearWorkflowLabel(
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#replaceWorkflowLabel(issueNumber, undefined, signal);
  }

  async #replaceWorkflowLabel(
    issueNumber: number,
    workflowLabel: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const issuePath = `${this.#apiRoot}/issues/${issueNumber}`;
    const issueResponse = await this.#transport.request<IssueResponse>({
      method: "GET",
      path: issuePath,
      ...(signal ? { signal } : {}),
    });
    const issue = requireGitHubSuccess(issueResponse, issuePath, [200]);
    const labels = issue.labels
      .map(issueLabelName)
      .filter(
        (label) => !label.startsWith("workflow:") && label !== "needs-human",
      );
    if (workflowLabel) labels.push(workflowLabel);
    const labelsPath = `${this.#apiRoot}/issues/${issueNumber}/labels`;
    const response = await this.#transport.request<IssueLabelValue[]>({
      method: "PUT",
      path: labelsPath,
      body: { labels },
      ...(signal ? { signal } : {}),
    });
    const updated = requireGitHubSuccess(response, labelsPath, [200]);
    const updatedLabels = updated.map(issueLabelName);
    const workflowLabels = updatedLabels.filter((label) =>
      label.startsWith("workflow:"),
    );
    if (workflowLabel) {
      if (workflowLabels.length !== 1 || workflowLabels[0] !== workflowLabel)
        throw new GitHubApiError(422, labelsPath, {
          message: `Workflow label read-back expected only ${workflowLabel}.`,
          labels: updatedLabels,
        });
    } else if (workflowLabels.length !== 0)
      throw new GitHubApiError(422, labelsPath, {
        message: "Workflow label read-back expected no workflow labels.",
        labels: updatedLabels,
      });
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
    const comments: IssueComment[] = [];
    const seen = new Set<string>();
    let path: string | undefined =
      `${this.#apiRoot}/issues/${issueNumber}/comments?per_page=100&cache_bust=${Date.now()}`;
    for (let page = 0; path && page < 100; page += 1) {
      if (seen.has(path))
        throw new GitHubApiError(422, path, {
          message: "GitHub comment pagination repeated a page.",
        });
      seen.add(path);
      const response = await this.#transport.request<IssueComment[]>({
        method: "GET",
        path,
        ...(signal ? { signal } : {}),
      });
      comments.push(...requireGitHubSuccess(response, path, [200]));
      path = nextGitHubPagePath(response.headers);
    }
    if (path)
      throw new GitHubApiError(422, path, {
        message: "GitHub comment pagination exceeded 100 pages.",
      });
    return comments;
  }

  async #readComment(
    commentId: number,
    signal?: AbortSignal,
  ): Promise<IssueComment> {
    const path = `${this.#apiRoot}/issues/comments/${commentId}`;
    const response = await this.#transport.request<IssueComment>({
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
    const current = new Set(issue.labels.map(issueLabelName));
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
