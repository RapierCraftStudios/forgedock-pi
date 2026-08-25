export interface GitHubTokenExecutor {
  exec(
    command: string,
    args: readonly string[],
    options?: {
      cwd?: string;
      timeout?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; code: number | null }>;
}

export async function resolveGitHubToken(
  executor: GitHubTokenExecutor,
  cwd: string,
  signal?: AbortSignal,
  failureMessage = "GitHub CLI authentication is required.",
): Promise<string> {
  const result = await executor.exec("gh", ["auth", "token"], {
    cwd,
    timeout: 10_000,
    ...(signal ? { signal } : {}),
  });
  const token = result.stdout.trim();
  if (result.code !== 0 || !token) throw new Error(failureMessage);
  return token;
}
