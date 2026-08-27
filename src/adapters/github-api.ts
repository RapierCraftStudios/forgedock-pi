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

export async function readGitHubCoreRateLimit(
  transport: GitHubTransport,
  signal?: AbortSignal,
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
  return Object.freeze({
    limit,
    remaining,
    resetAt: reset * 1_000,
  });
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
    this.response = response;
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
  return normalized
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .slice(0, 300);
}

export class FetchGitHubTransport implements GitHubTransport {
  readonly #token?: string;
  readonly #tokenProvider?: import("./github-auth.ts").GitHubTokenProvider;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #maxTransientRetries: number;
  readonly #fetch: typeof fetch;

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
