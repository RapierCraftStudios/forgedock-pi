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

  constructor(options: FetchGitHubTransportOptions) {
    if (!options.token.trim())
      throw new TypeError("GitHub token must be non-empty.");
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    this.#userAgent = options.userAgent ?? "forgedock-pi";
  }

  async request<T>(request: GitHubRequest): Promise<GitHubResponse<T>> {
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
    return { status: response.status, data: data as T, headers };
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
