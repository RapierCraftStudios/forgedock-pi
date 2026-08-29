import {
  repositoryApiPath,
  type GitHubTransport,
} from "./github-api.ts";
import type { GitHubTokenProvider } from "./github-auth.ts";

export interface GitHubCapabilityPreflightResult {
  readonly repository: string;
  readonly tokenSource: "installation" | "bot-token" | "operator";
  readonly repositoryRead: true;
  readonly repositoryWrite: true;
  readonly installation?: GitHubInstallationMetadata;
}

export interface GitHubInstallationMetadata {
  readonly id?: number;
  readonly repositorySelection?: "all" | "selected";
  readonly repositories?: readonly string[];
  readonly permissions: Readonly<Record<string, string>>;
}

export class GitHubCapabilityError extends Error {
  readonly capability: "repository-read" | "repository-write" | "installation-metadata";
  readonly path: string;
  constructor(
    capability: GitHubCapabilityError["capability"],
    path: string,
    message: string,
  ) {
    super(`ForgeDock GitHub capability failure: ${message}`);
    this.name = "GitHubCapabilityError";
    this.capability = capability;
    this.path = path;
  }
}

/**
 * Verify only capabilities needed by ForgeDock. This deliberately does not
 * call /user: installation tokens do not have a user identity, and an
 * inactive operator gh account must not become the workflow identity.
 */
export async function preflightGitHubCapabilities(input: {
  repository: string;
  transport: GitHubTransport;
  tokenProvider?: GitHubTokenProvider;
  tokenSource?: "installation" | "bot-token" | "operator";
  signal?: AbortSignal;
}): Promise<GitHubCapabilityPreflightResult> {
  const apiRoot = repositoryApiPath(input.repository);
  const repoPath = apiRoot;
  const repoResponse = await input.transport.request<GitHubRepositoryResponse>({
    method: "GET",
    path: repoPath,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (repoResponse.status !== 200) {
    throw new GitHubCapabilityError(
      "repository-read",
      repoPath,
      `repository read permission is unavailable (${repoResponse.status}).`,
    );
  }
  const repo = repoResponse.data;
  if (!repo || typeof repo !== "object" || Array.isArray(repo)) {
    throw new GitHubCapabilityError(
      "repository-read",
      repoPath,
      "repository read response is malformed.",
    );
  }
  const source = input.tokenSource ?? input.tokenProvider?.source ?? "operator";
  const collaboratorPermissions = repo.permissions;
  const collaboratorCanRead = collaboratorPermissions?.pull === true;
  const collaboratorCanWrite =
    collaboratorPermissions?.push === true ||
    collaboratorPermissions?.maintain === true ||
    collaboratorPermissions?.admin === true;

  if (
    source === "operator" ||
    (source === "bot-token" && collaboratorCanRead && collaboratorCanWrite)
  ) {
    if (!collaboratorCanRead) {
      throw new GitHubCapabilityError(
        "repository-read",
        repoPath,
        "repository read permission is unavailable.",
      );
    }
    if (!collaboratorCanWrite) {
      throw new GitHubCapabilityError(
        "repository-write",
        repoPath,
        "nonmutating repository write permission is unavailable.",
      );
    }
    return {
      repository: input.repository,
      tokenSource: source,
      repositoryRead: true,
      repositoryWrite: true,
    };
  }

  const installationPath = "/installation/repositories";
  const metadata = await input.tokenProvider?.getInstallationMetadata?.(
    input.signal,
  );
  if (!metadata) {
    throw new GitHubCapabilityError(
      "installation-metadata",
      installationPath,
      "installation permission metadata is unavailable for this token source.",
    );
  }
  let installation: GitHubInstallationMetadata = {
    repositorySelection: metadata.repositorySelection,
    permissions: metadata.permissions,
  };
  if (installation.repositorySelection === "selected") {
    const repositoriesPath = `${installationPath}?per_page=100`;
    const repositoriesResponse = await input.transport.request<{
      repositories?: unknown;
    }>({
      method: "GET",
      path: repositoriesPath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      repositoriesResponse.status !== 200 ||
      !repositoriesResponse.data ||
      typeof repositoriesResponse.data !== "object"
    )
      throw new GitHubCapabilityError(
        "installation-metadata",
        repositoriesPath,
        "installation repository metadata is unavailable.",
      );
    installation = {
      ...installation,
      repositories: parseRepositories(
        (repositoriesResponse.data as { repositories?: unknown })
          .repositories,
        repositoriesPath,
      ),
    };
  }
  if (
    installation.repositorySelection === "selected" &&
    !installation.repositories?.includes(input.repository.toLowerCase())
  ) {
    throw new GitHubCapabilityError(
      "installation-metadata",
      installationPath,
      `installation is not authorized for repository ${input.repository}.`,
    );
  }
  const contents = installation.permissions.contents;
  const issues = installation.permissions.issues;
  const pullRequests = installation.permissions.pull_requests;
  if (contents !== "write" || issues !== "write" || pullRequests !== "write") {
    throw new GitHubCapabilityError(
      "repository-write",
      installationPath,
      "installation lacks required contents/issues/pull_requests write permissions.",
    );
  }
  return {
    repository: input.repository,
    tokenSource: source,
    repositoryRead: true,
    repositoryWrite: true,
    installation,
  };
}

/** Alias used by coordinator seams that call this operation an auth check. */
export const assertGitHubCapabilities = preflightGitHubCapabilities;

interface GitHubRepositoryResponse {
  permissions?: {
    pull?: unknown;
    push?: unknown;
    maintain?: unknown;
    admin?: unknown;
  };
}
function parseRepositories(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new GitHubCapabilityError("installation-metadata", path, "installation repositories are malformed.");
  const names = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as { full_name?: unknown }).full_name !== "string")
      throw new GitHubCapabilityError("installation-metadata", path, "installation repository metadata is malformed.");
    return (entry as { full_name: string }).full_name.toLowerCase();
  });
  return Object.freeze([...new Set(names)]);
}
