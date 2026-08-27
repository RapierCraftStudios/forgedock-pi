import assert from "node:assert/strict";
import test from "node:test";

import { GitHubIssueProjector } from "../../src/adapters/github-projection.ts";
import type {
  GitHubRequest,
  GitHubResponse,
  GitHubTransport,
} from "../../src/adapters/github-api.ts";
import { createRunEvent } from "../../src/core/events.ts";

interface Comment {
  id: number;
  body: string;
}

class ProjectionTransport implements GitHubTransport {
  readonly comments: Comment[] = [];
  readonly labels = new Set<string>(["bug"]);
  commentPosts = 0;

  async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
    let status = 200;
    let data: unknown;
    if (request.method === "GET" && request.path.includes("/comments"))
      data = this.comments;
    else if (request.method === "POST" && request.path.includes("/comments")) {
      const body = (request.body as { body: string }).body;
      const comment = { id: this.comments.length + 1, body };
      this.comments.push(comment);
      this.commentPosts += 1;
      status = 201;
      data = comment;
    } else if (
      request.method === "PATCH" &&
      request.path.includes("/issues/comments/")
    ) {
      const id = Number(request.path.split("/").at(-1));
      const comment = this.comments.find((entry) => entry.id === id);
      if (!comment) throw new Error(`Missing comment ${id}`);
      comment.body = (request.body as { body: string }).body;
      data = comment;
    } else if (
      request.method === "GET" &&
      /\/issues\/\d+$/.test(request.path)
    ) {
      data = { labels: [...this.labels].map((name) => ({ name })) };
    } else if (
      (request.method === "POST" || request.method === "PUT") &&
      request.path.endsWith("/labels")
    ) {
      const nextLabels = (request.body as { labels: string[] }).labels;
      if (request.method === "PUT") this.labels.clear();
      for (const label of nextLabels) this.labels.add(label);
      data = [...this.labels].map((name) => ({ name }));
    } else
      throw new Error(`Unexpected request ${request.method} ${request.path}`);
    return { status, data: data as T, headers: {} };
  }
}

test("issue projection is marker-idempotent and only adds missing labels", async () => {
  const transport = new ProjectionTransport();
  const projector = new GitHubIssueProjector(transport, "owner/repo");
  const event = createRunEvent({
    runId: "run-1",
    repository: "owner/repo",
    sequence: 1,
    previousEventHash: null,
    type: "run.created",
    actor: { kind: "extension", sessionId: "session-1", leaseEpoch: 0 },
    idempotencyKey: "create",
    payload: {
      issueNumber: 42,
      integrationBranch: "staging",
      protectedBranch: "main",
    },
    eventId: "event-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
  });

  const first = await projector.projectEvent({
    issueNumber: 42,
    event,
    markdown: "Run created",
    addLabels: ["bug", "workflow:investigating"],
  });
  const second = await projector.projectEvent({
    issueNumber: 42,
    event,
    markdown: "Run created",
    addLabels: ["workflow:investigating"],
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.commentId, second.commentId);
  assert.equal(transport.commentPosts, 1);
  assert.deepEqual(first.labelsAdded, ["workflow:investigating"]);
  assert.equal(transport.labels.has("workflow:investigating"), true);

  transport.labels.add("priority:P1");
  await projector.setWorkflowLabel(42, "workflow:merged");
  await projector.setWorkflowLabel(42, "workflow:merged");
  assert.equal(transport.labels.has("workflow:investigating"), false);
  assert.equal(transport.labels.has("workflow:merged"), true);
  assert.equal(transport.labels.has("bug"), true);
  assert.equal(transport.labels.has("priority:P1"), true);
});

test("workflow projection replaces stale labels across the complete lifecycle", async () => {
  const transport = new ProjectionTransport();
  transport.labels.add("priority:P1");
  transport.labels.add("customer-visible");
  transport.labels.add("workflow:stale");
  const projector = new GitHubIssueProjector(transport, "owner/repo");
  const lifecycle = [
    "workflow:investigating",
    "workflow:ready-to-build",
    "workflow:building",
    "workflow:in-review",
    "workflow:awaiting-merge",
    "workflow:merged",
  ];

  for (const workflowLabel of lifecycle) {
    await projector.setWorkflowLabel(42, workflowLabel);
    assert.deepEqual(
      [...transport.labels].filter((label) => label.startsWith("workflow:")),
      [workflowLabel],
    );
    assert.equal(transport.labels.has("bug"), true);
    assert.equal(transport.labels.has("priority:P1"), true);
    assert.equal(transport.labels.has("customer-visible"), true);
  }
});

test("logical issue artifacts are idempotent by revision and supersede older revisions", async () => {
  const transport = new ProjectionTransport();
  const projector = new GitHubIssueProjector(transport, "owner/repo");
  const first = await projector.postArtifact({
    issueNumber: 42,
    runId: "run-1",
    eventId: "head-a",
    artifactKey: "review-started",
    markdown: "Review A",
  });
  const repeated = await projector.postArtifact({
    issueNumber: 42,
    runId: "run-1",
    eventId: "head-a",
    artifactKey: "review-started",
    markdown: "Review A",
  });
  const second = await projector.postArtifact({
    issueNumber: 42,
    runId: "run-1",
    eventId: "head-b",
    artifactKey: "review-started",
    markdown: "Review B",
  });
  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.equal(transport.commentPosts, 2);
  assert.match(
    transport.comments[1]?.body ?? "",
    /FORGEDOCK-ARTIFACT-IDENTITY run=run-1 key=review-started/,
  );
  assert.match(
    transport.comments[1]?.body ?? "",
    /FORGEDOCK-SUPERSEDES comment=1/,
  );
});

test("artifact identity is scoped to the Forge run even when node revisions repeat", async () => {
  const transport = new ProjectionTransport();
  const projector = new GitHubIssueProjector(transport, "owner/repo");
  const oldRun = await projector.postArtifact({
    issueNumber: 42,
    runId: "run-old",
    eventId: "node-resolve-1",
    artifactKey: "node-resolve",
    markdown: "Old resolve",
  });
  const newRun = await projector.postArtifact({
    issueNumber: 42,
    runId: "run-new",
    eventId: "node-resolve-1",
    artifactKey: "node-resolve",
    markdown: "New resolve",
  });
  const repeated = await projector.postArtifact({
    issueNumber: 42,
    runId: "run-new",
    eventId: "node-resolve-1",
    artifactKey: "node-resolve",
    markdown: "New resolve",
  });
  assert.notEqual(oldRun, newRun);
  assert.equal(newRun, repeated);
  assert.equal(transport.commentPosts, 2);
  assert.match(transport.comments[1]?.body ?? "", /FORGEDOCK-ARTIFACT:run-new:node-resolve-1:node-resolve/);
  assert.match(transport.comments[1]?.body ?? "", /New resolve/);
});

test("comment append is idempotent when the marker is already present", async () => {
  const transport = new ProjectionTransport();
  transport.comments.push({
    id: 1,
    body: "<!-- FORGE:BUILDER -->\nImplementation\n\n<!-- FORGE:BUILDER:COMPLETE -->\n",
  });
  const projector = new GitHubIssueProjector(transport, "owner/repo");
  const id = await projector.appendToLatestComment({
    issueNumber: 42,
    marker: "<!-- FORGE:BUILDER -->",
    append: "<!-- FORGE:BUILDER:COMPLETE -->",
    skipIfContains: "<!-- FORGE:BUILDER:COMPLETE -->",
  });
  assert.equal(id, 1);
  assert.equal(
    transport.comments[0]?.body.match(/FORGE:BUILDER:COMPLETE/g)?.length,
    1,
  );
});
