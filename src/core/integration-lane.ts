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

export interface IntegrationLanePromotion {
  queuePosition?: number;
  stagingBranch?: string;
  stagingSha?: string;
  shippingPullNumber?: number;
  promotedAt?: string;
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
    value.startsWith("/") || value.endsWith("/") || value.includes("..") ||
    value.includes("//") || value.includes("@{") || /[\x00-\x20~^:?*\\[\\]]/.test(value)
  )
    throw new IntegrationLaneValidationError("invalid-ref", `Invalid Git ref: ${String(value)}.`);
  for (const component of value.split("/"))
    if (!component || component.startsWith(".") || component.endsWith("."))
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
  if (!lane.promotion || typeof lane.promotion !== "object") fail("invalid-promotion", "Promotion metadata must be an object.");
  if (lane.promotion.queuePosition !== undefined && (!Number.isSafeInteger(lane.promotion.queuePosition) || lane.promotion.queuePosition < 0)) fail("invalid-promotion", "Queue position must be a non-negative integer.");
  if (lane.legacy && (
    lane.kind !== "milestone" ||
    !/^legacy-[0-9a-f]{8}$/.test(lane.stableId) ||
    lane.slug !== "fast-lane" ||
    lane.sourceQuery !== "legacy-fast-lane" ||
    lane.frozenBase.sha !== "0000000"
  )) fail("invalid-legacy-lane", "Only the canonical legacy fast-lane interpretation may set legacy.");
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
