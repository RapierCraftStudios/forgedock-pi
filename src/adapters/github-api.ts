export interface GitHubRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Opt in only when the caller can reconcile an ambiguous mutation result. */
  retryTransient?: boolean;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Readonly<Record<string, string>>;
}

export interface GitHubTransport {
  request<T>(request: GitHubRequest): Promise<GitHubResponse<T>>;
}

export interface GitHubCoreRateLimit {
  limit: number;
  remaining: number;
  resetAt: number;
}

export const GITHUB_CONTROL_PLANE_MIN_RESERVE = 1_000;
export const GITHUB_LANE_ESTIMATED_REQUEST_COST = 750;

export interface GitHubRateLimitReservation {
  readonly repository: string;
  readonly key: string;
  readonly cost: number;
  release(): void;
}

interface RepositoryRateLimitState {
  budget?: GitHubCoreRateLimit;
  reservations: Map<string, number>;
  waiters: Set<() => void>;
}

/**
 * Process-wide rate-limit accounting for orchestrations sharing a repository.
 * Reservations are estimates for active lanes; the control-plane reserve is
 * never offered to lane work. GitHub observations only move a budget forward
 * to a newer reset window or downward within the current window.
 */
export class GitHubRateLimitReservationPool {
  readonly #repositories = new Map<string, RepositoryRateLimitState>();

  update(repository: string, budget: GitHubCoreRateLimit): void {
    const state = this.#state(repository);
    const previous = state.budget;
    if (
      !previous ||
      budget.resetAt > previous.resetAt ||
      (budget.resetAt === previous.resetAt &&
        (budget.limit !== previous.limit ||
          budget.remaining < previous.remaining))
    ) {
      state.budget = Object.freeze({ ...budget });
      this.#notify(state);
    }
  }

  /** Update accounting from the rate headers returned by any API response. */
  updateFromHeaders(
    repository: string,
    headers: Readonly<Record<string, string>>,
  ): GitHubCoreRateLimit | undefined {
    const values = new Map(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const limit = Number(values.get("x-ratelimit-limit"));
    const remaining = Number(values.get("x-ratelimit-remaining"));
    const resetSeconds = Number(values.get("x-ratelimit-reset"));
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(remaining) ||
      remaining < 0 ||
      remaining > limit ||
      !Number.isSafeInteger(resetSeconds) ||
      resetSeconds < 1
    )
      return undefined;
    const budget = { limit, remaining, resetAt: resetSeconds * 1_000 };
    this.update(repository, budget);
    return budget;
  }

  availableSlots(
    repository: string,
    controlPlaneReserve = GITHUB_CONTROL_PLANE_MIN_RESERVE,
    laneCost = GITHUB_LANE_ESTIMATED_REQUEST_COST,
  ): number {
    if (!Number.isSafeInteger(controlPlaneReserve) || controlPlaneReserve < 0)
      throw new TypeError("Control-plane reserve must be non-negative.");
    if (!Number.isSafeInteger(laneCost) || laneCost < 1)
      throw new TypeError("Lane request cost must be positive.");
    const state = this.#state(repository);
    if (!state.budget) return 0;
    const reserved = [...state.reservations.values()].reduce(
      (total, cost) => total + cost,
      0,
    );
    const reserve = Math.max(
      controlPlaneReserve,
      Math.ceil(state.budget.limit * 0.2),
    );
    return Math.max(
      0,
      Math.floor((state.budget.remaining - reserve - reserved) / laneCost),
    );
  }

  reservedCost(repository: string): number {
    const state = this.#state(repository);
    return [...state.reservations.values()].reduce(
      (total, cost) => total + cost,
      0,
    );
  }

  track(
    repository: string,
    key: string,
    cost = GITHUB_LANE_ESTIMATED_REQUEST_COST,
  ): GitHubRateLimitReservation {
    if (!key.trim())
      throw new TypeError("Rate-limit reservation key is required.");
    if (!Number.isSafeInteger(cost) || cost < 1)
      throw new TypeError("Rate-limit reservation cost must be positive.");
    const state = this.#state(repository);
    const existing = state.reservations.get(key);
    if (existing !== undefined && existing !== cost)
      throw new Error(`Rate-limit reservation ${key} has a different cost.`);
    state.reservations.set(key, cost);
    return this.#reservation(repository, key, cost);
  }

  tryReserve(
    repository: string,
    key: string,
    cost = GITHUB_LANE_ESTIMATED_REQUEST_COST,
  ): GitHubRateLimitReservation | undefined {
    const state = this.#state(repository);
    const existing = state.reservations.get(key);
    if (existing !== undefined)
      return this.#reservation(repository, key, existing);
    if (
      this.availableSlots(repository) <
      Math.ceil(cost / GITHUB_LANE_ESTIMATED_REQUEST_COST)
    )
      return undefined;
    return this.track(repository, key, cost);
  }

  release(repository: string, key: string): void {
    const state = this.#state(repository);
    if (state.reservations.delete(key)) this.#notify(state);
  }

  releaseOrchestration(repository: string, orchestrationId: string): void {
    const state = this.#state(repository);
    let changed = false;
    for (const key of state.reservations.keys()) {
      if (key.startsWith(`${orchestrationId}:`)) {
        state.reservations.delete(key);
        changed = true;
      }
    }
    if (changed) this.#notify(state);
  }

  /** Rebuild this orchestration's active reservations after process resume. */
  synchronize(
    repository: string,
    orchestrationId: string,
    activeIssueNumbers: readonly number[],
  ): void {
    const state = this.#state(repository);
    const activeKeys = new Set(
      activeIssueNumbers.map(
        (issueNumber) => `${orchestrationId}:${issueNumber}`,
      ),
    );
    for (const key of state.reservations.keys()) {
      if (key.startsWith(`${orchestrationId}:`) && !activeKeys.has(key))
        state.reservations.delete(key);
    }
    for (const key of activeKeys)
      state.reservations.set(key, GITHUB_LANE_ESTIMATED_REQUEST_COST);
    this.#notify(state);
  }

  /** Wait for another orchestration to release a slot or for a reset window. */
  async waitForCapacity(
    repository: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.#state(repository);
    if (this.availableSlots(repository) > 0) return;
    if (signal?.aborted) throw signal.reason;
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: unknown): void => {
        if (timer) clearTimeout(timer);
        state.waiters.delete(onWake);
        signal?.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onWake = (): void => finish();
      const onAbort = (): void =>
        finish(signal?.reason ?? new Error("Rate-limit wait aborted."));
      state.waiters.add(onWake);
      const resetAt = state.budget?.resetAt;
      if (resetAt !== undefined)
        timer = setTimeout(
          onWake,
          Math.max(1_000, resetAt - Date.now() + 1_000),
        );
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #state(repository: string): RepositoryRateLimitState {
    if (!repository.trim()) throw new TypeError("Repository is required.");
    let state = this.#repositories.get(repository);
    if (!state) {
      state = { reservations: new Map(), waiters: new Set() };
      this.#repositories.set(repository, state);
    }
    return state;
  }

  #notify(state: RepositoryRateLimitState): void {
    for (const waiter of [...state.waiters]) waiter();
  }

  #reservation(
    repository: string,
    key: string,
    cost: number,
  ): GitHubRateLimitReservation {
    let released = false;
    return {
      repository,
      key,
      cost,
      release: (): void => {
        if (released) return;
        released = true;
        this.release(repository, key);
      },
    };
  }
}

export const githubRateLimitReservations = new GitHubRateLimitReservationPool();

export async function readGitHubCoreRateLimit(
  transport: GitHubTransport,
  signal?: AbortSignal,
  repository?: string,
): Promise<GitHubCoreRateLimit> {
  const path = "/rate_limit";
  const response = await transport.request<{
    resources?: {
      core?: { limit?: unknown; remaining?: unknown; reset?: unknown };
    };
  }>({
    method: "GET",
    path,
    ...(signal ? { signal } : {}),
  });
  const body = requireGitHubSuccess(response, path, [200]);
  const limit = body.resources?.core?.limit;
  const remaining = body.resources?.core?.remaining;
  const reset = body.resources?.core?.reset;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    typeof remaining !== "number" ||
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    remaining > limit ||
    typeof reset !== "number" ||
    !Number.isSafeInteger(reset) ||
    reset < 1
  )
    throw new GitHubApiError(422, path, {
      message: "GitHub returned a malformed core rate-limit budget.",
    });
  const budget = Object.freeze({
    limit,
    remaining,
    resetAt: reset * 1_000,
  });
  if (repository) githubRateLimitReservations.update(repository, budget);
  return budget;
}

/** Return the next GitHub API page path from a Link header, if present. */
export function nextGitHubPagePath(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const link = headers.link ?? headers.Link;
  if (!link) return undefined;
  for (const entry of link.split(",")) {
    const match = entry.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/i);
    if (!match?.[1] || !match[2]?.split(/\s+/).includes("next")) continue;
    try {
      const url = new URL(match[1], "https://api.github.com");
      if (
        url.protocol !== "https:" ||
        url.origin !== "https://api.github.com" ||
        url.username ||
        url.password ||
        url.hash
      )
        return undefined;
      return `${url.pathname}${url.search}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface FetchGitHubTransportOptions {
  token?: string;
  tokenProvider?: import("./github-auth.ts").GitHubTokenProvider;
  baseUrl?: string;
  userAgent?: string;
  maxTransientRetries?: number;
  fetchImpl?: typeof fetch;
  /** Repository identity enables process-wide rate accounting from headers. */
  repository?: string;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly response: unknown;

  constructor(status: number, path: string, response: unknown) {
    const detail = safeGitHubErrorDetail(response);
    super(`GitHub API ${status} for ${path}${detail ? `: ${detail}` : ""}.`);
    this.name = "GitHubApiError";
    this.status = status;
    this.path = path;
    this.response = redactGitHubResponse(response);
  }
}

export function safeGitHubErrorDetail(response: unknown): string | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response))
    return undefined;
  let message: unknown;
  try {
    message = (response as { message?: unknown }).message;
  } catch {
    return undefined;
  }
  if (typeof message !== "string" || !message.trim()) return undefined;
  const normalized = message.replace(/\s+/g, " ").trim();
  return redactGitHubTokens(normalized).slice(0, 300);
}

/** Remove credential-shaped GitHub tokens before error text is exposed. */
export function redactGitHubTokens(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "[redacted-token]");
}

type RedactedGitHubValue =
  | null
  | boolean
  | number
  | string
  | RedactedGitHubValue[]
  | { [key: string]: RedactedGitHubValue };

function redactGitHubResponse(value: unknown): RedactedGitHubValue {
  if (typeof value === "string") return redactGitHubTokens(value);
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(redactGitHubResponse);
  if (typeof value === "object") {
    const redacted: { [key: string]: RedactedGitHubValue } = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>))
      redacted[key] = redactGitHubResponse(entry);
    return redacted;
  }
  return redactGitHubTokens(String(value));
}

export class FetchGitHubTransport implements GitHubTransport {
  readonly #token?: string;
  readonly #tokenProvider?: import("./github-auth.ts").GitHubTokenProvider;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #maxTransientRetries: number;
  readonly #fetch: typeof fetch;
  readonly #repository?: string;

  constructor(options: FetchGitHubTransportOptions) {
    if (!options.token?.trim() && !options.tokenProvider)
      throw new TypeError("GitHub token or token provider is required.");
    this.#token = options.token?.trim();
    this.#tokenProvider = options.tokenProvider;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    this.#userAgent = options.userAgent ?? "forgedock-pi";
    this.#maxTransientRetries = options.maxTransientRetries ?? 5;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#repository = options.repository;
  }

  async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
    let token = this.#tokenProvider
      ? await this.#tokenProvider.get(request.signal)
      : (this.#token as string);
    let refreshedAuthentication = false;
    let transientAttempt = 0;
    while (true) {
      const response = await this.#fetch(`${this.#baseUrl}${request.path}`, {
        method: request.method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": this.#userAgent,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(request.method === "GET" ? { "Cache-Control": "no-cache" } : {}),
          ...(request.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const text = await response.text();
      const data = text ? parseJson(text) : undefined;
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const result = {
        status: response.status,
        data: data as T,
        headers,
      };
      if (this.#repository)
        githubRateLimitReservations.updateFromHeaders(
          this.#repository,
          headers,
        );
      if (
        result.status === 401 &&
        this.#tokenProvider &&
        !refreshedAuthentication
      ) {
        token = await this.#tokenProvider.refresh(request.signal);
        refreshedAuthentication = true;
        continue;
      }
      const delayMs = githubRequestRetryDelayMs(
        request,
        result,
        transientAttempt,
        Date.now(),
      );
      if (
        delayMs === undefined ||
        transientAttempt === this.#maxTransientRetries
      )
        return result;
      transientAttempt += 1;
      await retryDelay(delayMs, request.signal);
    }
  }
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function parseJson(text: string): JsonValue {
  try {
    const value: unknown = JSON.parse(text);
    return isJsonValue(value)
      ? value
      : { message: "GitHub returned a non-JSON value." };
  } catch {
    return { message: text };
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

export function githubRequestRetryDelayMs(
  request: Pick<GitHubRequest, "method" | "retryTransient">,
  response: GitHubResponse<unknown>,
  attempt: number,
  nowMs: number,
): number | undefined {
  const retryableMethod =
    request.retryTransient ??
    (request.method === "GET" || request.method === "DELETE");
  // Mutation responses can be ambiguous: a timeout/rate-limit response may
  // arrive after GitHub committed the write. Never retry one without an
  // explicit reconciliation contract from the caller.
  if (!retryableMethod) return undefined;
  return githubRetryDelayMs(response, attempt, nowMs);
}

export function githubRetryDelayMs(
  response: GitHubResponse<unknown>,
  attempt: number,
  nowMs: number,
): number | undefined {
  const message =
    response.data &&
    typeof response.data === "object" &&
    "message" in response.data &&
    typeof (response.data as { message?: unknown }).message === "string"
      ? (response.data as { message: string }).message
      : "";
  const rateLimited403 = isGitHubRateLimited(response, message);
  const retryable =
    response.status === 429 ||
    rateLimited403 ||
    [500, 502, 503, 504].includes(response.status);
  if (!retryable) return undefined;
  const retryAfterSeconds = Number(response.headers["retry-after"]);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0)
    return Math.min(60_000, Math.max(1_000, retryAfterSeconds * 1_000));
  if (response.headers["x-ratelimit-remaining"] === "0") {
    const resetSeconds = Number(response.headers["x-ratelimit-reset"]);
    if (Number.isFinite(resetSeconds))
      return Math.min(
        60 * 60_000,
        Math.max(1_000, resetSeconds * 1_000 - nowMs + 1_000),
      );
  }
  return Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
}

function isGitHubRateLimited(
  response: GitHubResponse<unknown>,
  knownMessage?: string,
): boolean {
  const message =
    knownMessage ??
    (response.data &&
    typeof response.data === "object" &&
    "message" in response.data &&
    typeof (response.data as { message?: unknown }).message === "string"
      ? (response.data as { message: string }).message
      : "");
  return (
    response.status === 403 &&
    (response.headers["x-ratelimit-remaining"] === "0" ||
      /rate limit|secondary rate|abuse detection/i.test(message))
  );
}

async function retryDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("GitHub retry aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref();
  });
}

export function requireGitHubSuccess<T>(
  response: GitHubResponse<T>,
  path: string,
  expected: readonly number[],
): T {
  if (!expected.includes(response.status))
    throw new GitHubApiError(response.status, path, response.data);
  return response.data;
}

export function repositoryApiPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part))
    throw new TypeError("Repository must have owner/name form.");
  return `/repos/${parts.map(encodeURIComponent).join("/")}`;
}
