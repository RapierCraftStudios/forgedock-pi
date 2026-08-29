import type { VerificationResult } from "../core/review.ts";

export type TestGateVerdict = "BLOCK" | "PASS" | "SKIP";

export interface TestGateResult {
  verdict: TestGateVerdict;
  reason?: string;
}

/** Parse only the authoritative marker emitted by the packaged test-gate skill. */
export function parseTestGateResult(value: unknown): TestGateResult | undefined {
  if (typeof value !== "string") return undefined;
  const matches = [...value.matchAll(/FORGE:TEST_GATE:RESULT=(BLOCK|PASS|SKIP)/g)];
  const verdict = matches.at(-1)?.[1] as TestGateVerdict | undefined;
  if (!verdict) return undefined;
  const reason = value.match(
    /FORGE:TEST_GATE:(?:BLOCK|PASS|SKIP)\|reason=([^\s\n]+)/,
  )?.[1];
  return reason ? { verdict, reason } : { verdict };
}

/**
 * Convert a nested test-gate result into a review check. An absent marker is a
 * failed required check, while an explicit SKIP remains visible and non-blocking
 * exactly as the original staging specification defines it.
 */
export function testGateVerification(
  value: unknown,
): VerificationResult {
  const result = parseTestGateResult(value);
  if (!result) {
    return {
      name: "test-gate",
      required: true,
      status: "failed",
      exitCode: 1,
    };
  }
  if (result.verdict === "PASS") {
    return { name: "test-gate", required: true, status: "passed" };
  }
  if (result.verdict === "SKIP") {
    return { name: "test-gate", required: false, status: "skipped" };
  }
  return { name: "test-gate", required: true, status: "failed", exitCode: 1 };
}
