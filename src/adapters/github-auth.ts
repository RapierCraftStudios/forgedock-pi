import { createSign } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_APP_ID = "4051319";
const DEFAULT_INSTALLATION_ID = "144998831";
const REFRESH_SKEW_MS = 5 * 60_000;

export interface GitHubInstallationTokenMetadata {
  readonly repositorySelection: "all" | "selected";
  readonly permissions: Readonly<Record<string, string>>;
}

interface CachedInstallationToken {
  key: string;
  token: string;
  expiresAt: number;
  metadata: GitHubInstallationTokenMetadata;
}

const cachedInstallationTokens = new Map<string, CachedInstallationToken>();
const installationTokenExchanges = new Map<
  string,
  Promise<CachedInstallationToken>
>();

export interface GitHubTokenResolverOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  readPem?: (path: string) => Promise<string>;
}

export interface GitHubTokenProvider {
  get(signal?: AbortSignal): Promise<string>;
  refresh(signal?: AbortSignal): Promise<string>;
  getInstallationMetadata?(
    signal?: AbortSignal,
  ): Promise<GitHubInstallationTokenMetadata>;
  /** Credential class is metadata only; token material is never exposed in logs. */
  readonly source?: "installation" | "bot-token" | "operator";
}

export interface GhAuthAccount {
  readonly host: string;
  readonly login: string;
  readonly active: boolean;
}

/** Select active gh identities only; inactive accounts are never candidates. */
export function selectActiveGhAccount(accounts: readonly GhAuthAccount[], host = "github.com"): GhAuthAccount | undefined {
  return accounts.find((account) => account.host === host && account.active);
}

export function createGitHubTokenProvider(
  pi: ExtensionAPI,
  cwd: string,
  options: GitHubTokenResolverOptions = {},
): GitHubTokenProvider {
  const env = options.env ?? process.env;
  const source: GitHubTokenProvider["source"] = env.FORGEDOCK_BOT_TOKEN?.trim()
    ? "bot-token"
    : env.FORGEDOCK_APP_PEM?.trim() || (options.env === undefined && existsSync(join(homedir(), ".config", "forgedock", "app.pem")))
      ? "installation"
      : "operator";
  return Object.freeze({
    source,
    get: (signal?: AbortSignal) =>
      resolveGitHubTokenInternal(pi, cwd, signal, options, false),
    refresh: (signal?: AbortSignal) =>
      resolveGitHubTokenInternal(pi, cwd, signal, options, true),
    ...(source === "installation"
      ? {
          getInstallationMetadata: (signal?: AbortSignal) =>
            resolveGitHubInstallationMetadata(pi, cwd, signal, options),
        }
      : {}),
  });
}

export async function resolveGitHubToken(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
  options: GitHubTokenResolverOptions = {},
): Promise<string> {
  return resolveGitHubTokenInternal(pi, cwd, signal, options, false);
}

async function resolveGitHubInstallationMetadata(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
  options: GitHubTokenResolverOptions,
): Promise<GitHubInstallationTokenMetadata> {
  await resolveGitHubTokenInternal(pi, cwd, signal, options, false);
  const credentials = installationCredentials(options);
  if (!credentials)
    throw new Error("ForgeDock GitHub App installation metadata is unavailable.");
  const cached = cachedInstallationTokens.get(
    installationTokenKey(credentials),
  );
  if (!cached)
    throw new Error("ForgeDock GitHub App installation metadata is unavailable.");
  return cached.metadata;
}

async function resolveGitHubTokenInternal(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
  options: GitHubTokenResolverOptions,
  forceRefresh: boolean,
): Promise<string> {
  const env = options.env ?? process.env;
  const configuredToken = env.FORGEDOCK_BOT_TOKEN?.trim();
  if (configuredToken) return configuredToken;

  const credentials = installationCredentials(options);
  if (credentials) {
    const installation = await resolveInstallationToken({
      ...credentials,
      signal,
      fetchImpl: options.fetchImpl ?? fetch,
      now: options.now ?? Date.now,
      readPem: options.readPem ?? ((path) => readFile(path, "utf8")),
      forceRefresh,
    });
    return installation.token;
  }

  if (env.FORGEDOCK_ALLOW_OPERATOR_GH !== "1")
    throw new Error(
      "ForgeDock bot authentication is required. Configure FORGEDOCK_APP_PEM or FORGEDOCK_BOT_TOKEN. Set FORGEDOCK_ALLOW_OPERATOR_GH=1 only for an explicit local fallback.",
    );

  const result = await pi.exec("gh", ["auth", "token"], {
    cwd,
    timeout: 30_000,
    ...(signal ? { signal } : {}),
  });
  if (result.code !== 0 || !result.stdout.trim())
    throw new Error(
      "ForgeDock GitHub authentication is unavailable. Configure FORGEDOCK_APP_PEM for the ForgeDock App, FORGEDOCK_BOT_TOKEN for a managed installation token, or repair gh authentication.",
    );
  return result.stdout.trim();
}

function installationCredentials(
  options: GitHubTokenResolverOptions,
): { pemPath: string; appId: string; installationId: string } | undefined {
  const env = options.env ?? process.env;
  const defaultPemPath = join(homedir(), ".config", "forgedock", "app.pem");
  const pemPath =
    env.FORGEDOCK_APP_PEM?.trim() ||
    (options.env === undefined && existsSync(defaultPemPath)
      ? defaultPemPath
      : undefined);
  if (!pemPath) return undefined;
  return {
    pemPath,
    appId: env.FORGEDOCK_GITHUB_APP_ID?.trim() || DEFAULT_APP_ID,
    installationId:
      env.FORGEDOCK_GITHUB_INSTALLATION_ID?.trim() || DEFAULT_INSTALLATION_ID,
  };
}

function installationTokenKey(input: {
  pemPath: string;
  appId: string;
  installationId: string;
}): string {
  return `${input.pemPath}\0${input.appId}\0${input.installationId}`;
}

export function createGitHubAppJwt(
  pem: string,
  appId: string,
  nowMs = Date.now(),
): string {
  const now = Math.floor(nowMs / 1_000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(pem, "base64url")}`;
}

async function resolveInstallationToken(input: {
  pemPath: string;
  appId: string;
  installationId: string;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
  now: () => number;
  readPem: (path: string) => Promise<string>;
  forceRefresh?: boolean;
}): Promise<CachedInstallationToken> {
  const key = installationTokenKey(input);
  const now = input.now();
  const cached = cachedInstallationTokens.get(key);
  if (
    !input.forceRefresh &&
    cached &&
    cached.expiresAt - REFRESH_SKEW_MS > now
  )
    return cached;

  const inFlight = installationTokenExchanges.get(key);
  if (inFlight) return inFlight;
  const exchange = mintInstallationToken(input, key, now);
  installationTokenExchanges.set(key, exchange);
  try {
    return await exchange;
  } finally {
    if (installationTokenExchanges.get(key) === exchange)
      installationTokenExchanges.delete(key);
  }
}

async function mintInstallationToken(
  input: {
    pemPath: string;
    appId: string;
    installationId: string;
    signal?: AbortSignal;
    fetchImpl: typeof fetch;
    readPem: (path: string) => Promise<string>;
  },
  key: string,
  now: number,
): Promise<CachedInstallationToken> {
  const pem = await input.readPem(input.pemPath).catch((error) => {
    throw new Error(
      `Unable to read FORGEDOCK_APP_PEM: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const jwt = createGitHubAppJwt(pem, input.appId, now);
  const response = await input.fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "forgedock-pi",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    token?: unknown;
    expires_at?: unknown;
    permissions?: unknown;
    repository_selection?: unknown;
    message?: unknown;
  };
  if (!response.ok || typeof body.token !== "string" || !body.token.trim()) {
    const message =
      typeof body.message === "string"
        ? body.message
        : `HTTP ${response.status}`;
    throw new Error(`ForgeDock GitHub App token exchange failed: ${message}`);
  }
  const expiresAt =
    typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now)
    throw new Error("ForgeDock GitHub App returned an invalid token expiry.");
  if (
    body.repository_selection !== "all" &&
    body.repository_selection !== "selected"
  )
    throw new Error(
      "ForgeDock GitHub App returned invalid installation repository metadata.",
    );
  if (
    !body.permissions ||
    typeof body.permissions !== "object" ||
    Array.isArray(body.permissions)
  )
    throw new Error(
      "ForgeDock GitHub App returned invalid installation permission metadata.",
    );
  const permissions: Record<string, string> = {};
  for (const [name, permission] of Object.entries(
    body.permissions as Record<string, unknown>,
  )) {
    if (
      permission !== "read" &&
      permission !== "write" &&
      permission !== "admin"
    )
      throw new Error(
        `ForgeDock GitHub App returned invalid '${name}' installation permission metadata.`,
      );
    permissions[name] = permission;
  }

  const installation: CachedInstallationToken = {
    key,
    token: body.token.trim(),
    expiresAt,
    metadata: {
      repositorySelection: body.repository_selection,
      permissions: Object.freeze(permissions),
    },
  };
  cachedInstallationTokens.set(key, installation);
  return installation;
}
