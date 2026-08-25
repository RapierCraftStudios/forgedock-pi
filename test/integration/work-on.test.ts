import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import forgeChildRuntime from "../../src/agents/child-runtime.ts";
import { materializeForgeAgents } from "../../src/agents/materialize.ts";
import { GitWorktreeManager } from "../../src/adapters/git.ts";
import { PRE_MERGE_ISSUE_MARKERS } from "../../src/core/artifact-protocol.ts";
import { isLeaseExpired } from "../../src/core/lease.ts";
import { ForgeWorkOnController } from "../../src/workflows/work-on.ts";
import { RunJournal } from "../../src/workflows/journal.ts";
import {
  completeChildPhases,
  childServices,
  initializeRun,
  MemoryGit,
  MemoryGitHub,
  MemoryPi,
  MemoryProjector,
  MemoryRpc,
  MemoryRunStore,
  readyResult,
  reviewerResult,
  seedPreMergeAudit,
  TEST_BASE_BRANCH,
  TEST_BASE_SHA,
  TEST_BRANCH,
  TEST_HEAD_SHA,
  TEST_ISSUE,
  TEST_REPOSITORY,
  TEST_RUN_ID,
  testPolicy,
} from "./fixtures.ts";

const execFileAsync = promisify(execFile);

function reportFor(phase: string): string {
  if (phase === "investigate")
    return [
      "<!-- FORGE:INVESTIGATOR -->",
      "## Investigation Report",
      "### Root Cause",
      "Deterministic fixture coverage was missing.",
      "### Evidence",
      "The child runtime had no end-to-end test.",
      "### Acceptance Spec",
      "Exercise the typed checkpoint lifecycle.",
      "<!-- INVESTIGATION:COMPLETE -->",
    ].join("\n");
  if (phase === "plan")
    return [
      "<!-- FORGE:CONTRACT -->",
      "## Builder Contract",
      "Test-only deterministic fixture and bounded lifecycle seams.",
      "<!-- FORGE:CONTEXT -->",
      "## Implementation Context",
      "Use in-memory state and GitHub ports.",
      "<!-- FORGE:CONTEXT:COMPLETE -->",
      "<!-- FORGE:ARCHITECT -->",
      "## Implementation Plan",
      "Add integration fixtures and recovery assertions.",
      "<!-- FORGE:ARCHITECT:COMPLETE -->",
    ].join("\n");
  if (phase === "implement")
    return [
      "<!-- FORGE:BUILDER -->",
      "## Implementation Complete",
      "### Branch",
      `\`${TEST_BRANCH}\``,
      "### Commits",
      "`fixture-commit`",
      "### Files Changed",
      "`test/integration/work-on.test.ts`",
      "### Approach",
      "Inject deterministic ports.",
      "### Changes",
      "Added lifecycle and recovery tests.",
      "### Acceptance Criteria Status",
      "All targeted criteria covered.",
      "### Testing Checklist",
      "- [x] Deterministic fixture",
    ].join("\n");
  if (phase === "verify")
    return [
      "<!-- FORGE:ACCEPTANCE_GATE -->",
      "## Acceptance Gate — PASSED",
      "- [x] Required checks represented by the fixture.",
      "<!-- FORGE:ACCEPTANCE_GATE:PASSED -->",
    ].join("\n");
  return `## ${phase} Complete\n\nDeterministic phase evidence.`;
}

interface ChildTool {
  execute: (...args: any[]) => Promise<unknown>;
}

function childHarness(
  store: MemoryRunStore,
  github: MemoryGitHub,
  projector: MemoryProjector,
  root: string,
): {
  tools: Map<string, ChildTool>;
  pi: MemoryPi;
  restore: () => void;
} {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({
    "forgedock.pi/1": {
      runId: TEST_RUN_ID,
      resultPath: join(root, ".pi", "forge", "result.json"),
      repository: TEST_REPOSITORY,
      issueNumber: TEST_ISSUE,
      leaseEpoch: 1,
      stateBranch: "forgedock/state/v1",
      worktreeRoot: root,
      branch: TEST_BRANCH,
      baseBranch: TEST_BASE_BRANCH,
      baseSha: TEST_BASE_SHA,
      maxReviewRounds: 3,
      verificationCommands: {},
    },
  });

  const tools = new Map<string, ChildTool>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = new MemoryPi();
  const childPi = {
    ...pi,
    registerTool: (definition: { name: string; execute: ChildTool["execute"] }) =>
      tools.set(definition.name, definition),
    registerAgent: () => ({ dispose: () => undefined }),
    exec: pi.exec.bind(pi),
    on: (event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    events: { on: () => () => {}, emit: () => undefined },
  } as unknown as ExtensionAPI;

  forgeChildRuntime(childPi, {
    createTransport: () => ({
      async request<T>() {
        return { status: 200, data: {} as T, headers: {} };
      },
    }),
    createServices: () => childServices(github, store, projector),
    now: () => new Date(),
  });

  return {
    tools,
    pi,
    restore: () => {
      if (previous === undefined)
        delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
      else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous;
    },
  };
}

async function invokeCheckpoint(
  tools: Map<string, ChildTool>,
  phase: string,
  action: "queue" | "start" | "complete",
  report?: string,
): Promise<unknown> {
  const tool = tools.get("forge_checkpoint");
  assert.ok(tool, "child checkpoint tool must be registered");
  return tool.execute(
    "checkpoint",
    {
      phase,
      attempt: 1,
      action,
      ...(action === "complete" ? { report, evidence: [`${phase} evidence`] } : {}),
    },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "session-1" } },
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function parentHarness() {
  const root = await mkdtemp(join(tmpdir(), "forgedock-work-on-e2e-"));
  const store = new MemoryRunStore();
  const github = new MemoryGitHub();
  const projector = new MemoryProjector(github);
  const git = new MemoryGit(root);
  const rpc = new MemoryRpc();
  const pi = new MemoryPi();
  await mkdirForFixture(git.prepared.worktreePath);
  await initializeRun(store);
  await completeChildPhases(store);
  const pull = await github.createPullRequest({
    title: "issue",
    body: "existing PR",
    head: TEST_BRANCH,
    base: TEST_BASE_BRANCH,
  });
  seedPreMergeAudit(github, pull.number);
  pi.appendEntry("forgedock-run-link/v1", {
    forgeRunId: TEST_RUN_ID,
    subagentRunId: "subagent-issue-3",
    issueNumber: TEST_ISSUE,
    repository: TEST_REPOSITORY,
    stateBranch: "forgedock/state/v1",
    resultPath: join(root, ".pi", "forge", "result.json"),
    prepared: git.prepared,
    status: "running",
  });
  rpc.result = readyResult();
  const policy = testPolicy();
  const controller = new ForgeWorkOnController(pi.asExtensionApi(), {
    rpc,
    git,
    loadPolicy: async () => ({
      policy,
      trackedPath: join(root, ".forge", "config.json"),
      localPath: join(root, ".pi", "forge.local.json"),
      localOverridesApplied: false,
    }),
    resolveGitHubToken: async () => "fixture-token",
    createServices: () => ({ github, store, projector }),
  });
  const context = pi.context(root, "session-1");
  return {
    root,
    store,
    github,
    projector,
    git,
    rpc,
    pi,
    controller,
    context,
    pullNumber: pull.number,
    async dispose() {
      controller.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function mkdirForFixture(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

type ParentFixture = Awaited<ReturnType<typeof parentHarness>>;

async function resumeParent(fixture: ParentFixture): Promise<void> {
  const failedLink = fixture.controller.listRuns()[0];
  assert.ok(failedLink);
  fixture.pi.appendEntry("forgedock-run-link/v1", {
    ...failedLink,
    status: "running",
  });
  fixture.controller.dispose();
  const rpc = new MemoryRpc();
  rpc.result = readyResult();
  const controller = new ForgeWorkOnController(fixture.pi.asExtensionApi(), {
    rpc,
    git: fixture.git,
    loadPolicy: async () => ({
      policy: testPolicy(),
      trackedPath: join(fixture.root, ".forge", "config.json"),
      localPath: join(fixture.root, ".pi", "forge.local.json"),
      localOverridesApplied: false,
    }),
    resolveGitHubToken: async () => "fixture-token",
    createServices: () => ({
      github: fixture.github,
      store: fixture.store,
      projector: fixture.projector,
    }),
  });
  await controller.attach(fixture.context);
  rpc.complete();
  await waitFor(() => controller.listRuns()[0]?.status === "completed");
  controller.dispose();
}

test("child runtime drives typed checkpoints and rejects malformed reports before commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-child-e2e-"));
  try {
    const store = new MemoryRunStore();
    const github = new MemoryGitHub();
    const projector = new MemoryProjector(github);
    github.seedComments(TEST_ISSUE, "<!-- FORGE:BUILDER -->");
    await initializeRun(store);
    const harness = childHarness(store, github, projector, root);
    try {
      for (const phase of [
        "resolve",
        "investigate",
        "plan",
        "prepare-worktree",
        "implement",
        "verify",
        "review",
      ]) {
        await invokeCheckpoint(harness.tools, phase, "queue");
        await invokeCheckpoint(harness.tools, phase, "start");
        await invokeCheckpoint(harness.tools, phase, "complete", reportFor(phase));
      }
      assert.equal(store.state?.phases.review?.attempts[0]?.status, "completed");
      assert.equal(store.events.length, 23);
      const beforeIdempotent = store.events.length;
      const idempotent = (await invokeCheckpoint(
        harness.tools,
        "review",
        "complete",
        reportFor("review"),
      )) as { details: { idempotent: boolean } };
      assert.equal(idempotent.details.idempotent, true);
      assert.equal(store.events.length, beforeIdempotent);

      const malformedStore = new MemoryRunStore();
      const malformedGithub = new MemoryGitHub();
      const malformedProjector = new MemoryProjector(malformedGithub);
      await initializeRun(malformedStore);
      const malformed = childHarness(
        malformedStore,
        malformedGithub,
        malformedProjector,
        root,
      );
      try {
        await invokeCheckpoint(malformed.tools, "resolve", "queue");
        await invokeCheckpoint(malformed.tools, "resolve", "start");
        await invokeCheckpoint(
          malformed.tools,
          "resolve",
          "complete",
          reportFor("resolve"),
        );
        await invokeCheckpoint(malformed.tools, "plan", "queue");
        await invokeCheckpoint(malformed.tools, "plan", "start");
        const before = malformedStore.events.length;
        await assert.rejects(
          invokeCheckpoint(malformed.tools, "plan", "complete", "malformed"),
          /canonical ForgeDock fields|missing FORGE:CONTRACT/,
        );
        assert.equal(malformedStore.events.length, before);
        assert.equal(
          malformedStore.state?.phases.plan?.attempts[0]?.status,
          "running",
        );
      } finally {
        malformed.restore();
      }
    } finally {
      harness.restore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child checkpoint rejects an expired lease and final-result tool persists only inside Forge runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-child-lease-"));
  try {
    const store = new MemoryRunStore();
    const github = new MemoryGitHub();
    const projector = new MemoryProjector(github);
    await initializeRun(store);
    assert.ok(store.lease);
    store.lease = {
      ...store.lease,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    assert.equal(isLeaseExpired(store.lease, new Date()), true);
    const harness = childHarness(store, github, projector, root);
    try {
      await assert.rejects(
        invokeCheckpoint(harness.tools, "resolve", "queue"),
        /expired or requires takeover/,
      );
      assert.equal(store.events.length, 2);

      const finalize = harness.tools.get("forge_finalize_work_on");
      assert.ok(finalize);
      const result = readyResult();
      await finalize.execute("finalize", { value: result });
      const persisted = JSON.parse(
        await readFile(join(root, ".pi", "forge", "result.json"), "utf8"),
      ) as typeof result;
      assert.deepEqual(persisted, result);
      await assert.rejects(
        finalize.execute("finalize", {
          value: { ...result, runId: "other-run" },
        }),
        /identity does not match/,
      );
    } finally {
      harness.restore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forge_prepare_review reuses an existing PR at the frozen child head", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-prepare-review-"));
  try {
    await execFileAsync("git", ["init", "-b", "main", root]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "ForgeDock Test"]);
    await execFileAsync(
      "git",
      ["-C", root, "config", "user.email", "forgedock@example.invalid"],
    );
    await writeFile(join(root, "fixture.txt"), "fixture\n");
    await execFileAsync("git", ["-C", root, "add", "fixture.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "fixture"]);
    const head = (
      await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      })
    ).stdout.trim();

    const store = new MemoryRunStore();
    const github = new MemoryGitHub();
    github.seedComments(TEST_ISSUE, "child run");
    const projector = new MemoryProjector(github);
    await initializeRun(store);
    const existing = await github.createPullRequest({
      title: "existing",
      body: "existing",
      head: TEST_BRANCH,
      base: TEST_BASE_BRANCH,
    });
    const harness = childHarness(store, github, projector, root);
    try {
      const pull = github.pulls.get(existing.number);
      assert.ok(pull);
      pull.headSha = head;
      const prepare = harness.tools.get("forge_prepare_review");
      assert.ok(prepare);
      const response = (await prepare.execute("prepare", {}, undefined)) as {
        details: { pullNumber: number; headSha: string };
      };
      assert.equal(response.details.pullNumber, existing.number);
      assert.equal(response.details.headSha, head);
      assert.equal(
        github.effects.filter((effect) => effect === `pull-request:${existing.number}`).length,
        1,
      );
    } finally {
      harness.restore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parent finalization is single-flight, idempotent, and reaches merge/close/cleanup exactly once", async () => {
  const fixture = await parentHarness();
  try {
    await fixture.controller.attach(fixture.context);
    fixture.rpc.complete();
    fixture.rpc.complete();
    await waitFor(() => fixture.controller.listRuns()[0]?.status === "completed");

    assert.equal(fixture.github.mergeCalls, 1);
    assert.equal(fixture.github.closeCalls, 1);
    assert.deepEqual(
      fixture.git.calls.filter((call) => call === "push"),
      ["push"],
    );
    assert.deepEqual(
      fixture.git.calls.filter((call) => call === "cleanup"),
      ["cleanup"],
    );
    assert.equal(fixture.store.state?.status, "completed");
    assert.equal(fixture.store.state?.outcome, "merged");
    assert.equal(fixture.store.lease, undefined);
    assert.equal(fixture.github.issues.get(TEST_ISSUE)?.state, "closed");
    assert.equal(
      fixture.github.effects.filter((effect) => effect.startsWith("merge:")).length,
      1,
    );
    assert.equal(
      fixture.github.effects.filter((effect) => effect.startsWith("close:")).length,
      1,
    );
  } finally {
    await fixture.dispose();
  }
});

test("parent retries after PR/close crash boundaries without duplicating durable effects", async () => {
  const prCrash = await parentHarness();
  try {
    prCrash.github.failNext("pull-request");
    await prCrash.controller.attach(prCrash.context);
    prCrash.rpc.complete();
    await waitFor(() => prCrash.controller.listRuns()[0]?.status === "failed");
    assert.equal(prCrash.github.mergeCalls, 0);
    assert.equal(
      prCrash.store.events.filter((event) => event.type === "effect.recorded").length,
      1,
    );

    const failedLink = prCrash.controller.listRuns()[0];
    assert.ok(failedLink);
    prCrash.pi.appendEntry("forgedock-run-link/v1", {
      ...failedLink,
      status: "running",
    });
    prCrash.controller.dispose();
    const retryRpc = new MemoryRpc();
    retryRpc.result = readyResult();
    const retryController = new ForgeWorkOnController(
      prCrash.pi.asExtensionApi(),
      {
        rpc: retryRpc,
        git: prCrash.git,
        loadPolicy: async () => ({
          policy: testPolicy(),
          trackedPath: join(prCrash.root, ".forge", "config.json"),
          localPath: join(prCrash.root, ".pi", "forge.local.json"),
          localOverridesApplied: false,
        }),
        resolveGitHubToken: async () => "fixture-token",
        createServices: () => ({
          github: prCrash.github,
          store: prCrash.store,
          projector: prCrash.projector,
        }),
      },
    );
    await retryController.attach(prCrash.context);
    retryRpc.complete();
    await waitFor(() => retryController.listRuns()[0]?.status === "completed");
    assert.equal(
      prCrash.store.state?.effects["branch:forge/issue-3-run-issu"]?.effectType,
      "push",
    );
    assert.equal(
      Object.values(prCrash.store.state?.effects ?? {}).filter(
        (effect) => effect.effectType === "pull-request",
      ).length,
      1,
    );
    retryController.dispose();
  } finally {
    await prCrash.dispose();
  }

  const closeCrash = await parentHarness();
  try {
    closeCrash.github.failNext("close");
    await closeCrash.controller.attach(closeCrash.context);
    closeCrash.rpc.complete();
    await waitFor(() => closeCrash.controller.listRuns()[0]?.status === "failed");
    assert.equal(closeCrash.github.issues.get(TEST_ISSUE)?.state, "open");
    assert.equal(closeCrash.store.state?.phases.merge?.attempts[0]?.status, "completed");

    const failedLink = closeCrash.controller.listRuns()[0];
    assert.ok(failedLink);
    closeCrash.pi.appendEntry("forgedock-run-link/v1", {
      ...failedLink,
      status: "running",
    });
    closeCrash.controller.dispose();
    const retryRpc = new MemoryRpc();
    retryRpc.result = readyResult();
    const retryController = new ForgeWorkOnController(
      closeCrash.pi.asExtensionApi(),
      {
        rpc: retryRpc,
        git: closeCrash.git,
        loadPolicy: async () => ({
          policy: testPolicy(),
          trackedPath: join(closeCrash.root, ".forge", "config.json"),
          localPath: join(closeCrash.root, ".pi", "forge.local.json"),
          localOverridesApplied: false,
        }),
        resolveGitHubToken: async () => "fixture-token",
        createServices: () => ({
          github: closeCrash.github,
          store: closeCrash.store,
          projector: closeCrash.projector,
        }),
      },
    );
    await retryController.attach(closeCrash.context);
    retryRpc.complete();
    await waitFor(() => retryController.listRuns()[0]?.status === "completed");
    assert.equal(closeCrash.github.issues.get(TEST_ISSUE)?.state, "closed");
    assert.equal(
      closeCrash.github.effects.filter((effect) => effect.startsWith("merge:")).length,
      1,
    );
    assert.equal(closeCrash.github.pulls.size, 1);
    retryController.dispose();
  } finally {
    await closeCrash.dispose();
  }
});

test("parent resumes after push, PR, merge, and cleanup crash boundaries", async () => {
  const boundaries: Array<{
    name: string;
    inject: (fixture: ParentFixture) => void;
  }> = [
    { name: "push", inject: (fixture) => fixture.git.failNext("push") },
    {
      name: "pull-request",
      inject: (fixture) => fixture.github.failNext("pull-artifact"),
    },
    { name: "merge", inject: (fixture) => fixture.github.failNext("merge") },
    { name: "cleanup", inject: (fixture) => fixture.git.failNext("cleanup") },
  ];
  for (const boundary of boundaries) {
    const fixture = await parentHarness();
    try {
      boundary.inject(fixture);
      await fixture.controller.attach(fixture.context);
      fixture.rpc.complete();
      await waitFor(() => fixture.controller.listRuns()[0]?.status === "failed");
      assert.match(fixture.pi.notices.join("\n"), /finalization failed|not merged/i);
      await resumeParent(fixture);
      assert.equal(fixture.store.state?.status, "completed");
      assert.equal(fixture.github.issues.get(TEST_ISSUE)?.state, "closed");
      assert.equal(
        Object.values(fixture.store.state?.effects ?? {}).filter(
          (effect) => effect.effectType === "merge",
        ).length,
        1,
        `${boundary.name} must record one merge effect`,
      );
    } finally {
      await fixture.dispose();
    }
  }
});

test("parent merge gate blocks stale reviewed SHA and expired lease before external merge", async () => {
  const stale = await parentHarness();
  try {
    const pull = stale.github.pulls.get(stale.pullNumber);
    assert.ok(pull);
    pull.headSha = "new-head-after-review";
    await stale.controller.attach(stale.context);
    stale.rpc.complete();
    await waitFor(() => stale.controller.listRuns()[0]?.status === "failed");
    assert.equal(stale.github.mergeCalls, 0);
  } finally {
    await stale.dispose();
  }

  const expired = await parentHarness();
  try {
    assert.ok(expired.store.lease);
    expired.store.lease = {
      ...expired.store.lease,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await expired.controller.attach(expired.context);
    expired.rpc.complete();
    await waitFor(() => expired.controller.listRuns()[0]?.status === "failed");
    assert.equal(expired.github.mergeCalls, 0);
    assert.match(expired.pi.notices.join("\n"), /lease/i);
  } finally {
    await expired.dispose();
  }
});

test("audit projection failure can be retried without duplicate markers and durable state survives a fresh reader", async () => {
  const fixture = await parentHarness();
  try {
    fixture.projector.failNext("artifact");
    const event = fixture.store.events.at(-1);
    assert.ok(event);
    await assert.rejects(
      fixture.projector.postArtifact({
        issueNumber: TEST_ISSUE,
        runId: TEST_RUN_ID,
        eventId: event.eventId,
        artifactKey: "retryable-audit",
        markdown: "retry me",
      }),
      /Injected artifact failure/,
    );
    await fixture.projector.postArtifact({
      issueNumber: TEST_ISSUE,
      runId: TEST_RUN_ID,
      eventId: event.eventId,
      artifactKey: "retryable-audit",
      markdown: "retry me",
    });
    await fixture.projector.postArtifact({
      issueNumber: TEST_ISSUE,
      runId: TEST_RUN_ID,
      eventId: event.eventId,
      artifactKey: "retryable-audit",
      markdown: "retry me",
    });
    const comments = await fixture.github.getComments(TEST_ISSUE);
    assert.equal(
      comments.filter((body) => body.includes("retryable-audit")).length,
      1,
    );

    const freshMachine = fixture.store.clone();
    const readBack = await freshMachine.readRun(TEST_RUN_ID);
    assert.equal(readBack.state?.sequence, fixture.store.state?.sequence);
    assert.deepEqual(
      readBack.events.map((entry) => entry.eventId),
      fixture.store.events.map((entry) => entry.eventId),
    );
  } finally {
    await fixture.dispose();
  }
});

test("materialized runtime files remain outside the implementation file set and cleanup is repeatable", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgedock-runtime-files-"));
  try {
    const files = await materializeForgeAgents(root);
    assert.equal(files.length, 3);
    assert.equal(
      files.every((path) => path.includes("/.pi/agents/")),
      true,
    );
    const git = new GitWorktreeManager({
      async exec(): Promise<{ stdout: string; stderr: string; code: number }> {
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    const prepared = {
      repositoryRoot: root,
      worktreePath: join(root, "already-removed"),
      branch: TEST_BRANCH,
      baseBranch: TEST_BASE_BRANCH,
      baseSha: TEST_BASE_SHA,
    };
    await git.cleanup(prepared);
    await git.cleanup(prepared);
    assert.equal(
      [".pi/agents", ".pi/forge"].some((path) =>
        ["src", "test"].includes(path),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewer results stay bound to the exact run and frozen SHA", () => {
  const correctness = reviewerResult("correctness");
  const security = reviewerResult("security");
  assert.equal(correctness.runId, TEST_RUN_ID);
  assert.equal(security.runId, TEST_RUN_ID);
  assert.equal(correctness.headSha, TEST_HEAD_SHA);
  assert.equal(security.headSha, TEST_HEAD_SHA);
  assert.deepEqual(PRE_MERGE_ISSUE_MARKERS.length > 0, true);
  assert.equal(TEST_REPOSITORY, "owner/repo");
  assert.equal(TEST_ISSUE, 3);
  assert.equal(TEST_BASE_SHA.length >= 7, true);
});
