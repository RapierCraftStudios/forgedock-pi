import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  createGitHubAppJwt,
  createGitHubTokenProvider,
  resolveGitHubToken,
} from "../../src/adapters/github-auth.ts";

function fakePi(token = "operator-token"): ExtensionAPI {
  return {
    exec: async () => ({ code: 0, stdout: `${token}\n`, stderr: "" }),
  } as unknown as ExtensionAPI;
}

test("ForgeDock bot token bypasses the operator gh context", async () => {
  const pi = {
    exec: async () => {
      throw new Error("gh should not run for configured bot auth");
    },
  } as unknown as ExtensionAPI;

  assert.equal(
    await resolveGitHubToken(pi, "/repo", undefined, {
      env: { FORGEDOCK_BOT_TOKEN: "installation-token" },
    }),
    "installation-token",
  );
});

test("GitHub App credentials mint and cache an installation token", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const now = Date.parse("2026-08-25T00:00:00.000Z");
  let exchanges = 0;
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    exchanges += 1;
    assert.match(
      String(url),
      /\/app\/installations\/installation-test\/access_tokens$/,
    );
    assert.match(
      String(
        (init?.headers as Record<string, string> | undefined)?.Authorization,
      ),
      /^Bearer [^.]+\.[^.]+\.[^.]+$/,
    );
    return new Response(
      JSON.stringify({
        token: "minted-installation-token",
        expires_at: "2026-08-25T01:00:00.000Z",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const options = {
    env: {
      FORGEDOCK_APP_PEM: "/virtual/forgedock-test.pem",
      FORGEDOCK_GITHUB_APP_ID: "app-test",
      FORGEDOCK_GITHUB_INSTALLATION_ID: "installation-test",
    },
    fetchImpl,
    now: () => now,
    readPem: async () => pem,
  };

  assert.equal(
    await resolveGitHubToken(fakePi(), "/repo", undefined, options),
    "minted-installation-token",
  );
  assert.equal(
    await resolveGitHubToken(fakePi(), "/repo", undefined, options),
    "minted-installation-token",
  );
  assert.equal(exchanges, 1);
});

test("GitHub App token provider force-refreshes and deduplicates exchanges", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const now = Date.parse("2026-08-25T02:00:00.000Z");
  let exchanges = 0;
  const fetchImpl = (async () => {
    exchanges += 1;
    await Promise.resolve();
    return new Response(
      JSON.stringify({
        token: `minted-token-${exchanges}`,
        expires_at: "2026-08-25T03:00:00.000Z",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const provider = createGitHubTokenProvider(fakePi(), "/repo", {
    env: {
      FORGEDOCK_APP_PEM: "/virtual/provider-dedupe.pem",
      FORGEDOCK_GITHUB_APP_ID: "app-provider",
      FORGEDOCK_GITHUB_INSTALLATION_ID: "installation-provider",
    },
    fetchImpl,
    now: () => now,
    readPem: async () => pem,
  });

  const initial = await Promise.all([provider.get(), provider.get()]);
  assert.deepEqual(initial, ["minted-token-1", "minted-token-1"]);
  assert.equal(exchanges, 1);
  assert.equal(await provider.refresh(), "minted-token-2");
  assert.equal(exchanges, 2);
});

test("GitHub App JWT binds the configured app and bounded lifetime", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const now = Date.parse("2026-08-25T00:00:00.000Z");
  const [, payload] = createGitHubAppJwt(pem, "4051319", now).split(".");
  const claims = JSON.parse(
    Buffer.from(payload as string, "base64url").toString("utf8"),
  ) as { iat: number; exp: number; iss: string };

  assert.equal(claims.iss, "4051319");
  assert.equal(claims.exp - claims.iat, 10 * 60);
});

test("operator gh auth requires an explicit fallback opt-in", async () => {
  assert.equal(
    await resolveGitHubToken(fakePi(), "/repo", undefined, {
      env: { FORGEDOCK_ALLOW_OPERATOR_GH: "1" },
    }),
    "operator-token",
  );
});

test("workflow auth fails closed when bot credentials are absent", async () => {
  await assert.rejects(
    resolveGitHubToken(fakePi(), "/repo", undefined, { env: {} }),
    /ForgeDock bot authentication is required/,
  );
});
