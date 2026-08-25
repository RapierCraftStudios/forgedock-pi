import {
  createRunEvent,
  RUN_PHASES,
  type RunEvent,
  type RunEventType,
  type RunPhase,
} from "../core/events.ts";
import { applyRunEvent } from "../core/state.ts";
import { GitHubIssueProjector } from "./github-projection.ts";
import { GitHubStateBranchStore } from "./github-state.ts";
import {
  ForgeGitHubProjectionService,
  type CheckpointAction,
  type PhaseProjectionInput,
} from "./forge-projection.ts";
import type { GitHubTransport } from "./github-api.ts";

export interface ForgeCheckpointBinding {
  runId: string;
  repository: string;
  issueNumber: number;
  leaseEpoch: number;
  stateBranch: string;
  worktreeRoot: string;
  branch: string;
  baseSha: string;
}

export interface ForgeCheckpointRequest {
  phase: RunPhase;
  attempt: number;
  action: CheckpointAction;
  restartAction?: string;
  logicalNodeId?: string;
  inputArtifactHash?: string;
  outputArtifactHash?: string;
  commitSha?: string;
  evidence?: readonly string[];
  report?: string;
  reason?: string;
}

export interface ForgeCheckpointResult {
  eventId: string;
  idempotent: boolean;
  sequence: number;
  stateTip: string;
  content: [{ type: "text"; text: string }];
  details: {
    eventId: string;
    idempotent: boolean;
    sequence: number;
    stateTip: string;
  };
}

export class ForgeCheckpointService {
  readonly #binding: ForgeCheckpointBinding;
  readonly #transportFactory: (
    signal?: AbortSignal,
  ) => Promise<GitHubTransport>;

  constructor(input: {
    binding: ForgeCheckpointBinding;
    transportFactory: (
      signal?: AbortSignal,
    ) => Promise<GitHubTransport>;
  }) {
    this.#binding = input.binding;
    this.#transportFactory = input.transportFactory;
  }

  async checkpoint(
    params: ForgeCheckpointRequest,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ForgeCheckpointResult> {
    const transport = await this.#transportFactory(signal);
    const store = new GitHubStateBranchStore(
      transport,
      this.#binding.repository,
      this.#binding.stateBranch,
    );
    const current = await store.readRun(this.#binding.runId, signal);
    if (!current.state || !current.lease)
      throw new Error(
        `Authoritative run ${this.#binding.runId} is not initialized.`,
      );
    if (
      current.lease.epoch !== this.#binding.leaseEpoch ||
      current.lease.ownerRunId !== this.#binding.runId
    ) {
      throw new Error(
        `Bound lease epoch ${this.#binding.leaseEpoch} no longer owns run ${this.#binding.runId}.`,
      );
    }

    const idempotencyKey = `phase:${params.phase}:${params.attempt}:${params.action}`;
    const priorEventId = current.state.idempotencyKeys[idempotencyKey];
    let event: RunEvent;
    let sequence: number;
    let stateTip = current.tip;
    let idempotent = false;

    if (priorEventId) {
      const priorEvent = current.events.find(
        (candidate) => candidate.eventId === priorEventId,
      );
      if (!priorEvent)
        throw new Error(
          `Checkpoint event ${priorEventId} is missing from the journal.`,
        );
      event = priorEvent;
      sequence = current.state.sequence;
      idempotent = true;
    } else {
      event = createRunEvent({
        runId: this.#binding.runId,
        repository: this.#binding.repository,
        sequence: current.state.sequence + 1,
        previousEventHash: current.state.lastEventHash,
        type: checkpointEventType(params.action),
        actor: {
          kind: "extension",
          sessionId,
          leaseEpoch: this.#binding.leaseEpoch,
        },
        idempotencyKey,
        payload: checkpointPayload(params, this.#binding),
      });
      const nextState = applyRunEvent(current.state, event);
      stateTip = await store.commitRunState({
        expectedTip: current.tip,
        events: [...current.events, event],
        state: nextState,
        lease: current.lease,
        message: `Checkpoint ${this.#binding.runId} ${params.phase} ${params.action}`,
        ...(signal ? { signal } : {}),
      });
      sequence = nextState.sequence;
    }

    if (params.action !== "queue") {
      const projection = new ForgeGitHubProjectionService(
        new GitHubIssueProjector(transport, this.#binding.repository),
        this.#binding,
      );
      if (params.action !== "start")
        await projection.projectPhase(event, params, signal);
      await projection.setWorkflowLabel(params, signal);
      await projection.projectDerived(event, params, signal);
    }

    const text = idempotent
      ? `Checkpoint already recorded by event ${event.eventId}.`
      : `Recorded ${params.phase} ${params.action} at sequence ${sequence}.`;
    return {
      eventId: event.eventId,
      idempotent,
      sequence,
      stateTip,
      content: [{ type: "text", text }],
      details: {
        eventId: event.eventId,
        idempotent,
        sequence,
        stateTip,
      },
    };
  }
}

function checkpointEventType(action: CheckpointAction): RunEventType {
  const eventTypes: Record<CheckpointAction, RunEventType> = {
    queue: "phase.queued",
    start: "phase.started",
    complete: "phase.completed",
    fail: "phase.failed",
    block: "phase.blocked",
    "needs-human": "phase.needs-human",
    abandon: "phase.abandoned",
  };
  return eventTypes[action];
}

function checkpointPayload(
  params: ForgeCheckpointRequest,
  binding: ForgeCheckpointBinding,
): Record<string, unknown> {
  const common = { phase: params.phase, attempt: params.attempt };
  if (params.action === "queue") {
    return {
      ...common,
      restartAction:
        params.restartAction ??
        `resume ${params.phase} attempt ${params.attempt}`,
      ...(params.inputArtifactHash
        ? { inputArtifactHash: params.inputArtifactHash }
        : {}),
    };
  }
  if (params.action === "start") {
    return {
      ...common,
      logicalNodeId:
        params.logicalNodeId ?? `${params.phase}-${params.attempt}`,
      worktreePath: binding.worktreeRoot,
      branch: binding.branch,
      baseSha: binding.baseSha,
    };
  }
  if (params.action === "complete") {
    return {
      ...common,
      evidence: params.evidence ?? [],
      ...(params.report ? { report: params.report } : {}),
      ...(params.outputArtifactHash
        ? { outputArtifactHash: params.outputArtifactHash }
        : {}),
      ...(params.commitSha ? { commitSha: params.commitSha } : {}),
    };
  }
  return {
    ...common,
    reason:
      params.reason ??
      `${params.phase} attempt ${params.attempt} ${params.action}`,
  };
}

export { RUN_PHASES };
export type { PhaseProjectionInput };
