import { createSign } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_APP_ID = "4051319";
const DEFAULT_INSTALLATION_ID = "144998831";
const REFRESH_SKEW_MS = 5 * 60_000;

interface CachedInstallationToken {
  key: string;
  token: string;
  expiresAt: number;
}

let cachedInstallationToken: CachedInstallationToken | undefined;
const installationTokenExchanges = new Map<string, Promise<string>>();

export interface GitHubTokenResolverOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  readPem?: (path: string) => Promise<string>;
}

export interface GitHubTokenProvider {
  get(signal?: AbortSignal): Promise<string>;
  refresh(signal?: AbortSignal): Promise<string>;
}

export function createGitHubTokenProvider(
  pi: ExtensionAPI,
  cwd: string,
  options: GitHubTokenResolverOptions = {},
): GitHubTokenProvider {
  return Object.freeze({
    get: (signal?: AbortSignal) =>
      resolveGitHubTokenInternal(pi, cwd, signal, options, false),
    refresh: (signal?: AbortSignal) =>
      resolveGitHubTokenInternal(pi, cwd, signal, options, true),
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

  const defaultPemPath = join(homedir(), ".config", "forgedock", "app.pem");
  const pemPath =
    env.FORGEDOCK_APP_PEM?.trim() ||
    (options.env === undefined && existsSync(defaultPemPath)
      ? defaultPemPath
      : undefined);
  if (pemPath) {
    return resolveInstallationToken({
      pemPath,
      appId: env.FORGEDOCK_GITHUB_APP_ID?.trim() || DEFAULT_APP_ID,
      installationId:
        env.FORGEDOCK_GITHUB_INSTALLATION_ID?.trim() || DEFAULT_INSTALLATION_ID,
      signal,
      fetchImpl: options.fetchImpl ?? fetch,
      now: options.now ?? Date.now,
      readPem: options.readPem ?? ((path) => readFile(path, "utf8")),
      forceRefresh,
    });
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
}): Promise<string> {
  const key = `${input.pemPath}\0${input.appId}\0${input.installationId}`;
  const now = input.now();
  if (
    !input.forceRefresh &&
    cachedInstallationToken?.key === key &&
    cachedInstallationToken.expiresAt - REFRESH_SKEW_MS > now
  )
    return cachedInstallationToken.token;

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
): Promise<string> {
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

  cachedInstallationToken = {
    key,
    token: body.token.trim(),
    expiresAt,
  };
  return cachedInstallationToken.token;
}
