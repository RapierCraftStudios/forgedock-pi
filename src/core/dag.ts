export interface DagNode {
  id: string;
  priority: number;
}

export type DagEdgeKind =
  | "explicit"
  | "file"
  | "symbol"
  | "contract"
  | "resource";

export interface DagEdge {
  from: string;
  to: string;
  kind: DagEdgeKind;
  reason: string;
}

export interface Dag {
  nodes: ReadonlyMap<string, DagNode>;
  outgoing: ReadonlyMap<string, readonly DagEdge[]>;
  incoming: ReadonlyMap<string, readonly DagEdge[]>;
}

export interface DagCycle {
  nodeIds: readonly string[];
}

export interface ReadyQueueInput {
  completed: ReadonlySet<string>;
  active: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
  limit: number;
}

export class DagValidationError extends Error {
  readonly code:
    | "duplicate-node"
    | "unknown-node"
    | "self-edge"
    | "invalid-limit";

  constructor(code: DagValidationError["code"], message: string) {
    super(message);
    this.name = "DagValidationError";
    this.code = code;
  }
}

export function buildDag(
  nodes: readonly DagNode[],
  edges: readonly DagEdge[],
): Dag {
  const nodeMap = new Map<string, DagNode>();
  for (const node of nodes) {
    if (!node.id.trim())
      throw new DagValidationError(
        "unknown-node",
        "DAG node IDs must be non-empty.",
      );
    if (nodeMap.has(node.id))
      throw new DagValidationError(
        "duplicate-node",
        `Duplicate DAG node: ${node.id}.`,
      );
    nodeMap.set(node.id, { ...node });
  }

  const outgoing = new Map<string, DagEdge[]>();
  const incoming = new Map<string, DagEdge[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }

  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) {
      throw new DagValidationError(
        "unknown-node",
        `Edge ${edge.from} -> ${edge.to} references an unknown node.`,
      );
    }
    if (edge.from === edge.to)
      throw new DagValidationError(
        "self-edge",
        `Self-edge is not allowed for ${edge.from}.`,
      );
    const identity = `${edge.from}\0${edge.to}\0${edge.kind}`;
    if (seenEdges.has(identity)) continue;
    seenEdges.add(identity);
    outgoing.get(edge.from)?.push({ ...edge });
    incoming.get(edge.to)?.push({ ...edge });
  }

  return { nodes: nodeMap, outgoing, incoming };
}

export function findDagCycle(dag: Dag): DagCycle | undefined {
  // A DFS returns the cycle itself rather than every node left behind by a
  // failed topological reduction (which would also include downstream nodes).
  const colors = new Map<string, "unvisited" | "visiting" | "visited">();
  const stack: string[] = [];
  for (const nodeId of dag.nodes.keys()) colors.set(nodeId, "unvisited");

  const visit = (nodeId: string): DagCycle | undefined => {
    colors.set(nodeId, "visiting");
    stack.push(nodeId);
    for (const edge of dag.outgoing.get(nodeId) ?? []) {
      const color = colors.get(edge.to);
      if (color === "visiting") {
        const start = stack.indexOf(edge.to);
        return { nodeIds: stack.slice(start) };
      }
      if (color === "unvisited") {
        const cycle = visit(edge.to);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    colors.set(nodeId, "visited");
    return undefined;
  };

  for (const nodeId of dag.nodes.keys()) {
    if (colors.get(nodeId) !== "unvisited") continue;
    const cycle = visit(nodeId);
    if (cycle) return cycle;
  }
  return undefined;
}

export function getReadyQueue(dag: Dag, input: ReadyQueueInput): DagNode[] {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new DagValidationError(
      "invalid-limit",
      "Ready queue limit must be a positive safe integer.",
    );
  }

  const availableSlots = Math.max(0, input.limit - input.active.size);
  if (availableSlots === 0) return [];

  const candidates: DagNode[] = [];
  for (const node of dag.nodes.values()) {
    if (
      input.completed.has(node.id) ||
      input.active.has(node.id) ||
      input.blocked.has(node.id)
    )
      continue;
    const predecessors = dag.incoming.get(node.id) ?? [];
    if (predecessors.every((edge) => input.completed.has(edge.from)))
      candidates.push(node);
  }

  return candidates
    .sort(
      (left, right) =>
        right.priority - left.priority || left.id.localeCompare(right.id),
    )
    .slice(0, availableSlots);
}
