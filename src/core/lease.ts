import { FORGEDOCK_LEASE_SCHEMA } from "./version.ts";

export interface RepositoryLease {
  schema: typeof FORGEDOCK_LEASE_SCHEMA;
  repository: string;
  ownerRunId: string;
  ownerSessionId: string;
  epoch: number;
  acquiredAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
  takeoverRequired: boolean;
  takeoverAuthorizedBy?: string;
}

export interface LeaseOwner {
  runId: string;
  sessionId: string;
}

export interface LeaseMutationInput {
  repository: string;
  owner: LeaseOwner;
  now: Date;
  ttlSeconds: number;
}

export class LeaseConflictError extends Error {
  readonly code:
    | "active-lease"
    | "takeover-required"
    | "not-owner"
    | "stale-epoch"
    | "not-expired";

  constructor(code: LeaseConflictError["code"], message: string) {
    super(message);
    this.name = "LeaseConflictError";
    this.code = code;
  }
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30) {
    throw new RangeError(
      "Lease TTL must be a safe integer of at least 30 seconds.",
    );
  }
}

function expiresAt(now: Date, ttlSeconds: number): string {
  return new Date(now.getTime() + ttlSeconds * 1_000).toISOString();
}

export function isLeaseExpired(lease: RepositoryLease, now: Date): boolean {
  return Date.parse(lease.expiresAt) <= now.getTime();
}

export function acquireLease(
  current: RepositoryLease | undefined,
  input: LeaseMutationInput,
): RepositoryLease {
  assertTtl(input.ttlSeconds);
  if (current) {
    if (isLeaseExpired(current, input.now)) {
      throw new LeaseConflictError(
        "takeover-required",
        `Lease epoch ${current.epoch} expired; explicit human-authorized takeover is required.`,
      );
    }
    throw new LeaseConflictError(
      "active-lease",
      `Repository is owned by run ${current.ownerRunId} until ${current.expiresAt}.`,
    );
  }

  const timestamp = input.now.toISOString();
  return {
    schema: FORGEDOCK_LEASE_SCHEMA,
    repository: input.repository,
    ownerRunId: input.owner.runId,
    ownerSessionId: input.owner.sessionId,
    epoch: 1,
    acquiredAt: timestamp,
    lastHeartbeatAt: timestamp,
    expiresAt: expiresAt(input.now, input.ttlSeconds),
    takeoverRequired: false,
  };
}

export function heartbeatLease(
  current: RepositoryLease,
  input: LeaseMutationInput & { epoch: number },
): RepositoryLease {
  assertTtl(input.ttlSeconds);
  assertLeaseOwner(current, input.owner, input.epoch);
  if (isLeaseExpired(current, input.now)) {
    throw new LeaseConflictError(
      "takeover-required",
      "Expired leases cannot be revived by heartbeat.",
    );
  }

  return {
    ...current,
    lastHeartbeatAt: input.now.toISOString(),
    expiresAt: expiresAt(input.now, input.ttlSeconds),
  };
}

export function takeoverLease(
  current: RepositoryLease,
  input: LeaseMutationInput & { authorizedBy: string },
): RepositoryLease {
  assertTtl(input.ttlSeconds);
  if (!isLeaseExpired(current, input.now)) {
    throw new LeaseConflictError(
      "not-expired",
      `Lease remains active until ${current.expiresAt}.`,
    );
  }
  if (!input.authorizedBy.trim()) {
    throw new TypeError(
      "Takeover requires a non-empty human authorization identity.",
    );
  }

  const timestamp = input.now.toISOString();
  return {
    schema: FORGEDOCK_LEASE_SCHEMA,
    repository: input.repository,
    ownerRunId: input.owner.runId,
    ownerSessionId: input.owner.sessionId,
    epoch: current.epoch + 1,
    acquiredAt: timestamp,
    lastHeartbeatAt: timestamp,
    expiresAt: expiresAt(input.now, input.ttlSeconds),
    takeoverRequired: false,
    takeoverAuthorizedBy: input.authorizedBy,
  };
}

export function markTakeoverRequired(
  current: RepositoryLease,
): RepositoryLease {
  return { ...current, takeoverRequired: true };
}

export function validateRepositoryLease(
  value: unknown,
): asserts value is RepositoryLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Repository lease must be an object.");
  }
  const lease = value as Partial<RepositoryLease>;
  if (lease.schema !== FORGEDOCK_LEASE_SCHEMA)
    throw new TypeError(`Unsupported lease schema: ${String(lease.schema)}.`);
  for (const [field, entry] of [
    ["repository", lease.repository],
    ["ownerRunId", lease.ownerRunId],
    ["ownerSessionId", lease.ownerSessionId],
    ["acquiredAt", lease.acquiredAt],
    ["lastHeartbeatAt", lease.lastHeartbeatAt],
    ["expiresAt", lease.expiresAt],
  ] as const) {
    if (typeof entry !== "string" || !entry.trim())
      throw new TypeError(`Lease ${field} must be a non-empty string.`);
  }
  if (!Number.isSafeInteger(lease.epoch) || (lease.epoch ?? 0) < 1)
    throw new TypeError("Lease epoch must be a positive safe integer.");
  if (typeof lease.takeoverRequired !== "boolean")
    throw new TypeError("Lease takeoverRequired must be boolean.");
  for (const timestamp of [
    lease.acquiredAt,
    lease.lastHeartbeatAt,
    lease.expiresAt,
  ]) {
    if (Number.isNaN(Date.parse(timestamp as string)))
      throw new TypeError("Lease timestamps must be RFC3339-compatible.");
  }
}

export function assertLeaseOwner(
  current: RepositoryLease,
  owner: LeaseOwner,
  epoch: number,
): void {
  if (epoch !== current.epoch) {
    throw new LeaseConflictError(
      "stale-epoch",
      `Expected lease epoch ${current.epoch}, received ${epoch}.`,
    );
  }
  if (
    owner.runId !== current.ownerRunId ||
    owner.sessionId !== current.ownerSessionId
  ) {
    throw new LeaseConflictError(
      "not-owner",
      "Run/session does not own the repository lease.",
    );
  }
}
