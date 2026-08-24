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

  await projector.setWorkflowLabel(42, "workflow:merged");
  assert.equal(transport.labels.has("workflow:investigating"), false);
  assert.equal(transport.labels.has("workflow:merged"), true);
  assert.equal(transport.labels.has("bug"), true);
});
