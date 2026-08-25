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

/**
 * Select exactly one next node from durable records. Review join is released only
 * when both reviewers completed at the same frozen head SHA.
 */
export function chooseNextExecutableNode(
  state: DispatcherState | RunState,
): WorkflowNodeRecord | undefined {
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
          ...(node.outcome ? { outcome: node.outcome as NodeOutcome } : {}),
          ...(node.resultPath ? { resultPath: node.resultPath } : {}),
          ...(node.subagentRunId ? { subagentRunId: node.subagentRunId } : {}),
          ...(node.publishedCommentId
            ? { publishedCommentId: node.publishedCommentId }
            : {}),
          ...(node.reason ? { reason: node.reason } : {}),
        }))
      : [];
  const latest = new Map<WorkflowNode, WorkflowNodeRecord>();
  for (const record of nodes) latest.set(record.node, record);

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
      const headSha = headForNode(nodes, node, nextRound);
      return {
        nodeId: `${node}-${nextRound}`,
        node,
        attempt: nextRound,
        round: nextRound,
        status: "queued",
        ...(headSha ? { headSha } : {}),
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
    const attempt = (record?.attempt ?? 0) + 1;
    const frozenHead = headForNode(nodes, node, attempt);
    return {
      nodeId: `${node}-${attempt}`,
      node,
      attempt,
      round: (record?.round ?? record?.attempt ?? 0) + 1,
      status: "queued",
      ...(frozenHead ? { headSha: frozenHead } : {}),
    };
  }
  return undefined;
}

function headForNode(
  records: readonly WorkflowNodeRecord[],
  node: WorkflowNode,
  attempt: number,
): string | undefined {
  const completedHead = (source: WorkflowNode, sourceAttempt?: number) =>
    [...records]
      .reverse()
      .find(
        (record) =>
          record.node === source &&
          (sourceAttempt === undefined || record.attempt === sourceAttempt) &&
          record.status === "completed" &&
          Boolean(record.headSha),
      )?.headSha;

  if (node === "verify") return completedHead("implement", attempt);
  if (node === "prepare-pr") return completedHead("verify", attempt);
  if (node === "implement" && attempt > 1)
    return completedHead("prepare-pr", attempt - 1);
  if (
    [
      "review-correctness",
      "review-security",
      "review-join",
      "ci",
      "decision",
      "merge",
      "close",
      "cleanup",
    ].includes(node)
  )
    return completedHead("prepare-pr");
  return undefined;
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
