export interface GitHubRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Readonly<Record<string, string>>;
}

export interface GitHubTransport {
  request<T>(request: GitHubRequest): Promise<GitHubResponse<T>>;
}

export interface FetchGitHubTransportOptions {
  token: string;
  baseUrl?: string;
  userAgent?: string;
  maxTransientRetries?: number;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly response: unknown;

  constructor(status: number, path: string, response: unknown) {
    super(`GitHub API ${status} for ${path}.`);
    this.name = "GitHubApiError";
    this.status = status;
    this.path = path;
    this.response = response;
  }
}

export class FetchGitHubTransport implements GitHubTransport {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #maxTransientRetries: number;

  constructor(options: FetchGitHubTransportOptions) {
    if (!options.token.trim())
      throw new TypeError("GitHub token must be non-empty.");
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    this.#userAgent = options.userAgent ?? "forgedock-pi";
    this.#maxTransientRetries = options.maxTransientRetries ?? 5;
  }

  async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
    for (
      let attempt = 0;
      attempt <= this.#maxTransientRetries;
      attempt += 1
    ) {
      const response = await fetch(`${this.#baseUrl}${request.path}`, {
        method: request.method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "User-Agent": this.#userAgent,
          "X-GitHub-Api-Version": "2022-11-28",
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
      const delayMs = githubRetryDelayMs(result, attempt, Date.now());
      if (
        delayMs === undefined ||
        attempt === this.#maxTransientRetries
      )
        return result;
      await retryDelay(delayMs, request.signal);
    }
    throw new Error("GitHub retry loop exhausted unexpectedly.");
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

export function githubRetryDelayMs(
  response: GitHubResponse<unknown>,
  attempt: number,
  nowMs: number,
): number | undefined {
  const message =
    response.data && typeof response.data === "object" &&
    "message" in response.data &&
    typeof (response.data as { message?: unknown }).message === "string"
      ? (response.data as { message: string }).message
      : "";
  const rateLimited403 =
    response.status === 403 &&
    (response.headers["x-ratelimit-remaining"] === "0" ||
      /rate limit|secondary rate|abuse detection/i.test(message));
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
        60_000,
        Math.max(1_000, resetSeconds * 1_000 - nowMs + 1_000),
      );
  }
  return Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
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
