import {
  StateBranchConflictError,
} from "./github-state.ts";

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

/**
 * Thrown by a `stateCas` body when the current read cannot be applied yet
 * (e.g., the run/orchestration does not exist) and the loop should back off
 * and re-read. `exhaustedReason` becomes the final error when retries run
 * out, preserving each caller's contextual message.
 */
export class StateCasRetry extends Error {
  readonly exhaustedReason: string;
  constructor(exhaustedReason: string) {
    super(exhaustedReason);
    this.name = "StateCasRetry";
    this.exhaustedReason = exhaustedReason;
  }
}

/**
 * Shared read-apply-commit retry loop for durable state-branch journals.
 * The body performs one attempt: read current state, apply the event, and
 * commit. Throw `StateBranchConflictError` to retry after backoff (the ref
 * moved underneath us), `StateCasRetry` for a transient empty/unusable read,
 * and any other error to fail immediately.
 */
export async function stateCas<T>(
  body: (attempt: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_STATE_CAS_ATTEMPTS; attempt += 1) {
    try {
      return await body(attempt);
    } catch (error) {
      const retryable =
        error instanceof StateBranchConflictError ||
        error instanceof StateCasRetry;
      if (!retryable) throw error;
      if (attempt === MAX_STATE_CAS_ATTEMPTS) {
        if (error instanceof StateCasRetry)
          throw new Error(error.exhaustedReason);
        throw error;
      }
      await stateCasBackoff(attempt, signal);
    }
  }
  throw new Error("State CAS retry loop exited without a result.");
}
