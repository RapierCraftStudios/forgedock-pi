export const MAX_STATE_CAS_ATTEMPTS = 24;

export async function stateCasBackoff(
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  const ceilingMs = Math.min(5_000, 50 * 2 ** Math.min(attempt, 7));
  const delayMs =
    Math.floor(ceilingMs / 2) +
    Math.floor(Math.random() * Math.ceil(ceilingMs / 2));
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("CAS retry aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
