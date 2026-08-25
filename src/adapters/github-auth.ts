import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Resolves the CLI token only at the narrow GitHub adapter boundary. */
export async function resolveGitHubToken(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
  failureMessage = "GitHub CLI authentication is required.",
): Promise<string> {
  const result = await pi.exec("gh", ["auth", "token"], {
    cwd,
    timeout: 10_000,
    ...(signal ? { signal } : {}),
  });
  const token = result.stdout.trim();
  if (result.code !== 0 || !token) throw new Error(failureMessage);
  return token;
}
