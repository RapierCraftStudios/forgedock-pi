export const INTEGRATION_LANE_SCHEMA =
  "forgedock.integration-lane/v1" as const;
export const MAX_INTEGRATION_LANE_SLUG_LENGTH = 48;
export const MAX_INTEGRATION_LANE_BRANCH_LENGTH = 240;

export type IntegrationLaneKind = "milestone" | "work-order";
export type IntegrationLaneStatus =
  | "queued"
  | "active"
  | "ready"
  | "syncing"
  | "promoting"
  | "promoted"
  | "closed"
  | "blocked"
  | "needs-human"
  | "failed";

export interface IntegrationLaneBase {
  branch: string;
  sha: string;
}

export interface IntegrationLaneMember {
  issueNumber: number;
  ordinal: number;
}

export interface IntegrationLaneQueueLease {
  ownerId: string;
  epoch: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface IntegrationLaneStagingEvidence {
  branch: string;
  sha: string;
  baselineSha: string;
  idle: boolean;
  checkedAt: string;
  /** True when another staging remediation/deployment owner is active. */
  ownedByAnotherLane?: boolean;
}

export interface IntegrationLanePromotionReceipt {
  shippingPullNumber: number;
  sourceHeadSha: string;
  stagingBaseSha: string;
  mergeBaseSha: string;
  mergeCommitSha: string;
  mergeMethod: "merge";
  reviewedAt: string;
}

export interface IntegrationLanePromotion {
  queuePosition?: number;
  stagingBranch?: string;
  stagingSha?: string;
  shippingPullNumber?: number;
  promotedAt?: string;
  queueLease?: IntegrationLaneQueueLease;
  stagingEvidence?: IntegrationLaneStagingEvidence;
  receipt?: IntegrationLanePromotionReceipt;
  /** Exact protected staging readback captured at the promotion boundary. */
  stagingReadbackSha?: string;
  /** Overlap is informational; lanes are never auto-combined. */
  overlappingLaneIds?: readonly string[];
  blockReason?: string;
}

export interface IntegrationLane {
  schema: typeof INTEGRATION_LANE_SCHEMA;
  kind: IntegrationLaneKind;
  stableId: string;
  slug: string;
  branch: string;
  repository: string;
  frozenBase: IntegrationLaneBase;
  membership: readonly IntegrationLaneMember[];
  sourceQuery: string;
  createdAt: string;
  updatedAt: string;
  status: IntegrationLaneStatus;
  promotion: IntegrationLanePromotion;
  /** True only for an event replayed from the pre-lane fast-lane format. */
  legacy?: boolean;
}

export type IntegrationLaneInput = Omit<
  IntegrationLane,
  "schema" | "slug" | "branch" | "promotion" | "frozenBase"
> & {
  schema?: typeof INTEGRATION_LANE_SCHEMA;
  slug?: string;
  branch?: string;
  promotion?: IntegrationLanePromotion;
  frozenBase?: IntegrationLaneBase;
  /** Compatibility aliases accepted at the boundary and normalized away. */
  frozenBaseBranch?: string;
  frozenBaseSha?: string;
};

export class IntegrationLaneValidationError extends TypeError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "IntegrationLaneValidationError";
    this.code = code;
  }
}

export function normalizeIntegrationSlug(value: string): string {
  if (typeof value !== "string")
    throw new IntegrationLaneValidationError("invalid-slug", "Lane slug must be a string.");
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_INTEGRATION_LANE_SLUG_LENGTH)
    .replace(/-+$/g, "");
  if (!slug) throw new IntegrationLaneValidationError("invalid-slug", "Lane slug must contain an alphanumeric character.");
  return slug;
}

export function workOrderBranchName(stableId: string, slug: string): string {
  const id = normalizeStableId(stableId);
  const normalizedSlug = normalizeIntegrationSlug(slug);
  const prefix = "work-order/";
  const suffix = `${id}-${normalizedSlug}`;
  const available = MAX_INTEGRATION_LANE_BRANCH_LENGTH - prefix.length;
  const bounded = suffix.slice(0, available).replace(/-+$/g, "");
  const branch = `${prefix}${bounded}`;
  validateGitRef(branch);
  return branch;
}

export function normalizeStableId(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value))
    throw new IntegrationLaneValidationError("invalid-stable-id", "Lane stableId must be lowercase and contain only a-z, 0-9, ., _, or -.");
  return value;
}

export function validateGitRef(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_INTEGRATION_LANE_BRANCH_LENGTH ||
    value.startsWith("/") || value.endsWith("/") || value === "@" || value.includes("..") ||
    value.includes("//") || value.includes("@{") || /[\x00-\x20~^:?*\\[\\]]/.test(value)
  )
    throw new IntegrationLaneValidationError("invalid-ref", `Invalid Git ref: ${String(value)}.`);
  for (const component of value.split("/"))
    if (!component || component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"))
      throw new IntegrationLaneValidationError("invalid-ref", `Invalid Git ref: ${value}.`);
}

export function createIntegrationLane(input: IntegrationLaneInput): IntegrationLane {
  const slug = normalizeIntegrationSlug(input.slug ?? input.stableId);
  const stableId = normalizeStableId(input.stableId);
  const branch = input.branch ?? (input.kind === "work-order" ? workOrderBranchName(stableId, slug) : `milestone/${slug}`);
  const lane: IntegrationLane = {
    schema: INTEGRATION_LANE_SCHEMA,
    kind: input.kind,
    stableId,
    slug,
    branch,
    repository: input.repository,
    frozenBase: input.frozenBase ?? {
      branch: input.frozenBaseBranch ?? "main",
      sha: input.frozenBaseSha ?? "",
    },
    membership: input.membership,
    sourceQuery: input.sourceQuery,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    status: input.status,
    promotion: input.promotion ?? {},
    ...(input.legacy ? { legacy: true } : {}),
  };
  validateIntegrationLane(lane);
  return lane;
}

export function validateIntegrationLane(lane: IntegrationLane): void {
  if (!lane || typeof lane !== "object") fail("invalid-lane", "Integration lane must be an object.");
  if (lane.schema !== INTEGRATION_LANE_SCHEMA) fail("unsupported-schema", "Unsupported integration lane schema.");
  if (lane.kind !== "milestone" && lane.kind !== "work-order") fail("invalid-kind", "Lane kind must be milestone or work-order.");
  normalizeStableId(lane.stableId);
  if (lane.slug !== normalizeIntegrationSlug(lane.slug)) fail("invalid-slug", "Lane slug is not normalized.");
  if (lane.kind === "work-order" && lane.branch !== workOrderBranchName(lane.stableId, lane.slug)) fail("invalid-branch", "Work-order branch does not match its stable identity.");
  validateGitRef(lane.branch);
  if (typeof lane.repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(lane.repository)) fail("invalid-repository", "Lane repository must be owner/name.");
  const validFrozenSha = lane.legacy
    ? lane.frozenBase?.sha === "0000000"
    : /^[0-9a-f]{40}$/i.test(lane.frozenBase?.sha ?? "");
  if (!lane.frozenBase || typeof lane.frozenBase.branch !== "string" || !lane.frozenBase.branch.trim() || !validFrozenSha) fail("invalid-base", "Lane frozen base must contain a branch and exact commit SHA.");
  if (!lane.legacy && lane.kind === "work-order" && lane.frozenBase.branch !== "main")
    fail("invalid-base", "Work-order lane frozen base must be main.");
  validateGitRef(lane.frozenBase.branch);
  if (!Array.isArray(lane.membership)) fail("invalid-membership", "Lane membership must be an array.");
  const members = new Set<number>();
  const ordinals = new Set<number>();
  lane.membership.forEach((member, index) => {
    if (!Number.isSafeInteger(member.issueNumber) || member.issueNumber < 1 || !Number.isSafeInteger(member.ordinal) || member.ordinal < 0 || members.has(member.issueNumber) || ordinals.has(member.ordinal)) fail("invalid-membership", `Invalid or duplicate membership at index ${index}.`);
    members.add(member.issueNumber);
    ordinals.add(member.ordinal);
  });
  if (typeof lane.sourceQuery !== "string" || !lane.sourceQuery.trim()) fail("invalid-source-query", "Lane sourceQuery must be non-empty.");
  if (Number.isNaN(Date.parse(lane.createdAt)) || Number.isNaN(Date.parse(lane.updatedAt))) fail("invalid-timestamp", "Lane timestamps must be RFC3339-compatible.");
  const statuses: IntegrationLaneStatus[] = ["queued", "active", "ready", "syncing", "promoting", "promoted", "closed", "blocked", "needs-human", "failed"];
  if (!statuses.includes(lane.status)) fail("invalid-status", "Unsupported lane status.");
  if (!lane.promotion || typeof lane.promotion !== "object" || Array.isArray(lane.promotion)) fail("invalid-promotion", "Promotion metadata must be a plain object.");
  if (lane.promotion.queuePosition !== undefined && (!Number.isSafeInteger(lane.promotion.queuePosition) || lane.promotion.queuePosition < 0)) fail("invalid-promotion", "Queue position must be a non-negative integer.");
  const queueLease = lane.promotion.queueLease;
  if (queueLease !== undefined) {
    if (typeof queueLease.ownerId !== "string" || !queueLease.ownerId.trim() || !Number.isSafeInteger(queueLease.epoch) || queueLease.epoch < 1 || Number.isNaN(Date.parse(queueLease.acquiredAt)) || Number.isNaN(Date.parse(queueLease.expiresAt)) || Date.parse(queueLease.expiresAt) <= Date.parse(queueLease.acquiredAt))
      fail("invalid-queue-lease", "Queue lease must contain an owner, positive epoch, and increasing RFC3339 timestamps.");
  }
  const stagingEvidence = lane.promotion.stagingEvidence;
  if (stagingEvidence !== undefined) {
    try { validateGitRef(stagingEvidence.branch); } catch { fail("invalid-staging-evidence", "Staging evidence branch is invalid."); }
    if (!/^[0-9a-f]{40}$/i.test(stagingEvidence.sha) || !/^[0-9a-f]{40}$/i.test(stagingEvidence.baselineSha) || typeof stagingEvidence.idle !== "boolean" || (stagingEvidence.ownedByAnotherLane !== undefined && typeof stagingEvidence.ownedByAnotherLane !== "boolean") || Number.isNaN(Date.parse(stagingEvidence.checkedAt)))
      fail("invalid-staging-evidence", "Staging evidence must contain exact SHAs, idle state, ownership flag, and timestamp.");
  }
  const receipt = lane.promotion.receipt;
  if (receipt !== undefined && (!Number.isSafeInteger(receipt.shippingPullNumber) || receipt.shippingPullNumber < 1 || !/^[0-9a-f]{40}$/i.test(receipt.sourceHeadSha) || !/^[0-9a-f]{40}$/i.test(receipt.stagingBaseSha) || !/^[0-9a-f]{40}$/i.test(receipt.mergeBaseSha) || !/^[0-9a-f]{40}$/i.test(receipt.mergeCommitSha) || receipt.mergeMethod !== "merge" || Number.isNaN(Date.parse(receipt.reviewedAt))))
    fail("invalid-promotion-receipt", "Promotion receipt must bind exact heads and a merge commit.");
  if (lane.promotion.stagingReadbackSha !== undefined && !/^[0-9a-f]{40}$/i.test(lane.promotion.stagingReadbackSha))
    fail("invalid-staging-readback", "Promotion staging readback must be an exact commit SHA.");
  if (lane.legacy && (
    lane.kind !== "milestone" ||
    !/^legacy-[0-9a-f]{8}$/.test(lane.stableId) ||
    lane.slug !== "fast-lane" ||
    lane.sourceQuery !== "legacy-fast-lane" ||
    lane.frozenBase.sha !== "0000000"
  )) fail("invalid-legacy-lane", "Only the canonical legacy fast-lane interpretation may set legacy.");
}

export type IntegrationLaneTransition =
  | "queue"
  | "acquire-queue-lease"
  | "release-queue-lease"
  | "sync"
  | "begin-promotion"
  | "promote"
  | "close"
  | "block";

export interface IntegrationLaneTransitionInput {
  now: string;
  ownerId?: string;
  leaseSeconds?: number;
  queuePosition?: number;
  queueHeadLaneId?: string;
  leaseEpoch?: number;
  staging?: IntegrationLaneStagingEvidence;
  receipt?: IntegrationLanePromotionReceipt;
  reviewPassed?: boolean;
  verificationPassed?: boolean;
  mergeable?: boolean;
  authorityValid?: boolean;
  mergeCommit?: boolean;
  /** Current protected staging ref read immediately before durable promotion. */
  stagingReadbackSha?: string;
  reason?: string;
}

/**
 * Return true only when the lane owns a live queue lease.  A queue lease is
 * deliberately lane-scoped: child run leases must not be substituted for it.
 */
export function hasLiveQueueLease(
  lane: Pick<IntegrationLane, "promotion">,
  ownerId: string,
  now: string,
): boolean {
  const lease = lane.promotion.queueLease;
  return Boolean(
    lease && lease.ownerId === ownerId &&
      !Number.isNaN(Date.parse(now)) &&
      Date.parse(lease.expiresAt) > Date.parse(now),
  );
}

/** Check the complete set of gates required before a lane can promote. */
export function canPromoteIntegrationLane(
  lane: Pick<IntegrationLane, "kind" | "status" | "promotion" | "stableId" | "frozenBase">,
  input: {
    ownerId: string;
    now: string;
    sourceHeadSha: string;
    mergeBaseSha: string;
    staging: IntegrationLaneStagingEvidence;
    reviewPassed: boolean;
    verificationPassed: boolean;
    mergeable: boolean;
    authorityValid: boolean;
    mergeCommit: boolean;
    queueHeadLaneId?: string;
  },
): { ok: true } | { ok: false; reason: string } {
  if (lane.kind !== "work-order")
    return { ok: false, reason: "Only work-order lanes auto-promote." };
  if (input.queueHeadLaneId !== undefined && input.queueHeadLaneId !== lane.stableId)
    return { ok: false, reason: "Only the durable promotion queue head may promote." };
  if (lane.status !== "syncing" && lane.status !== "ready" && lane.status !== "promoting")
    return { ok: false, reason: `Lane is ${lane.status}, not ready for promotion.` };
  if (!hasLiveQueueLease(lane, input.ownerId, input.now))
    return { ok: false, reason: "Queue-head lease is missing, stale, or owned by another lane." };
  if (!input.staging.idle || input.staging.ownedByAnotherLane)
    return { ok: false, reason: "Staging is not idle or is owned by another promotion." };
  if (input.staging.baselineSha !== input.staging.sha || input.staging.sha !== lane.frozenBase.sha)
    return { ok: false, reason: "Staging is not at the expected deployed-main baseline." };
  if (!/^[0-9a-f]{40}$/i.test(input.sourceHeadSha))
    return { ok: false, reason: "Lane source head is not an exact reviewed commit SHA." };
  if (!/^[0-9a-f]{40}$/i.test(input.mergeBaseSha) || input.mergeBaseSha !== input.staging.sha)
    return { ok: false, reason: "Promotion merge-base does not match staging." };
  if (!input.reviewPassed || !input.verificationPassed || !input.mergeable)
    return { ok: false, reason: "Promotion review, verification, or mergeability gate failed." };
  if (!input.authorityValid) return { ok: false, reason: "Promotion authority is no longer valid." };
  if (!input.mergeCommit) return { ok: false, reason: "Lane promotion requires a merge commit." };
  return { ok: true };
}

/** Apply one guarded lane-level lifecycle transition without side effects. */
export function transitionIntegrationLane(
  lane: IntegrationLane,
  transition: IntegrationLaneTransition,
  input: IntegrationLaneTransitionInput,
): IntegrationLane {
  const next: IntegrationLane = {
    ...lane,
    promotion: { ...lane.promotion },
    updatedAt: input.now,
  };
  if (!input.now.trim() || Number.isNaN(Date.parse(input.now)))
    throw new IntegrationLaneValidationError("invalid-timestamp", "Transition time must be RFC3339-compatible.");
  switch (transition) {
    case "queue":
      if (!["queued", "active", "ready"].includes(lane.status)) throw new IntegrationLaneValidationError("invalid-transition", `Cannot queue a ${lane.status} lane.`);
      if (!Number.isSafeInteger(input.queuePosition) || (input.queuePosition ?? -1) < 0) throw new IntegrationLaneValidationError("invalid-queue", "Queue position is required.");
      next.status = "ready";
      next.promotion.queuePosition = input.queuePosition;
      break;
    case "acquire-queue-lease": {
      const reclaimable = lane.status === "syncing";
      if (lane.status !== "ready" && !reclaimable) throw new IntegrationLaneValidationError("invalid-transition", `Cannot acquire a queue lease for a ${lane.status} lane.`);
      const ownerId = input.ownerId?.trim();
      const leaseSeconds = input.leaseSeconds;
      if (!ownerId) throw new IntegrationLaneValidationError("invalid-lease", "Queue lease owner is required.");
      if (!Number.isSafeInteger(leaseSeconds) || (leaseSeconds ?? 0) < 1) throw new IntegrationLaneValidationError("invalid-lease", "Queue lease duration must be positive.");
      const prior = lane.promotion.queueLease;
      if (prior && Date.parse(prior.expiresAt) > Date.parse(input.now) && prior.ownerId !== ownerId) throw new IntegrationLaneValidationError("queue-lease-held", "Queue lease is held by another owner.");
      if (reclaimable && prior && Date.parse(prior.expiresAt) > Date.parse(input.now)) throw new IntegrationLaneValidationError("queue-lease-held", "A live queue lease must be renewed by its owner through the existing transition.");
      next.promotion.queueLease = { ownerId, epoch: (prior?.epoch ?? 0) + 1, acquiredAt: input.now, expiresAt: new Date(Date.parse(input.now) + (leaseSeconds as number) * 1000).toISOString() };
      next.status = "syncing";
      break;
    }
    case "release-queue-lease":
      if (!input.ownerId || lane.promotion.queueLease?.ownerId !== input.ownerId || input.leaseEpoch !== lane.promotion.queueLease?.epoch) throw new IntegrationLaneValidationError("queue-lease-epoch", "Only the current queue-lease owner and epoch may release it.");
      delete next.promotion.queueLease;
      if (lane.status === "syncing" || lane.status === "promoting") next.status = "ready";
      break;
    case "sync":
      if (lane.status !== "syncing") throw new IntegrationLaneValidationError("invalid-transition", `Cannot sync a ${lane.status} lane.`);
      if (!input.ownerId || !hasLiveQueueLease(lane, input.ownerId, input.now) || input.leaseEpoch !== lane.promotion.queueLease?.epoch) throw new IntegrationLaneValidationError("queue-lease-owner", "Sync requires the live queue-lease owner and epoch.");
      if (!input.staging) throw new IntegrationLaneValidationError("missing-staging-evidence", "Staging evidence is required for sync.");
      next.promotion.stagingEvidence = input.staging;
      next.promotion.stagingBranch = input.staging.branch;
      next.promotion.stagingSha = input.staging.sha;
      next.status = "ready";
      break;
    case "begin-promotion":
      if (lane.status !== "ready") throw new IntegrationLaneValidationError("invalid-transition", `Cannot begin promotion for a ${lane.status} lane.`);
      if (!input.ownerId || !input.staging || input.queueHeadLaneId !== lane.stableId || input.leaseEpoch !== lane.promotion.queueLease?.epoch || !hasLiveQueueLease(lane, input.ownerId, input.now))
        throw new IntegrationLaneValidationError("promotion-fence", "Promotion requires the current queue-head owner and live lease epoch.");
      next.status = "promoting";
      break;
    case "promote":
      if (lane.status !== "ready" && lane.status !== "promoting") throw new IntegrationLaneValidationError("invalid-transition", `Cannot promote a ${lane.status} lane.`);
      if (!input.ownerId || !input.staging || !input.receipt || input.queueHeadLaneId !== lane.stableId || input.leaseEpoch !== lane.promotion.queueLease?.epoch || input.stagingReadbackSha !== input.receipt.mergeCommitSha) throw new IntegrationLaneValidationError("missing-promotion-evidence", "Queue owner, queue head, lease epoch, staging evidence, exact shipping merge readback, and receipt are required.");
      if (lane.promotion.stagingEvidence && (lane.promotion.stagingEvidence.sha !== input.staging.sha || lane.promotion.stagingEvidence.branch !== input.staging.branch)) throw new IntegrationLaneValidationError("staging-evidence-mismatch", "Promotion staging evidence does not match the persisted sync evidence.");
      if (input.receipt.stagingBaseSha !== input.staging.sha) throw new IntegrationLaneValidationError("staging-receipt-mismatch", "Promotion receipt staging base does not match staging evidence.");
      if (input.stagingReadbackSha !== input.receipt.mergeCommitSha) throw new IntegrationLaneValidationError("merge-readback-mismatch", "Protected staging readback must equal the exact shipping merge commit SHA.");
      const gate = canPromoteIntegrationLane(lane, { ownerId: input.ownerId, now: input.now, sourceHeadSha: input.receipt.sourceHeadSha, mergeBaseSha: input.receipt.mergeBaseSha, staging: input.staging, reviewPassed: input.reviewPassed === true, verificationPassed: input.verificationPassed === true, mergeable: input.mergeable === true, authorityValid: input.authorityValid === true, mergeCommit: input.mergeCommit === true && input.receipt.mergeMethod === "merge", queueHeadLaneId: input.queueHeadLaneId });
      if (!gate.ok) throw new IntegrationLaneValidationError("promotion-gated", gate.reason);
      next.status = "promoted";
      next.promotion.stagingEvidence = input.staging;
      next.promotion.stagingBranch = input.staging.branch;
      next.promotion.stagingSha = input.staging.sha;
      next.promotion.stagingReadbackSha = input.stagingReadbackSha;
      next.promotion.shippingPullNumber = input.receipt.shippingPullNumber;
      next.promotion.receipt = input.receipt;
      next.promotion.promotedAt = input.now;
      delete next.promotion.queueLease;
      break;
    case "close":
      if (lane.status !== "promoted") throw new IntegrationLaneValidationError("promotion-required", "Lane members may close only after promotion.");
      next.status = "closed";
      break;
    case "block":
      if (!["queued", "active", "ready", "syncing"].includes(lane.status)) throw new IntegrationLaneValidationError("invalid-transition", `Cannot block a ${lane.status} lane.`);
      next.status = "blocked";
      if (input.reason?.trim()) next.promotion = { ...next.promotion, blockReason: input.reason.trim() } as IntegrationLanePromotion;
      delete next.promotion.queueLease;
      break;
  }
  validateIntegrationLane(next);
  return next;
}

export function validatePromotionQueue(
  lanes: readonly (Pick<IntegrationLane, "stableId" | "status" | "promotion"> & { repository?: string })[],
): void {
  const positions = new Set<number>();
  const identities = new Set<string>();
  lanes.forEach((lane) => {
    if (!["queued", "active", "ready", "syncing", "promoting"].includes(lane.status)) return;
    const identity = `${lane.repository ?? ""}/${lane.stableId}`;
    if (identities.has(identity)) throw new IntegrationLaneValidationError("duplicate-lane-identity", "Active repository/lane stable identities must be unique before queue-head authorization.");
    identities.add(identity);
    const position = lane.promotion.queuePosition;
    if (position === undefined) return;
    if (positions.has(position)) throw new IntegrationLaneValidationError("duplicate-queue-position", "Promotion queue positions must be unique.");
    positions.add(position);
  });
  // Positions are monotonic allocation tokens across independent orchestration
  // records; closed/promoted lanes may leave gaps and must not invalidate the
  // remaining queue.
  const active = lanes.filter((lane) => ["ready", "syncing", "promoting"].includes(lane.status));
  const head = active.sort((a, b) => (a.promotion.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.promotion.queuePosition ?? Number.MAX_SAFE_INTEGER))[0];
  if (head && head.promotion.queuePosition !== undefined && lanes.some((lane) => lane.status === "promoting" && lane.stableId !== head.stableId)) throw new IntegrationLaneValidationError("queue-head-only", "Only the promotion queue head may promote.");
}

export function legacyFastLane(input: { repository: string; integrationBranch: string; orchestrationId: string; issueNumbers: readonly number[]; occurredAt: string }): IntegrationLane {
  const stableId = `legacy-${deterministicId(input.orchestrationId)}`;
  return createIntegrationLane({
    kind: "milestone",
    stableId,
    slug: "fast-lane",
    branch: input.integrationBranch,
    repository: input.repository,
    frozenBase: { branch: input.integrationBranch, sha: "0000000" },
    membership: input.issueNumbers.map((issueNumber, ordinal) => ({ issueNumber, ordinal })),
    sourceQuery: "legacy-fast-lane",
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    status: "active",
    promotion: {},
    legacy: true,
  });
}

function deterministicId(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fail(code: string, message: string): never {
  throw new IntegrationLaneValidationError(code, message);
}
