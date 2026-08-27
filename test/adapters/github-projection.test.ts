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
      request.method === "POST" &&
      request.path.endsWith("/labels")
    ) {
      const nextLabels = (request.body as { labels: string[] }).labels;
      for (const label of nextLabels) this.labels.add(label);
      data = [...this.labels].map((name) => ({ name }));
    } else if (
      request.method === "DELETE" &&
      /\/labels\/[^/]+$/.test(request.path)
    ) {
      const label = decodeURIComponent(request.path.split("/").at(-1) ?? "");
      if (!this.labels.delete(label)) status = 404;
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
  assert.equal(first.commentReceipt.effectType, "github-comment");
  assert.equal(first.commentReceipt.effectId, second.commentReceipt.effectId);
  assert.equal(first.commentReceipt.digest, second.commentReceipt.digest);
  assert.equal(first.labelReceipt?.effectType, "github-label");
  assert.notEqual(first.labelReceipt?.digest, undefined);
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

test("workflow label transitions preserve unrelated labels added during mutation", async () => {
  const transport = new ProjectionTransport();
  transport.labels.add("workflow:building");
  const request = transport.request.bind(transport);
  let injected = false;
  transport.request = async function <T>(input: GitHubRequest) {
    if (!injected && input.method === "POST" && input.path.endsWith("/labels")) {
      injected = true;
      transport.labels.add("team:concurrently-added");
    }
    return request<T>(input);
  };

  await new GitHubIssueProjector(transport, "owner/repo").setWorkflowLabel(
    42,
    "workflow:in-review",
  );

  assert.equal(transport.labels.has("workflow:building"), false);
  assert.equal(transport.labels.has("workflow:in-review"), true);
  assert.equal(transport.labels.has("team:concurrently-added"), true);
});

test("workflow labels reject invalid issue numbers before transport access", async () => {
  const transport = new ProjectionTransport();
  const request = transport.request.bind(transport);
  let requestCount = 0;
  transport.request = async function <T>(input: GitHubRequest) {
    requestCount += 1;
    return request<T>(input);
  };
  const projector = new GitHubIssueProjector(transport, "owner/repo");
  const invalidIssueNumbers: unknown[] = [
    "42/labels?per_page=100",
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];

  for (const issueNumber of invalidIssueNumbers)
    await assert.rejects(
      () =>
        projector.setWorkflowLabel(
          issueNumber as number,
          "workflow:in-review",
        ),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message === "Issue number must be positive.",
    );

  assert.equal(requestCount, 0);
});

test("concurrent projection of the same event posts one comment", async () => {
  const transport = new ProjectionTransport();
  const request = transport.request.bind(transport);
  transport.request = async function <T>(input: GitHubRequest) {
    if (input.method === "POST" && input.path.includes("/comments"))
      await new Promise((resolve) => setTimeout(resolve, 10));
    return request<T>(input);
  };
  const event = createRunEvent({
    runId: "run-concurrent",
    repository: "owner/repo",
    sequence: 1,
    previousEventHash: null,
    type: "run.created",
    actor: { kind: "extension", sessionId: "session-1", leaseEpoch: 0 },
    idempotencyKey: "create-concurrent",
    payload: {
      issueNumber: 42,
      integrationBranch: "staging",
      protectedBranch: "main",
    },
    eventId: "event-concurrent",
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
  const first = new GitHubIssueProjector(transport, "owner/repo");
  const second = new GitHubIssueProjector(transport, "owner/repo");

  const results = await Promise.all([
    first.projectEvent({ issueNumber: 42, event, markdown: "One effect" }),
    second.projectEvent({ issueNumber: 42, event, markdown: "One effect" }),
  ]);

  assert.equal(transport.commentPosts, 1);
  assert.equal(results[0]?.commentId, results[1]?.commentId);
});

test("concurrent projection of the same artifact posts one comment", async () => {
  const transport = new ProjectionTransport();
  const request = transport.request.bind(transport);
  transport.request = async function <T>(input: GitHubRequest) {
    if (input.method === "POST" && input.path.includes("/comments"))
      await new Promise((resolve) => setTimeout(resolve, 10));
    return request<T>(input);
  };
  const first = new GitHubIssueProjector(transport, "owner/repo");
  const second = new GitHubIssueProjector(transport, "owner/repo");
  const artifact = {
    issueNumber: 42,
    runId: "run-concurrent-artifact",
    eventId: "head-a",
    artifactKey: "review-started",
    markdown: "One artifact effect",
  } as const;

  const ids = await Promise.all([
    first.postArtifact(artifact),
    second.postArtifact(artifact),
  ]);

  assert.equal(transport.commentPosts, 1);
  assert.equal(ids[0], ids[1]);
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

test("event marker lookup paginates beyond the first 100 comments", async () => {
  const transport = new ProjectionTransport();
  for (let id = 1; id <= 100; id += 1)
    transport.comments.push({ id, body: `Historical comment ${id}` });
  transport.comments.push({
    id: 101,
    body: "<!-- FORGEDOCK-EVENT:event-page-two -->\n<!-- FORGEDOCK-RUN:run-page-two -->\nExisting\n",
  });
  const projector = new GitHubIssueProjector(transport, "owner/repo");
  const event = createRunEvent({
    runId: "run-page-two",
    repository: "owner/repo",
    sequence: 1,
    previousEventHash: null,
    type: "run.created",
    actor: { kind: "extension", sessionId: "session-1", leaseEpoch: 0 },
    idempotencyKey: "create-page-two",
    payload: {
      issueNumber: 42,
      integrationBranch: "staging",
      protectedBranch: "main",
    },
    eventId: "event-page-two",
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
  const result = await projector.projectEvent({
    issueNumber: 42,
    event,
    markdown: "Existing",
  });
  assert.equal(result.commentId, 101);
  assert.equal(result.created, false);
  assert.equal(result.commentReceipt.resourceId, 101);
  assert.equal(result.receipts.length, 1);
});

test("projection reconciles a committed comment after a crash before readback", async () => {
  const transport = new ProjectionTransport();
  let failReadback = true;
  const request = transport.request.bind(transport);
  transport.request = async function <T>(requestInput: GitHubRequest) {
    if (
      failReadback &&
      requestInput.method === "GET" &&
      /\/issues\/comments\/\d+$/.test(requestInput.path)
    ) {
      failReadback = false;
      throw new Error("simulated crash after GitHub commit");
    }
    return request<T>(requestInput);
  };
  const projector = new GitHubIssueProjector(transport, "owner/repo");
  const event = createRunEvent({
    runId: "run-crash",
    repository: "owner/repo",
    sequence: 1,
    previousEventHash: null,
    type: "run.created",
    actor: { kind: "extension", sessionId: "session-1", leaseEpoch: 0 },
    idempotencyKey: "create-crash",
    payload: {
      issueNumber: 42,
      integrationBranch: "staging",
      protectedBranch: "main",
    },
    eventId: "event-crash",
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
  await assert.rejects(() =>
    projector.projectEvent({ issueNumber: 42, event, markdown: "Crash safe" }),
  );
  const recovered = await projector.projectEvent({
    issueNumber: 42,
    event,
    markdown: "Crash safe",
  });
  assert.equal(recovered.created, false);
  assert.equal(recovered.commentId, 1);
  assert.equal(transport.commentPosts, 1);
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
