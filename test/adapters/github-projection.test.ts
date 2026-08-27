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
    let headers: Record<string, string> = {};
    const exactComment = request.path.match(/\/issues\/comments\/(\d+)$/);
    if (request.method === "GET" && exactComment) {
      data = this.comments.find(
        (entry) => entry.id === Number(exactComment[1]),
      );
      if (!data) status = 404;
    } else if (request.method === "GET" && request.path.includes("/comments")) {
      const url = new URL(request.path, "https://api.github.com");
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * 100;
      data = this.comments.slice(start, start + 100);
      if (start + 100 < this.comments.length)
        headers = {
          link: `<https://api.github.com${url.pathname}?per_page=100&page=${page + 1}>; rel="next"`,
        };
    } else if (
      request.method === "POST" &&
      request.path.includes("/comments")
    ) {
      const body = (request.body as { body: string }).body;
      const nextId = Math.max(0, ...this.comments.map((entry) => entry.id)) + 1;
      const comment = { id: nextId, body };
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
    return { status, data: data as T, headers };
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

  transport.labels.add("needs-human");
  await projector.clearWorkflowLabel(42);
  assert.equal(transport.labels.has("workflow:merged"), false);
  assert.equal(transport.labels.has("needs-human"), false);
  assert.equal(transport.labels.has("bug"), true);
  assert.equal(transport.labels.has("priority:P1"), true);
});

test("workflow label transitions replace stale state while preserving unrelated labels", async () => {
  const transport = new ProjectionTransport();
  transport.labels.add("priority:P1");
  const projector = new GitHubIssueProjector(transport, "owner/repo");
  const lifecycle = [
    "workflow:investigating",
    "workflow:ready-to-build",
    "workflow:building",
    "workflow:in-review",
    "workflow:awaiting-merge",
    "workflow:merged",
  ];
  for (const label of lifecycle) {
    await projector.setWorkflowLabel(42, label);
    assert.deepEqual(
      [...transport.labels].filter((entry) => entry.startsWith("workflow:")),
      [label],
    );
    assert.equal(transport.labels.has("bug"), true);
    assert.equal(transport.labels.has("priority:P1"), true);
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
  assert.match(
    transport.comments[1]?.body ?? "",
    /FORGEDOCK-ARTIFACT:run-new:node-resolve-1:node-resolve/,
  );
  assert.match(transport.comments[1]?.body ?? "", /New resolve/);
});

test("artifact projection paginates and reads back the exact created comment", async () => {
  const transport = new ProjectionTransport();
  for (let id = 1; id <= 100; id += 1)
    transport.comments.push({ id, body: `Historical comment ${id}` });
  const projector = new GitHubIssueProjector(transport, "owner/repo");

  const created = await projector.postArtifact({
    issueNumber: 42,
    runId: "run-page-two",
    eventId: "plan-1",
    artifactKey: "architecture-plan",
    markdown: "Typed architecture plan",
  });
  const repeated = await projector.postArtifact({
    issueNumber: 42,
    runId: "run-page-two",
    eventId: "plan-1",
    artifactKey: "architecture-plan",
    markdown: "Typed architecture plan",
  });

  assert.equal(created, 101);
  assert.equal(repeated, created);
  assert.equal(transport.commentPosts, 1);
  assert.equal(transport.comments.length, 101);
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
