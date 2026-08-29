/** Machine-readable provenance for diagnostics produced by a verification command. */
export const VERIFICATION_DIAGNOSTIC_SCHEMA =
  "forgedock.verification-diagnostics/v1" as const;

export type DiagnosticKind =
  | "missing-host-dependency"
  | "syntax-error"
  | "changed-code"
  | "environment-unavailable"
  | "unknown";

export type FallbackStatus = "passed" | "failed" | "unavailable" | "not-run";

export interface VerificationDiagnostic {
  kind: DiagnosticKind;
  message: string;
  module?: string;
  file?: string;
  line?: number;
  blocking: boolean;
}

export interface ValidationFallback {
  /** Stable name of the tracked command or environment. */
  name: string;
  kind: "container" | "venv" | "other";
  /** Exact command attempted (or the command that should be attempted). */
  command: string;
  status: FallbackStatus;
  detail?: string;
}

export interface ValidationEnvironment {
  host?: {
    name?: string;
    available?: boolean;
    attemptedCommand?: string;
  };
  /** Fallbacks are ordered by preference; the first passing one wins. */
  fallbacks?: readonly ValidationFallback[];
  /** Convenient singular form for callers handling one configured fallback. */
  fallback?: ValidationFallback;
}

export interface SkippedVerification {
  name: string;
  reason: "environment-not-provisioned";
  environment: string;
  attemptedCommand: string;
}

export interface VerificationDiagnosticReport {
  schema: typeof VERIFICATION_DIAGNOSTIC_SCHEMA;
  outcome: "passed" | "environment-only" | "blocked";
  diagnostics: readonly VerificationDiagnostic[];
  blockingDiagnostics: readonly VerificationDiagnostic[];
  skipped: readonly SkippedVerification[];
  selectedFallback?: Pick<ValidationFallback, "name" | "kind" | "command">;
}

const MISSING_DEPENDENCY_PATTERNS = [
  /(?:ModuleNotFoundError|ImportError)\s*:\s*No module named ['\"]?([^'\"\s]+)['\"]?/i,
  /No module named ['\"]?([^'\"\s]+)['\"]?/i,
  /Import ['\"]([^'\"]+)['\"] could not be resolved/i,
  /(?:reportMissingImports|reportMissingModuleSource).*?['\"]([^'\"]+)['\"]/i,
  /Cannot find module ['\"]([^'\"]+)['\"]?/i,
  /(?:module|package) ['\"]([^'\"]+)['\"]? (?:is )?(?:missing|not found|could not be resolved)/i,
] as const;

const SYNTAX_PATTERN =
  /\b(?:SyntaxError|IndentationError|TabError|Parse error|parsing failed|unexpected token|unexpected end of input)\b/i;
const CHANGED_CODE_PATTERN =
  /\b(?:TypeError|type error|error TS\d+|mypy|pyright|argument of type|type .* is not assignable|incompatible types|has no attribute|unknown property|cannot assign)\b/i;
const LOCATION_PATTERN = /^(.*?)(?::(\d+)(?::\d+)?)?(?:\s*[-|]\s*)?(.*)$/;

/** Parse common Python and TypeScript tool output without executing anything. */
export function parseVerificationDiagnostics(
  output: string,
): VerificationDiagnostic[] {
  if (!output.trim()) return [];
  const diagnostics: VerificationDiagnostic[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const message = rawLine.trim();
    if (!message) continue;
    const dependency = MISSING_DEPENDENCY_PATTERNS.find((pattern) =>
      pattern.test(message),
    );
    const location = LOCATION_PATTERN.exec(message);
    const file = location?.[1]?.trim() || undefined;
    const line = location?.[2] ? Number(location[2]) : undefined;
    if (dependency) {
      const module = dependency.exec(message)?.[1];
      const localModule = Boolean(module && (module.startsWith(".") || module.startsWith("/")));
      diagnostics.push({
        kind: localModule ? "changed-code" : "missing-host-dependency",
        message,
        ...(module ? { module } : {}),
        ...(file && !file.includes(" ") ? { file } : {}),
        ...(line && Number.isSafeInteger(line) ? { line } : {}),
        blocking: true,
      });
      if (!localModule && CHANGED_CODE_PATTERN.test(message)) {
        diagnostics.push({
          kind: "changed-code",
          message,
          ...(file && !file.includes(" ") ? { file } : {}),
          ...(line && Number.isSafeInteger(line) ? { line } : {}),
          blocking: true,
        });
      }
      continue;
    }
    if (SYNTAX_PATTERN.test(message)) {
      diagnostics.push({
        kind: "syntax-error",
        message,
        ...(file && !file.includes(" ") ? { file } : {}),
        ...(line && Number.isSafeInteger(line) ? { line } : {}),
        blocking: true,
      });
      continue;
    }
    if (CHANGED_CODE_PATTERN.test(message)) {
      diagnostics.push({
        kind: "changed-code",
        message,
        ...(file && !file.includes(" ") ? { file } : {}),
        ...(line && Number.isSafeInteger(line) ? { line } : {}),
        blocking: true,
      });
      continue;
    }
    // Never silently turn an unrecognized non-empty failure into a pass.
    diagnostics.push({
      kind: "unknown",
      message,
      ...(file && !file.includes(" ") ? { file } : {}),
      ...(line && Number.isSafeInteger(line) ? { line } : {}),
      blocking: true,
    });
  }
  return diagnostics;
}

function configuredFallbacks(
  environment: ValidationEnvironment,
): ValidationFallback[] {
  const values = [
    ...(environment.fallbacks ?? []),
    ...(environment.fallback ? [environment.fallback] : []),
  ];
  return values.filter(
    (value, index) =>
      value &&
      typeof value.name === "string" &&
      typeof value.command === "string" &&
      values.findIndex((candidate) => candidate.name === value.name) === index,
  );
}

function missingDependencyFallback(
  environment: ValidationEnvironment,
): ValidationFallback | undefined {
  return configuredFallbacks(environment).find(
    (fallback) =>
      (fallback.kind === "container" || fallback.kind === "venv") &&
      fallback.status === "passed",
  );
}

/**
 * Classify a verification failure using only its output and declared environment.
 * A missing import is environment-only only when a declared container/venv
 * fallback passed. Without a passing fallback it remains blocking and is
 * reported as an explicitly skipped, unprovisioned check.
 */
export function classifyVerificationDiagnostics(
  diagnostics: readonly VerificationDiagnostic[],
  environment: ValidationEnvironment = {},
): VerificationDiagnosticReport {
  const missingDependencies = diagnostics.filter(
    (diagnostic) => diagnostic.kind === "missing-host-dependency",
  );
  const codeDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.kind !== "missing-host-dependency",
  );
  const fallback =
    missingDependencies.length > 0
      ? missingDependencyFallback(environment)
      : undefined;
  const skipped: SkippedVerification[] = [];
  if (missingDependencies.length > 0 && !fallback) {
    const host = environment.host;
    const environmentName =
      host?.name?.trim() || "host interpreter (dependencies unavailable)";
    const attemptedCommand =
      host?.attemptedCommand?.trim() || "verification command";
    const fallbackCandidates = configuredFallbacks(environment);
    skipped.push({
      name: "dependency-backed verification",
      reason: "environment-not-provisioned",
      environment: environmentName,
      attemptedCommand,
    });
    // A configured but unavailable fallback is useful evidence and must not
    // be represented as a successful check.
    for (const candidate of fallbackCandidates.filter(
      (candidate) => candidate.status !== "passed",
    )) {
      skipped.push({
        name: candidate.name,
        reason: "environment-not-provisioned",
        environment: `${candidate.kind}: ${candidate.name}`,
        attemptedCommand: candidate.command,
      });
    }
  }
  const environmentDiagnostics: VerificationDiagnostic[] =
    missingDependencies.length > 0 && !fallback
      ? missingDependencies.map((diagnostic) => ({
          ...diagnostic,
          kind: "environment-unavailable" as const,
          blocking: true,
        }))
      : missingDependencies.map((diagnostic) => ({
          ...diagnostic,
          blocking: false,
        }));
  const normalized = [...environmentDiagnostics, ...codeDiagnostics];
  const blockingDiagnostics = normalized.filter((diagnostic) => diagnostic.blocking);
  const outcome =
    blockingDiagnostics.length > 0
      ? "blocked"
      : missingDependencies.length > 0
        ? "environment-only"
        : "passed";
  return {
    schema: VERIFICATION_DIAGNOSTIC_SCHEMA,
    outcome,
    diagnostics: normalized,
    blockingDiagnostics,
    skipped,
    ...(fallback
      ? {
          selectedFallback: {
            name: fallback.name,
            kind: fallback.kind,
            command: fallback.command,
          },
        }
      : {}),
  };
}

export function isVerificationDiagnosticReport(
  value: unknown,
): value is VerificationDiagnosticReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<VerificationDiagnosticReport>;
  if (
    report.schema !== VERIFICATION_DIAGNOSTIC_SCHEMA ||
    !["passed", "environment-only", "blocked"].includes(String(report.outcome)) ||
    !Array.isArray(report.diagnostics) ||
    !Array.isArray(report.blockingDiagnostics) ||
    !Array.isArray(report.skipped)
  ) return false;
  const diagnosticsValid = (entries: unknown[]): boolean => entries.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const diagnostic = entry as Partial<VerificationDiagnostic>;
    return ["missing-host-dependency", "syntax-error", "changed-code", "environment-unavailable", "unknown"].includes(String(diagnostic.kind)) &&
      typeof diagnostic.message === "string" && typeof diagnostic.blocking === "boolean";
  });
  if (!diagnosticsValid(report.diagnostics) || !diagnosticsValid(report.blockingDiagnostics)) return false;
  const allDiagnostics = report.diagnostics as VerificationDiagnostic[];
  const reportedBlocking = report.blockingDiagnostics as VerificationDiagnostic[];
  if (report.outcome === "environment-only") {
    const fallback = report.selectedFallback;
    if (!fallback || typeof fallback.name !== "string" || !fallback.name.trim() ||
        typeof fallback.command !== "string" || !fallback.command.trim() ||
        (fallback.kind !== "container" && fallback.kind !== "venv")) return false;
    if (allDiagnostics.some(
      (entry) => entry.kind !== "missing-host-dependency" || entry.blocking,
    )) return false;
  }
  const blocking = allDiagnostics.filter((entry) => entry.blocking);
  if (blocking.length !== reportedBlocking.length ||
      blocking.some((entry, index) => entry.message !== reportedBlocking[index]?.message)) return false;
  if (report.outcome === "blocked") return blocking.length > 0;
  if (report.outcome === "environment-only")
    return blocking.length === 0 && report.diagnostics.some((entry) => entry.kind === "missing-host-dependency");
  return blocking.length === 0 && report.diagnostics.length === 0;
}

export function classifyVerificationOutput(
  output: string,
  environment: ValidationEnvironment = {},
  options: { failed?: boolean } = {},
): VerificationDiagnosticReport {
  const diagnostics = parseVerificationDiagnostics(output);
  if (options.failed && diagnostics.length === 0) {
    diagnostics.push({
      kind: "unknown",
      message: "Verification command failed without diagnostic output.",
      blocking: true,
    });
  }
  return classifyVerificationDiagnostics(diagnostics, environment);
}

export function formatSkippedVerification(
  skipped: SkippedVerification,
): string {
  return `SKIPPED — environment not provisioned (environment: ${skipped.environment}; attempted command: ${skipped.attemptedCommand})`;
}