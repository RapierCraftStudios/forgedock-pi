import type { RunState } from "./state.ts";

/** Parent-owned executable nodes. Each attempt is immutable and identified by nodeId. */
export const WORKFLOW_NODES = [
  "resolve",
  "investigate",
  "plan",
  "prepare-worktree",
  "implement",
  "verify",
  "prepare-pr",
  "review-correctness",
  "review-security",
  "review-join",
  "ci",
  "decision",
  "merge",
  "close",
  "cleanup",
] as const;

export type WorkflowNode = (typeof WORKFLOW_NODES)[number];

export type NodeOutcome =
  | "confirmed"
  | "invalid"
  | "decomposed"
  | "completed"
  | "awaiting-merge"
  | "remediation-required"
  | "merged"
  | "needs-human"
  | "failed";

export type NodeStatus =
  | "queued"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "needs-human";

export interface WorkflowNodeRecord {
  nodeId: string;
  node: WorkflowNode;
  attempt: number;
  round?: number;
  status: NodeStatus;
  headSha?: string;
  baseSha?: string;
  outcome?: NodeOutcome;
  resultPath?: string;
  subagentRunId?: string;
  publishedCommentId?: number;
  reason?: string;
}

export interface DispatcherState {
  readonly nodes: readonly WorkflowNodeRecord[];
  readonly maxReviewRounds?: number;
}

export type WorkflowDispatchDecision =
  | ({ kind: "next" } & WorkflowNodeRecord)
  | { kind: "waiting"; reason: string }
  | { kind: "blocked"; reason: string; node?: WorkflowNodeRecord }
  | { kind: "workflow-complete" };

const ORDERED_NODES: readonly WorkflowNode[] = [
  "resolve",
  "investigate",
  "plan",
  "prepare-worktree",
  "implement",
  "verify",
  "prepare-pr",
  "review-correctness",
  "review-security",
  "review-join",
  "ci",
  "decision",
  "merge",
  "close",
  "cleanup",
];

/** Distinguish executable work from durable waiting, blocking, and completion. */
export function chooseNextExecutableNode(
  state: DispatcherState | RunState,
): WorkflowDispatchDecision {
  const nodes = dispatcherNodes(state);
  const latest = latestWorkflowNodes(nodes);
  const next = findNextExecutableNode(state);
  if (next) return { kind: "next", ...next };
  const active = latest.find((node) => node.status === "queued" || node.status === "running");
  if (active)
    return {
      kind: "waiting",
      reason: `Node ${active.nodeId} is durably ${active.status}.`,
    };
  const terminal = latest.find((node) =>
    ["blocked", "failed", "needs-human"].includes(node.status),
  );
  if (terminal)
    return {
      kind: "blocked",
      node: terminal,
      reason: terminal.reason ?? `Node ${terminal.nodeId} is ${terminal.status}.`,
    };
  const reviewers = latest.filter(
    (node) =>
      (node.node === "review-correctness" || node.node === "review-security") &&
      node.status === "completed",
  );
  if (
    reviewers.length >= 2 &&
    reviewers.at(-1)?.headSha !== reviewers.at(-2)?.headSha
  )
    return { kind: "blocked", reason: "Reviewer results target different head SHAs." };
  const latestDecision = latest
    .filter((node) => node.node === "decision" && node.status === "completed")
    .sort((left, right) => right.attempt - left.attempt)[0];
  const maxReviewRounds = "maxReviewRounds" in state ? state.maxReviewRounds : undefined;
  if (
    latestDecision?.outcome === "remediation-required" &&
    maxReviewRounds !== undefined &&
    latestDecision.attempt >= maxReviewRounds
  )
    return { kind: "blocked", node: latestDecision, reason: "Review remediation rounds are exhausted." };
  if (ORDERED_NODES.every((node) => nodes.some((record) => record.node === node && record.status === "completed")))
    return { kind: "workflow-complete" };
  return { kind: "waiting", reason: "Workflow prerequisites are not yet durably satisfied." };
}

/** Ready is an explicit durable decision boundary, never the absence of local work. */
export function isAwaitingIntegrationBoundary(
  state: DispatcherState | RunState,
): boolean {
  const nodes = dispatcherNodes(state);
  const latestDecision = nodes
    .filter((node) => node.node === "decision" && node.status === "completed")
    .sort((left, right) => right.attempt - left.attempt)[0];
  return (
    latestDecision?.outcome === "awaiting-merge" &&
    !nodes.some((node) => node.status === "queued" || node.status === "running")
  );
}

function findNextExecutableNode(
  state: DispatcherState | RunState,
): WorkflowNodeRecord | undefined {
  const nodes = dispatcherNodes(state);
  const latest = new Map(
    latestWorkflowNodes(nodes).map((record) => [record.node, record]),
  );

  const decision = latest.get("decision");
  const maxReviewRounds =
    "maxReviewRounds" in state ? state.maxReviewRounds : undefined;
  if (decision?.status === "completed" && decision.outcome === "remediation-required") {
    const round = decision.round ?? decision.attempt;
    const nextRound = round + 1;
    if (
      maxReviewRounds !== undefined &&
      nextRound > maxReviewRounds
    )
      return undefined;
    const roundNodes: readonly WorkflowNode[] = [
      "implement",
      "verify",
      "prepare-pr",
      "review-correctness",
      "review-security",
      "review-join",
      "ci",
      "decision",
    ];
    for (const node of roundNodes) {
      const record = nodes.find(
        (candidate) => candidate.node === node && candidate.attempt === nextRound,
      );
      if (record && ["queued", "running"].includes(record.status))
        return undefined;
      if (record?.status === "completed") continue;
      if (record && ["blocked", "failed", "needs-human"].includes(record.status))
        return undefined;
      if (
        node === "review-join" &&
        (!latest.get("review-correctness") ||
          !latest.get("review-security") ||
          !reviewJoinReady(
            nodes.filter((candidate) => candidate.attempt === nextRound),
            latest.get("review-correctness")?.headSha ?? "",
          ))
      )
        return undefined;
      return {
        nodeId: `${node}-${nextRound}`,
        node,
        attempt: nextRound,
        round: nextRound,
        status: "queued",
        ...(latest.get("prepare-pr")?.headSha
          ? { headSha: latest.get("prepare-pr")?.headSha }
          : {}),
      };
    }
    return undefined;
  }

  const investigation = latest.get("investigate");
  if (investigation?.status === "completed") {
    if (
      investigation.outcome === "invalid" ||
      investigation.outcome === "decomposed"
    ) {
      const close = latest.get("close");
      if (!close || close.status !== "completed")
        return nextTerminalNode(latest, "close");
      return nextTerminalNode(latest, "cleanup");
    }
  }

  const correctness = latest.get("review-correctness");
  const security = latest.get("review-security");
  if (correctness?.status === "completed" && security?.status === "completed") {
    if (
      correctness.headSha &&
      security.headSha &&
      correctness.headSha !== security.headSha
    ) {
      return undefined;
    }
  }

  for (const node of ORDERED_NODES) {
    const record = latest.get(node);
    if (record && ["queued", "running"].includes(record.status))
      return undefined;
    if (record?.status === "completed") continue;
    if (record && ["blocked", "failed", "needs-human"].includes(record.status))
      return undefined;
    if (
      node === "review-join" &&
      (!correctness ||
        !security ||
        correctness.status !== "completed" ||
        security.status !== "completed" ||
        !correctness.publishedCommentId ||
        !security.publishedCommentId ||
        correctness.headSha !== security.headSha)
    )
      return undefined;
    const frozenHead =
      latest.get("prepare-pr")?.headSha ?? latest.get("verify")?.headSha;
    return {
      nodeId: `${node}-${(record?.attempt ?? 0) + 1}`,
      node,
      attempt: (record?.attempt ?? 0) + 1,
      round: (record?.round ?? record?.attempt ?? 0) + 1,
      status: "queued",
      ...(frozenHead ? { headSha: frozenHead } : {}),
    };
  }
  return undefined;
}

function dispatcherNodes(
  state: DispatcherState | RunState,
): readonly WorkflowNodeRecord[] {
  return "nodes" in state
    ? Object.values(state.nodes).map((node) => ({
        nodeId: node.nodeId,
        node: node.node as WorkflowNode,
        attempt: node.attempt,
        ...(node.round ? { round: node.round } : {}),
        status: node.status,
        ...(node.headSha ? { headSha: node.headSha } : {}),
        ...(node.baseSha ? { baseSha: node.baseSha } : {}),
        ...(node.outcome ? { outcome: node.outcome as NodeOutcome } : {}),
        ...(node.resultPath ? { resultPath: node.resultPath } : {}),
        ...(node.subagentRunId ? { subagentRunId: node.subagentRunId } : {}),
        ...(node.publishedCommentId ? { publishedCommentId: node.publishedCommentId } : {}),
        ...(node.reason ? { reason: node.reason } : {}),
      }))
    : [];
}

function latestWorkflowNodes(
  nodes: readonly WorkflowNodeRecord[],
): WorkflowNodeRecord[] {
  const latest = new Map<WorkflowNode, WorkflowNodeRecord>();
  for (const record of nodes) {
    const prior = latest.get(record.node);
    if (!prior || record.attempt >= prior.attempt) latest.set(record.node, record);
  }
  return [...latest.values()];
}

function nextTerminalNode(
  latest: Map<WorkflowNode, WorkflowNodeRecord>,
  node: WorkflowNode,
): WorkflowNodeRecord | undefined {
  const record = latest.get(node);
  if (record?.status === "completed") return undefined;
  if (
    record &&
    ["queued", "running", "blocked", "failed", "needs-human"].includes(
      record.status,
    )
  )
    return undefined;
  return {
    nodeId: `${node}-${(record?.attempt ?? 0) + 1}`,
    node,
    attempt: (record?.attempt ?? 0) + 1,
    round: (record?.round ?? record?.attempt ?? 0) + 1,
    status: "queued",
  };
}

export function chooseReadyReviewerNodes(
  state: DispatcherState | RunState,
): WorkflowNodeRecord[] {
  const nodes: readonly WorkflowNodeRecord[] =
    "nodes" in state
      ? Object.values(state.nodes).map((node) => ({
          nodeId: node.nodeId,
          node: node.node as WorkflowNode,
          attempt: node.attempt,
          ...(node.round ? { round: node.round } : {}),
          status: node.status,
          ...(node.headSha ? { headSha: node.headSha } : {}),
          ...(node.baseSha ? { baseSha: node.baseSha } : {}),
          ...(node.publishedCommentId
            ? { publishedCommentId: node.publishedCommentId }
            : {}),
        }))
      : [];
  const prepared = [...nodes]
    .reverse()
    .find(
      (record) => record.node === "prepare-pr" && record.status === "completed",
    );
  if (!prepared?.headSha) return [];
  const domains = ["review-correctness", "review-security"] as const;
  const reviewAttempt = Math.max(
    prepared.attempt,
    ...nodes
      .filter((record) => domains.includes(record.node as (typeof domains)[number]))
      .map((record) => record.attempt),
  );
  return domains.flatMap((node) => {
    const existing = [...nodes]
      .reverse()
      .find(
        (record) => record.node === node && record.attempt === reviewAttempt,
      );
    if (existing) return [];
    return [
      {
        nodeId: `${node}-${reviewAttempt}`,
        node,
        attempt: reviewAttempt,
        round: reviewAttempt,
        status: "queued" as const,
        headSha: prepared.headSha,
        ...(prepared.baseSha ? { baseSha: prepared.baseSha } : {}),
      },
    ];
  });
}

export function reviewJoinReady(
  records: readonly WorkflowNodeRecord[],
  headSha: string,
): boolean {
  const reviewers = records.filter(
    (record) =>
      record.node === "review-correctness" || record.node === "review-security",
  );
  return (
    reviewers.length === 2 &&
    reviewers.every(
      (record) =>
        record.status === "completed" &&
        record.headSha === headSha &&
        Boolean(record.publishedCommentId),
    )
  );
}

export function isTerminalOutcome(outcome: NodeOutcome | undefined): boolean {
  return (
    outcome === "invalid" ||
    outcome === "decomposed" ||
    outcome === "merged" ||
    outcome === "needs-human" ||
    outcome === "failed"
  );
}
