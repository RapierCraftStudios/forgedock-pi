import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { FetchGitHubTransport, repositoryApiPath, type GitHubRequest } from "./adapters/github-api.ts";
import { createGitHubTokenProvider } from "./adapters/github-auth.ts";
import { preflightGitHubCapabilities } from "./adapters/github-capabilities.ts";
import { loadForgeYaml, type ForgeYamlConfig } from "./adapters/forge-yaml.ts";

const githubMethodSchema = Type.String({
  description: "GitHub REST method: GET, POST, PATCH, PUT, or DELETE",
});

function repositoryRoot(cwd: string, configured?: string): string {
  return resolve(cwd, configured?.trim() || ".");
}

function forgeConfigIdentity(config: ForgeYamlConfig): string {
  return JSON.stringify({
    repository: config.repository,
    project: config.project,
    paths: config.paths,
    branches: config.branches,
    agents: config.agents,
  });
}

function githubMethod(value: string): GitHubRequest["method"] {
  const normalized = value.toUpperCase();
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(normalized))
    throw new TypeError("method must be GET, POST, PATCH, PUT, or DELETE");
  return normalized as GitHubRequest["method"];
}

export function assertForgeRepositoryApiPath(path: string, repository: string): string {
  const normalized = path.trim();
  const root = repositoryApiPath(repository);
  if (!normalized.startsWith("/") || normalized.startsWith("//") || normalized.includes("#"))
    throw new TypeError("path must be a GitHub REST path, not a URL");
  const pathname = normalized.split("?", 1)[0]!;
  for (const rawSegment of pathname.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      throw new TypeError("path contains invalid percent encoding");
    }
    if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))
      throw new Error("GitHub path cannot contain dot or encoded path segments.");
  }
  const canonical = new URL(normalized, "https://api.github.com");
  if (canonical.origin !== "https://api.github.com" || canonical.pathname !== pathname)
    throw new Error("GitHub path normalization changed repository scope.");
  if (pathname !== root && !pathname.startsWith(`${root}/`))
    throw new Error(`GitHub path must remain scoped to ${repository}.`);
  return normalized;
}

export function assertForgeGitHubOperationAllowed(
  method: GitHubRequest["method"],
  path: string,
  repository: string,
): void {
  if (method === "GET") return;
  const pathname = path.split("?", 1)[0]!;
  const root = repositoryApiPath(repository);
  const relative = pathname.slice(root.length);
  const allowed =
    (method === "POST" && [
      /^\/issues$/,
      /^\/issues\/[1-9]\d*\/comments$/,
      /^\/issues\/[1-9]\d*\/labels$/,
      /^\/pulls$/,
      /^\/pulls\/[1-9]\d*\/reviews$/,
    ].some((pattern) => pattern.test(relative))) ||
    (method === "PATCH" && /^\/(?:issues|pulls)\/[1-9]\d*$/.test(relative)) ||
    (method === "PUT" && [
      /^\/issues\/[1-9]\d*\/labels$/,
      /^\/pulls\/[1-9]\d*\/merge$/,
    ].some((pattern) => pattern.test(relative))) ||
    (method === "DELETE" && /^\/issues\/[1-9]\d*\/labels\/[^/]+$/.test(relative));
  if (!allowed)
    throw new Error(`GitHub ${method} ${relative || "/"} is outside the ForgeDock operation allowlist.`);
}

function boundedJson(value: unknown): { text: string; truncated: boolean } {
  const serialized = JSON.stringify(value, null, 2);
  const bounded = truncateHead(serialized, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return { text: bounded.content, truncated: bounded.truncated };
}

/** Register deterministic config/auth leaves used by visible and nested coordinators. */
export function registerForgeRuntimeTools(pi: ExtensionAPI): void {
  const preflightedRoots = new Map<string, string>();
  pi.registerTool({
    name: "forgedock_preflight",
    label: "ForgeDock Preflight",
    description:
      "Load and validate forge.yaml without yq, mint/refresh the configured ForgeDock token, and verify repository-scoped GitHub capabilities without calling /user or mutating GitHub.",
    promptSnippet: "Validate ForgeDock configuration and repository-scoped GitHub capabilities before workflow side effects",
    promptGuidelines: [
      "Use forgedock_preflight before any ForgeDock GitHub write or implementation phase; a missing tool or failed capability is a hard gate.",
    ],
    parameters: Type.Object({
      repositoryRoot: Type.Optional(
        Type.String({ description: "Repository root containing forge.yaml; defaults to the current working directory" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const root = await realpath(repositoryRoot(ctx.cwd, params.repositoryRoot));
      const config = await loadForgeYaml(root);
      const tokenProvider = createGitHubTokenProvider(pi, root);
      const transport = new FetchGitHubTransport({
        tokenProvider,
        repository: config.repository,
      });
      const capabilities = await preflightGitHubCapabilities({
        repository: config.repository,
        transport,
        tokenProvider,
        signal,
      });
      preflightedRoots.set(root, forgeConfigIdentity(config));
      const result = { schema: "forgedock.preflight/v1", config, capabilities };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { schema: result.schema, repository: config.repository, tokenSource: capabilities.tokenSource },
      };
    },
  });

  pi.registerTool({
    name: "forgedock_github",
    label: "ForgeDock GitHub",
    description:
      "Execute one repository-scoped GitHub REST operation with the ForgeDock token provider. Authentication refreshes automatically and token material is never returned.",
    promptSnippet: "Perform repository-scoped GitHub API reads and writes with ForgeDock App identity",
    promptGuidelines: [
      "Use forgedock_github, not raw gh authentication probes or gh api, for ForgeDock GitHub operations after forgedock_preflight passes.",
      "forgedock_github paths must target only the repository resolved from forge.yaml.",
    ],
    parameters: Type.Object({
      repositoryRoot: Type.Optional(
        Type.String({ description: "Repository root containing forge.yaml; defaults to the current working directory" }),
      ),
      method: githubMethodSchema,
      path: Type.String({ description: "Repository-scoped GitHub REST path beginning with /repos/{owner}/{repo}" }),
      body: Type.Optional(Type.Unknown()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const root = await realpath(repositoryRoot(ctx.cwd, params.repositoryRoot));
      const expectedIdentity = preflightedRoots.get(root);
      if (!expectedIdentity)
        throw new Error("forgedock_preflight must succeed for this repository before GitHub operations.");
      const config = await loadForgeYaml(root);
      if (forgeConfigIdentity(config) !== expectedIdentity)
        throw new Error("forge.yaml changed after preflight; run forgedock_preflight again.");
      const method = githubMethod(params.method);
      const path = assertForgeRepositoryApiPath(params.path, config.repository);
      assertForgeGitHubOperationAllowed(method, path, config.repository);
      const tokenProvider = createGitHubTokenProvider(pi, root);
      const transport = new FetchGitHubTransport({
        tokenProvider,
        repository: config.repository,
      });
      const response = await transport.request({
        method,
        path,
        ...(params.body === undefined ? {} : { body: params.body }),
        ...(method === "GET" ? { retryTransient: true } : {}),
        signal,
      });
      const output = boundedJson({ status: response.status, data: response.data });
      return {
        content: [{
          type: "text",
          text: output.truncated
            ? `${output.text}\n\n[GitHub response truncated to ${DEFAULT_MAX_BYTES} bytes / ${DEFAULT_MAX_LINES} lines]`
            : output.text,
        }],
        details: { status: response.status, repository: config.repository, truncated: output.truncated },
      };
    },
  });
}
