import { createHash } from "node:crypto";

import {
  canonicalJson,
  type RunEvent,
} from "../core/events.ts";
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

export type GitHubProjectionEffectType = "github-comment" | "github-label";

export interface GitHubProjectionReceipt {
  effectType: GitHubProjectionEffectType;
  effectId: string;
  digest: string;
  /** GitHub's resource identifier, when the receipt represents a comment. */
  resourceId?: number;
}

function receiptDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function requireIssueNumber(issueNumber: number): void {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
    throw new TypeError("Issue number must be positive.");
}

/** Stable identity for a comment projection belonging to an event. */
export function githubCommentEffectId(input: {
  repository: string;
  issueNumber: number;
  eventId: string;
}): string {
  requireIssueNumber(input.issueNumber);
  return `github-comment:${input.repository}:${input.issueNumber}:${input.eventId}`;
}

/** Stable content digest for a comment projection. Comment IDs are excluded. */
export function githubCommentEffectDigest(input: {
  repository: string;
  issueNumber: number;
  eventId: string;
  body: string;
}): string {
  requireIssueNumber(input.issueNumber);
  return receiptDigest({
    body: input.body,
    eventId: input.eventId,
    issueNumber: input.issueNumber,
    repository: input.repository,
  });
}

export function createGitHubCommentReceipt(input: {
  repository: string;
  issueNumber: number;
  eventId: string;
  body: string;
  commentId: number;
}): GitHubProjectionReceipt {
  if (!Number.isSafeInteger(input.commentId) || input.commentId < 1)
    throw new TypeError("GitHub comment ID must be positive.");
  return {
    effectType: "github-comment",
    effectId: githubCommentEffectId(input),
    digest: githubCommentEffectDigest(input),
    resourceId: input.commentId,
  };
}

function normalizedLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))].sort();
}

/** Stable identity for an issue-label projection operation. */
export function githubLabelEffectId(input: {
  repository: string;
  issueNumber: number;
  eventId: string;
}): string {
  requireIssueNumber(input.issueNumber);
  return `github-label:${input.repository}:${input.issueNumber}:${input.eventId}`;
}

/** Stable content digest for an issue-label projection operation. */
export function githubLabelEffectDigest(input: {
  repository: string;
  issueNumber: number;
  eventId: string;
  labels: readonly string[];
}): string {
  requireIssueNumber(input.issueNumber);
  return receiptDigest({
    eventId: input.eventId,
    issueNumber: input.issueNumber,
    labels: normalizedLabels(input.labels),
    repository: input.repository,
  });
}

/** Stable identity and digest for an event's requested issue-label projection. */
export function createGitHubLabelReceipt(input: {
  repository: string;
  issueNumber: number;
  eventId: string;
  labels: readonly string[];
}): GitHubProjectionReceipt {
  return {
    effectType: "github-label",
    effectId: githubLabelEffectId(input),
    digest: githubLabelEffectDigest(input),
  };
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
  commentReceipt: GitHubProjectionReceipt;
  labelReceipt?: GitHubProjectionReceipt;
  receipts: readonly GitHubProjectionReceipt[];
}

function issueLabelName(label: IssueLabelValue): string {
  return typeof label === "string" ? label : label.name;
}

function requireIssueComment(value: unknown, path: string): IssueComment {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger((value as { id?: unknown }).id) ||
    ((value as { id: number }).id as number) < 1 ||
    typeof (value as { body?: unknown }).body !== "string"
  )
    throw new GitHubApiError(422, path, {
      message: "GitHub returned a malformed issue comment.",
    });
  return value as IssueComment;
}

export class GitHubIssueProjector {
  readonly #transport: GitHubTransport;
  readonly #apiRoot: string;
  readonly #repository: string;

  constructor(transport: GitHubTransport, repository: string) {
    this.#transport = transport;
    this.#repository = repository;
    this.#apiRoot = repositoryApiPath(repository);
  }

  /** Project/reconcile an event and expose its verified external effect receipts. */
  async projectEventWithReceipt(
    input: ProjectIssueEventInput,
  ): Promise<ProjectionResult> {
    requireIssueNumber(input.issueNumber);
    const marker = `<!-- FORGEDOCK-EVENT:${input.event.eventId} -->`;
    const body = `${marker}\n<!-- FORGEDOCK-RUN:${input.event.runId} -->\n${input.markdown.trim()}\n`;
    const path = `${this.#apiRoot}/issues/${input.issueNumber}/comments`;
    const existing = await this.#findComment(
      input.issueNumber,
      marker,
      input.signal,
    );
    if (existing) {
      const readBack = await this.#readComment(existing.id, input.signal);
      if (readBack.id !== existing.id || readBack.body !== body)
        throw new GitHubApiError(422, path, {
          message: `Projection ${marker} exists with a different payload.`,
          commentId: existing.id,
        });
    }
    let commentId = existing?.id;
    let created = false;

    if (!commentId) {
      const response = await this.#transport.request<IssueComment>({
        method: "POST",
        path,
        body: { body },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const comment = requireIssueComment(
        requireGitHubSuccess(response, path, [201]),
        path,
      );
      commentId = comment.id;
      created = true;
      const readBack = await this.#readComment(comment.id, input.signal);
      if (readBack.id !== comment.id || readBack.body !== body)
        throw new GitHubApiError(422, path, {
          message: `Projection read-back mismatch for ${marker}.`,
          commentId: comment.id,
        });
    }

    const requestedLabels = normalizedLabels(input.addLabels ?? []);
    const labelsAdded = await this.#addMissingLabels(
      input.issueNumber,
      requestedLabels,
      input.signal,
    );
    const commentReceipt = createGitHubCommentReceipt({
      repository: this.#repository,
      issueNumber: input.issueNumber,
      eventId: input.event.eventId,
      body,
      commentId,
    });
    const labelReceipt =
      requestedLabels.length > 0
        ? createGitHubLabelReceipt({
            repository: this.#repository,
            issueNumber: input.issueNumber,
            eventId: input.event.eventId,
            labels: requestedLabels,
          })
        : undefined;
    const receipts = labelReceipt
      ? [commentReceipt, labelReceipt]
      : [commentReceipt];
    return {
      commentId,
      created,
      labelsAdded,
      commentReceipt,
      ...(labelReceipt ? { labelReceipt } : {}),
      receipts,
    };
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
      const expected = `${marker}\n${identityMarker}\n${revisionMarker}\n<!-- FORGEDOCK-RUN:${input.runId} -->\n${rendered}\n`;
      const withoutSupersedes = existing.body.replace(
        /\n<!-- FORGEDOCK-SUPERSEDES comment=\d+ -->(?=\n<!-- FORGEDOCK-RUN:)/,
        "",
      );
      if (withoutSupersedes !== expected)
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
    const comment = requireIssueComment(
      requireGitHubSuccess(response, path, [201]),
      path,
    );
    const readBack = await this.#readComment(comment.id, input.signal);
    if (readBack.id !== comment.id || readBack.body !== body)
      throw new GitHubApiError(422, path, {
        message: `Artifact read-back mismatch for ${marker}.`,
        commentId: comment.id,
      });
    return comment.id;
  }

  /** Post/reconcile an artifact and expose its verified comment receipt. */
  /** Backwards-compatible alias for callers that do not persist receipts. */
  projectEvent(input: ProjectIssueEventInput): Promise<ProjectionResult> {
    return this.projectEventWithReceipt(input);
  }

  async postArtifactWithReceipt(input: {
    issueNumber: number;
    runId: string;
    eventId: string;
    artifactKey: string;
    markdown: string;
    signal?: AbortSignal;
  }): Promise<GitHubProjectionReceipt> {
    const commentId = await this.postArtifact(input);
    const comment = await this.#readComment(commentId, input.signal);
    return createGitHubCommentReceipt({
      repository: this.#repository,
      issueNumber: input.issueNumber,
      eventId: `${input.eventId}:${input.artifactKey}`,
      body: comment.body,
      commentId: comment.id,
    });
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
    const updated = requireIssueComment(
      requireGitHubSuccess(response, path, [200]),
      path,
    );
    const readBack = await this.#readComment(updated.id, input.signal);
    if (readBack.id !== updated.id || readBack.body !== body)
      throw new GitHubApiError(422, path, {
        message: "Comment append read-back failed.",
        commentId: updated.id,
      });
    return updated.id;
  }

  /** Append/reconcile a comment and expose its verified comment receipt. */
  async appendToLatestCommentWithReceipt(input: {
    issueNumber: number;
    marker: string;
    append: string;
    skipIfContains?: string;
    /** Stable journal event identity for this append transition. */
    eventId?: string;
    signal?: AbortSignal;
  }): Promise<GitHubProjectionReceipt> {
    const commentId = await this.appendToLatestComment(input);
    const comment = await this.#readComment(commentId, input.signal);
    return createGitHubCommentReceipt({
      repository: this.#repository,
      issueNumber: input.issueNumber,
      eventId:
        input.eventId ??
        `append:${input.marker}:${input.skipIfContains ?? input.append}`,
      body: comment.body,
      commentId: comment.id,
    });
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

  /** Set a workflow label and return the verified durable effect receipt. */
  async setWorkflowLabelWithReceipt(
    issueNumber: number,
    workflowLabel: string,
    signal?: AbortSignal,
    eventId?: string,
  ): Promise<GitHubProjectionReceipt> {
    if (!workflowLabel.startsWith("workflow:"))
      throw new TypeError("Workflow labels must start with workflow:.");
    return this.#replaceWorkflowLabel(
      issueNumber,
      workflowLabel,
      signal,
      eventId,
    );
  }

  async clearWorkflowLabel(
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#replaceWorkflowLabel(issueNumber, undefined, signal);
  }

  /** Clear workflow labels and return the verified durable effect receipt. */
  async clearWorkflowLabelWithReceipt(
    issueNumber: number,
    signal?: AbortSignal,
    eventId?: string,
  ): Promise<GitHubProjectionReceipt> {
    return this.#replaceWorkflowLabel(
      issueNumber,
      undefined,
      signal,
      eventId,
    );
  }

  async #replaceWorkflowLabel(
    issueNumber: number,
    workflowLabel: string | undefined,
    signal?: AbortSignal,
    eventId?: string,
  ): Promise<GitHubProjectionReceipt> {
    requireIssueNumber(issueNumber);
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

    const verifyResponse = await this.#transport.request<IssueResponse>({
      method: "GET",
      path: issuePath,
      ...(signal ? { signal } : {}),
    });
    const verifiedLabels = requireGitHubSuccess(
      verifyResponse,
      issuePath,
      [200],
    ).labels.map(issueLabelName);
    const verifiedWorkflowLabels = verifiedLabels.filter((label) =>
      label.startsWith("workflow:"),
    );
    if (
      (workflowLabel &&
        (verifiedWorkflowLabels.length !== 1 ||
          verifiedWorkflowLabels[0] !== workflowLabel)) ||
      (!workflowLabel && verifiedWorkflowLabels.length !== 0)
    )
      throw new GitHubApiError(422, labelsPath, {
        message: "Workflow label fresh read-back did not match the requested projection.",
        labels: verifiedLabels,
      });
    return createGitHubLabelReceipt({
      repository: this.#repository,
      issueNumber,
      eventId: eventId ?? `workflow:${workflowLabel ?? "clear"}`,
      labels: workflowLabel ? [workflowLabel] : [],
    });
  }

  async #findComment(
    issueNumber: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<IssueComment | undefined> {
    const comments = await this.#listComments(issueNumber, signal);
    const matching = comments.filter((comment) => comment.body.includes(marker));
    const first = matching[0];
    if (
      first &&
      matching.some((comment) => comment.body !== first.body)
    )
      throw new GitHubApiError(
        422,
        `${this.#apiRoot}/issues/${issueNumber}/comments`,
        { message: `Projection ${marker} has conflicting duplicate payloads.` },
      );
    return first;
  }

  async #listComments(
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    const seen = new Set<string>();
    let path: string | undefined =
      `${this.#apiRoot}/issues/${issueNumber}/comments?per_page=100`;
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
      const pagePath = path;
      const pageComments = requireGitHubSuccess(response, pagePath, [200]);
      if (!Array.isArray(pageComments))
        throw new GitHubApiError(422, pagePath, {
          message: "GitHub returned a malformed issue comment page.",
        });
      comments.push(
        ...pageComments.map((comment) =>
          requireIssueComment(comment, pagePath),
        ),
      );
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
    return requireIssueComment(
      requireGitHubSuccess(response, path, [200]),
      path,
    );
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
    const response = await this.#transport.request<IssueLabelValue[]>({
      method: "POST",
      path: labelsPath,
      body: { labels: missing },
      ...(signal ? { signal } : {}),
    });
    requireGitHubSuccess(response, labelsPath, [200]);

    // Verify against a fresh issue read, rather than trusting the mutation
    // response. A caller can safely retry after a crash because this read
    // proves whether the requested labels were committed.
    const verifyResponse = await this.#transport.request<IssueResponse>({
      method: "GET",
      path: issuePath,
      ...(signal ? { signal } : {}),
    });
    const verified = requireGitHubSuccess(verifyResponse, issuePath, [200]);
    const verifiedNames = new Set(verified.labels.map(issueLabelName));
    if (missing.some((label) => !verifiedNames.has(label)))
      throw new GitHubApiError(422, labelsPath, {
        message: "Label projection read-back did not contain all requested labels.",
        labels: [...verifiedNames],
      });
    return missing;
  }
}
