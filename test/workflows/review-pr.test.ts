import assert from "node:assert/strict";
import test from "node:test";

import type {
  GitHubPullRequestRouteSnapshot,
  GitHubWorkflowAdapter,
} from "../../src/adapters/github-workflow.ts";
import type {
  AppendReviewEventInput,
  InitializeReviewInput,
  ReviewJournalSnapshot,
  ReviewJournal,
} from "../../src/adapters/review-journal.ts";
import type {
  GitWorktreeManager,
  PreparedReviewWorktree,
} from "../../src/adapters/git.ts";
import type { ForgeReviewerResult } from "../../src/agents/contracts.ts";
import {
  applyReviewEvent,
  createReviewEvent,
  type ReviewCreatedPayload,
  type ReviewEvent,
  type ReviewState,
} from "../../src/core/review-state.ts";
import {
  ReviewPrCoordinator,
  type ReviewPanelRunInput,
  type ReviewPanelRunner,
  type ReviewPrRequest,
} from "../../src/workflows/review-pr.ts";

const route: GitHubPullRequestRouteSnapshot = {
  pullNumber: 7,
  headRef: "feature/review",
  headSha: "head-sha",
  baseRef: "main",
  baseSha: "base-sha",
};

const roster = {
  version: "roster-v1",
  reviewers: ["forge-review-security"],
} as const;

class InMemoryReviewJournal {
  state: ReviewState | undefined;
  readonly events: ReviewEvent[] = [];

  async initialize(input: InitializeReviewInput): Promise<ReviewJournalSnapshot> {
    if (this.state) return this.snapshot();
    const pullNumber = input.pullNumber ?? input.pullRequest;
    if (pullNumber === undefined) throw new Error("test pull number is required");
    const payload: ReviewCreatedPayload = {
      pullNumber,
      ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
      mode: input.mode,
      headRef: input.headRef,
      headSha: input.headSha,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      roster: input.roster,
      ...(input.route === undefined ? {} : { route: input.route }),
    };
    const event = createReviewEvent({
      reviewId: input.reviewId,
      repository: input.repository,
      sequence: 1,
      previousEventHash: null,
      type: "review.created",
      idempotencyKey: "review:create",
      payload,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    this.events.push(event);
    this.state = applyReviewEvent(undefined, event);
    return this.snapshot();
  }

  async read(
    _reviewId: string,
    _signal?: AbortSignal,
  ): Promise<ReviewJournalSnapshot | undefined> {
    return this.state === undefined ? undefined : this.snapshot();
  }

  async append(input: AppendReviewEventInput): Promise<ReviewJournalSnapshot> {
    if (!this.state) throw new Error("test review has not been initialized");
    const event = createReviewEvent({
      reviewId: input.reviewId,
      repository: this.state.repository,
      sequence: this.state.sequence + 1,
      previousEventHash: this.state.lastEventHash,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      occurredAt: new Date(
        Date.parse(this.state.updatedAt) + this.state.sequence,
      ).toISOString(),
    });
    this.events.push(event);
    this.state = applyReviewEvent(this.state, event);
    return this.snapshot();
  }

  private snapshot(): ReviewJournalSnapshot {
    if (!this.state) throw new Error("test review has not been initialized");
    return {
      tip: `tip-${this.state.sequence}`,
      events: [...this.events],
      state: this.state,
      snapshotMatchesJournal: true,
    };
  }
}

class GitHubFake {
  currentRoute: GitHubPullRequestRouteSnapshot;
  readonly driftAfterFirstValidation?: Partial<GitHubPullRequestRouteSnapshot>;
  readonly artifacts: Array<{ marker: string; body: string }> = [];
  readonly issues: Array<{
    number: number;
    title: string;
    body: string;
    state: "open";
    labels: readonly string[];
  }> = [];
  readonly mergeInputs: unknown[] = [];
  merged = false;
  failMerge = false;
  revalidateCalls = 0;

  constructor(
    initialRoute: GitHubPullRequestRouteSnapshot = route,
    driftAfterFirstValidation?: Partial<GitHubPullRequestRouteSnapshot>,
  ) {
    this.currentRoute = { ...initialRoute };
    this.driftAfterFirstValidation = driftAfterFirstValidation;
  }

  async getPullRequestRouteSnapshot(): Promise<GitHubPullRequestRouteSnapshot> {
    return { ...this.currentRoute };
  }

  async revalidatePullRequestRoute(
    expected: GitHubPullRequestRouteSnapshot,
  ) {
    this.revalidateCalls += 1;
    if (this.revalidateCalls === 2 && this.driftAfterFirstValidation) {
      this.currentRoute = {
        ...this.currentRoute,
        ...this.driftAfterFirstValidation,
      };
    }
    if (!sameRoute(expected, this.currentRoute))
      throw new Error("Pull request route changed after review.");
    return {
      number: this.currentRoute.pullNumber,
      htmlUrl: "https://example.test/pulls/7",
      state: "open" as const,
      merged: false,
      headSha: this.currentRoute.headSha,
      baseSha: this.currentRoute.baseSha,
      headRef: this.currentRoute.headRef,
      baseRef: this.currentRoute.baseRef,
      mergeability: "mergeable" as const,
    };
  }

  async getPullRequest() {
    return {
      number: this.currentRoute.pullNumber,
      htmlUrl: "https://example.test/pulls/7",
      state: "open" as const,
      merged: this.merged,
      headSha: this.currentRoute.headSha,
      baseSha: this.currentRoute.baseSha,
      headRef: this.currentRoute.headRef,
      baseRef: this.currentRoute.baseRef,
      mergeability: "mergeable" as const,
    };
  }

  async waitForPullRequestChecks(input: { headSha: string }) {
    assert.equal(input.headSha, route.headSha);
    return {
      headSha: input.headSha,
      checks: [
        { name: "ci", required: true, status: "passed" as const },
      ],
      requiredContexts: ["ci"],
      configuredWorkflowCount: 1,
      timedOut: false,
    };
  }

  async postPullArtifact(input: { marker: string; body: string }) {
    this.artifacts.push({ marker: input.marker, body: input.body });
    return this.artifacts.length;
  }

  async listIssuesByLabel() {
    return this.issues.map((issue) => ({ ...issue }));
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: readonly string[];
  }) {
    const issue = {
      number: this.issues.length + 100,
      title: input.title,
      body: input.body,
      state: "open" as const,
      labels: input.labels,
    };
    this.issues.push(issue);
    return issue;
  }

  async mergePullRequest(input: unknown) {
    this.mergeInputs.push(input);
    if (this.failMerge) throw new Error("simulated merge transport failure");
    return { merged: true, sha: "merge-sha", message: "Merged" };
  }
}

class GitFake {
  headSha = route.headSha;
  readonly prepared: PreparedReviewWorktree[] = [];
  readonly cleaned: PreparedReviewWorktree[] = [];

  async prepareReview(
    repositoryRoot: string,
    input: {
      reviewId: string;
      headRef: string;
      headSha: string;
      baseRef: string;
      baseSha: string;
    },
  ): Promise<PreparedReviewWorktree> {
    const prepared: PreparedReviewWorktree = {
      repositoryRoot,
      worktreePath: `${repositoryRoot}/.forge/reviews/${input.reviewId}`,
      headRef: input.headRef,
      headSha: input.headSha,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
    };
    this.prepared.push(prepared);
    return prepared;
  }

  async head(_worktreePath: string): Promise<string> {
    return this.headSha;
  }

  async cleanupReview(prepared: PreparedReviewWorktree): Promise<void> {
    this.cleaned.push(prepared);
  }
}

class PanelFake implements ReviewPanelRunner {
  readonly results: readonly ForgeReviewerResult[];
  readonly inputs: ReviewPanelRunInput[] = [];

  constructor(results: readonly ForgeReviewerResult[]) {
    this.results = results;
  }

  async run(input: ReviewPanelRunInput): Promise<readonly ForgeReviewerResult[]> {
    this.inputs.push(input);
    return this.results;
  }
}

function reviewerResult(
  reviewer: string = roster.reviewers[0],
  findings: ForgeReviewerResult["findings"] = [],
): ForgeReviewerResult {
  return {
    schema: "forgedock.reviewer-result/v1",
    runId: "review-1",
    reviewer,
    headSha: route.headSha,
    verdict: findings.length > 0 ? "findings" : "pass",
    findings,
    filesReviewed: ["src/example.ts"],
    limitations: [],
  };
}

function finding(reviewer: string = roster.reviewers[0]) {
  return {
    id: "SEC-001",
    reviewer,
    runId: "review-1",
    headSha: route.headSha,
    confidence: "possible" as const,
    severity: "low" as const,
    category: "security" as const,
    file: "src/example.ts",
    line: 12,
    summary: "Review-only follow-up finding",
    evidence: ["Evidence from the focused review."],
  };
}

function request(
  overrides: Partial<ReviewPrRequest> = {},
): ReviewPrRequest {
  return {
    reviewId: "review-1",
    repository: "owner/repo",
    pullNumber: route.pullNumber,
    route,
    roster,
    execution: { kind: "standalone", repositoryRoot: "/repo" },
    reviewerTimeoutMs: 100,
    githubCheckTimeoutMs: 100,
    githubCheckPollIntervalMs: 0,
    githubChecksRequired: true,
    protectedBranches: [],
    autoMergeAuthorized: true,
    autoMergeRequested: false,
    authorityValid: () => true,
    ...overrides,
  };
}

function harness(options: {
  results?: readonly ForgeReviewerResult[];
  drift?: Partial<GitHubPullRequestRouteSnapshot>;
} = {}) {
  const github = new GitHubFake(route, options.drift);
  const journal = new InMemoryReviewJournal();
  const git = new GitFake();
  const panel = new PanelFake(options.results ?? [reviewerResult()]);
  const coordinator = new ReviewPrCoordinator({
    github: github as unknown as GitHubWorkflowAdapter,
    journal: journal as unknown as ReviewJournal,
    git: git as unknown as GitWorktreeManager,
    panel,
    materializeAgents: async () => [],
  });
  return { coordinator, github, journal, git, panel };
}

function gateArtifacts(h: ReturnType<typeof harness>) {
  return h.github.artifacts.filter((artifact) =>
    artifact.marker.includes("FORGE:GATE_"),
  );
}

function sameRoute(
  left: GitHubPullRequestRouteSnapshot,
  right: GitHubPullRequestRouteSnapshot,
): boolean {
  return (
    left.pullNumber === right.pullNumber &&
    left.headRef === right.headRef &&
    left.headSha === right.headSha &&
    left.baseRef === right.baseRef &&
    left.baseSha === right.baseSha
  );
}

test("clean standalone review posts route, reviewer, and summary and completes review-only", async () => {
  const reviewFinding = finding();
  const h = harness({ results: [reviewerResult(undefined, [reviewFinding])] });

  const result = await h.coordinator.review(request());

  assert.equal(result.merged, false);
  assert.equal(result.state.status, "completed");
  assert.equal(result.state.completion?.outcome, "reviewed");
  assert.equal(result.decision.decision, "approved-with-follow-ups");
  assert.deepEqual(result.findingIssues, { "SEC-001": 100 });
  assert.deepEqual(
    h.journal.events.map((event) => event.type),
    [
      "review.created",
      "review.panel-started",
      "review.check-recorded",
      "review.findings-recorded",
      "review.check-recorded",
      "review.check-recorded",
      "review.panel-completed",
      "review.verdict-recorded",
      "review.gate-recorded",
      "review.completed",
    ],
  );
  assert.equal(
    h.journal.events.filter((event) => event.type === "review.check-recorded")
      .length,
    3,
  );
  assert.equal(
    h.journal.events.find((event) => event.type === "review.findings-recorded")
      ?.payload &&
      (h.journal.events.find((event) => event.type === "review.findings-recorded")
        ?.payload as { findings: readonly unknown[] }).findings.length,
    1,
  );
  assert.equal(
    (h.journal.events.find((event) => event.type === "review.gate-recorded")
      ?.payload as { passed: boolean }).passed,
    true,
  );
  assert.equal(h.github.mergeInputs.length, 0);
  assert.equal(h.github.artifacts.length, 4);
  assert.match(h.github.artifacts[0]?.marker ?? "", /FORGE:REVIEW_ROUTE/);
  assert.match(h.github.artifacts[1]?.marker ?? "", /FORGE:REVIEW_AGENT/);
  assert.match(h.github.artifacts[1]?.body ?? "", /forge-review-security/);
  assert.match(h.github.artifacts[2]?.marker ?? "", /REVIEW_FINDING_ISSUES/);
  assert.match(h.github.artifacts[3]?.marker ?? "", /FORGE:REVIEW_SUMMARY/);
});

test("exact route drift fails closed before verdict or completion", async () => {
  const h = harness({ drift: { baseRef: "staging" } });

  await assert.rejects(
    h.coordinator.review(request()),
    /route changed after review/i,
  );
  assert.equal(h.github.revalidateCalls, 2);
  assert.equal(
    h.journal.events.some((event) => event.type === "review.verdict-recorded"),
    false,
  );
  assert.equal(
    h.journal.events.some((event) => event.type === "review.completed"),
    false,
  );
  assert.equal(h.git.cleaned.length, 1);
});

test("automatic merge requires both an explicit request and authorization", async () => {
  const notRequested = harness();
  await notRequested.coordinator.review(
    request({ autoMergeRequested: false, autoMergeAuthorized: true }),
  );
  assert.equal(notRequested.github.mergeInputs.length, 0);

  const unauthorized = harness();
  await unauthorized.coordinator.review(
    request({ autoMergeRequested: true, autoMergeAuthorized: false }),
  );
  assert.equal(unauthorized.github.mergeInputs.length, 0);
  assert.equal(unauthorized.journal.events.at(-1)?.type, "review.completed");
  assert.equal(unauthorized.journal.events.at(-1)?.payload &&
    (unauthorized.journal.events.at(-1)?.payload as { outcome: string }).outcome,
    "reviewed",
  );

  const authorized = harness();
  const result = await authorized.coordinator.review(
    request({ autoMergeRequested: true, autoMergeAuthorized: true }),
  );
  assert.equal(authorized.github.mergeInputs.length, 1);
  assert.equal(result.merged, true);
  assert.equal(result.mergeSha, "merge-sha");
  assert.equal(authorized.journal.events.at(-1)?.type, "review.completed");
  assert.equal(
    (authorized.journal.events.at(-1)?.payload as { outcome: string }).outcome,
    "merged",
  );
});

test("resume reconciles an already-merged PR before stale route rejection", async () => {
  const h = harness();
  h.github.failMerge = true;
  await assert.rejects(
    h.coordinator.review(request({ autoMergeRequested: true })),
    /simulated merge transport failure/,
  );
  assert.equal(h.journal.state?.mergeAuthorization?.authorized, true);

  h.github.failMerge = false;
  h.github.merged = true;
  h.github.currentRoute = { ...h.github.currentRoute, baseSha: "new-base-sha" };
  const result = await h.coordinator.review(
    request({ autoMergeRequested: true, resume: true }),
  );
  assert.equal(result.state.status, "completed");
  assert.equal(result.state.completion?.outcome, "merged");
  assert.equal(
    h.journal.events.filter((event) => event.type === "review.completed").length,
    1,
  );
  assert.equal(h.github.revalidateCalls, 3);
});

test("standard route review honors an explicit auto-merge request", async () => {
  const h = harness();

  const result = await h.coordinator.review(
    request({ mode: "standard", autoMergeRequested: true }),
  );

  assert.equal(result.state.mode, "standard");
  assert.equal(result.merged, true);
  assert.equal(h.github.mergeInputs.length, 1);
});

test("staging review rejects merge requests and never calls merge", async () => {
  const h = harness();

  await assert.rejects(
    h.coordinator.review(request({ mode: "staging", autoMergeRequested: true })),
    /staging review cannot merge/i,
  );
  assert.equal(h.github.mergeInputs.length, 0);
  assert.equal(h.journal.events.length, 0);
});

test("clean staging review posts exactly one gate pass and never merges", async () => {
  const h = harness();

  const result = await h.coordinator.review(
    request({ mode: "staging", autoMergeRequested: false }),
  );

  assert.equal(result.decision.decision, "approved");
  assert.equal(result.merged, false);
  assert.equal(h.github.mergeInputs.length, 0);
  assert.deepEqual(
    gateArtifacts(h).map((artifact) => artifact.marker),
    [`<!-- FORGE:GATE_PASS id=review-1 head=${route.headSha} -->`],
  );
});

test("any current staging finding posts exactly one gate failure", async () => {
  const h = harness({ results: [reviewerResult(undefined, [finding()])] });

  const result = await h.coordinator.review(
    request({ mode: "staging", autoMergeRequested: false }),
  );

  assert.equal(result.decision.decision, "changes-requested");
  assert.equal(result.merged, false);
  assert.equal(h.github.mergeInputs.length, 0);
  assert.deepEqual(
    gateArtifacts(h).map((artifact) => artifact.marker),
    [`<!-- FORGE:GATE_FAILURE id=review-1 head=${route.headSha} -->`],
  );
});

test("an unresolved prior finding for the same PR forces staging failure", async () => {
  const h = harness();
  h.github.issues.push({
    number: 101,
    title: "fix: prior review finding",
    body: "<!-- FORGE:REVIEW_FINDING source-pr=7 finding=SEC-000 head=old-head -->",
    state: "open",
    labels: ["review-finding"],
  });

  const result = await h.coordinator.review(
    request({ mode: "staging", autoMergeRequested: false }),
  );

  assert.equal(result.decision.decision, "changes-requested");
  assert.match(result.decision.reasons.join("\n"), /#101/);
  assert.deepEqual(
    gateArtifacts(h).map((artifact) => artifact.marker),
    [`<!-- FORGE:GATE_FAILURE id=review-1 head=${route.headSha} -->`],
  );
  assert.equal(h.github.mergeInputs.length, 0);
});

test("a protected main staging route can pass because staging never merges", async () => {
  const h = harness();

  const result = await h.coordinator.review(
    request({
      mode: "staging",
      protectedBranches: ["main"],
      autoMergeRequested: false,
    }),
  );

  assert.equal(result.route.baseRef, "main");
  assert.equal(result.decision.decision, "approved");
  assert.equal(result.merged, false);
  assert.equal(h.github.mergeInputs.length, 0);
  assert.equal(gateArtifacts(h).length, 1);
  assert.match(gateArtifacts(h)[0]?.marker ?? "", /FORGE:GATE_PASS/);
});

test("retrying a completed staging review does not duplicate gate markers", async () => {
  const h = harness();
  const stagingRequest = request({ mode: "staging", autoMergeRequested: false });

  await h.coordinator.review(stagingRequest);
  const eventCount = h.journal.events.length;
  const result = await h.coordinator.review(stagingRequest);

  assert.equal(result.state.status, "completed");
  assert.equal(result.merged, false);
  assert.equal(h.journal.events.length, eventCount);
  assert.deepEqual(
    gateArtifacts(h).map((artifact) => artifact.marker),
    [`<!-- FORGE:GATE_PASS id=review-1 head=${route.headSha} -->`],
  );
  assert.equal(h.github.mergeInputs.length, 0);
});

test("incomplete reviewer panel fails closed without recording findings", async () => {
  const h = harness({ results: [] });

  await assert.rejects(
    h.coordinator.review(request()),
    /incomplete roster/i,
  );
  assert.equal(
    h.journal.events.some((event) => event.type === "review.findings-recorded"),
    false,
  );
  assert.equal(h.journal.events.some((event) => event.type === "review.completed"), false);
  assert.equal(h.git.cleaned.length, 1);
});

test("malformed reviewer identity fails closed without publishing reviewer output", async () => {
  const h = harness({ results: [reviewerResult("reviewer-not-in-roster")] });

  await assert.rejects(
    h.coordinator.review(request()),
    /not in the frozen roster/i,
  );
  assert.equal(
    h.github.artifacts.some((artifact) => artifact.marker.includes("FORGE:REVIEW_AGENT")),
    false,
  );
  assert.equal(
    h.journal.events.some((event) => event.type === "review.findings-recorded"),
    false,
  );
  assert.equal(h.git.cleaned.length, 1);
});

test("only a standalone-owned worktree is cleaned by the coordinator", async () => {
  const standalone = harness();
  await standalone.coordinator.review(
    request({ execution: { kind: "standalone", repositoryRoot: "/repo" } }),
  );
  assert.equal(standalone.git.prepared.length, 1);
  assert.equal(standalone.git.cleaned.length, 1);
  assert.deepEqual(standalone.git.cleaned[0], standalone.git.prepared[0]);

  const workOn = harness();
  await workOn.coordinator.review(
    request({ execution: { kind: "work-on", worktreePath: "/existing/worktree" } }),
  );
  assert.equal(workOn.git.prepared.length, 0);
  assert.equal(workOn.git.cleaned.length, 0);
});
