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
  name: string;
  kind: "container" | "venv" | "other";
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
  /** Fallbacks are ordered by preference; the first passing one is selected. */
  fallbacks?: readonly ValidationFallback[];
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
export function parseVerificationDiagnostics(output: string): VerificationDiagnostic[] {
  if (!output.trim()) return [];
  const diagnostics: VerificationDiagnostic[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const message = rawLine.trim();
    if (!message) continue;
    const dependency = MISSING_DEPENDENCY_PATTERNS.find((pattern) => pattern.test(message));
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
      // A tool can report both an unresolved package and a real type/syntax
      // failure on the same line. Keep the latter as a blocker.
      if (!localModule && (CHANGED_CODE_PATTERN.test(message) || SYNTAX_PATTERN.test(message))) {
        diagnostics.push({
          kind: SYNTAX_PATTERN.test(message) ? "syntax-error" : "changed-code",
          message,
          ...(file && !file.includes(" ") ? { file } : {}),
          ...(line && Number.isSafeInteger(line) ? { line } : {}),
          blocking: true,
        });
      }
      continue;
    }
    if (SYNTAX_PATTERN.test(message)) {
      diagnostics.push({ kind: "syntax-error", message, ...(file && !file.includes(" ") ? { file } : {}), ...(line && Number.isSafeInteger(line) ? { line } : {}), blocking: true });
    } else if (CHANGED_CODE_PATTERN.test(message)) {
      diagnostics.push({ kind: "changed-code", message, ...(file && !file.includes(" ") ? { file } : {}), ...(line && Number.isSafeInteger(line) ? { line } : {}), blocking: true });
    } else {
      diagnostics.push({ kind: "unknown", message, ...(file && !file.includes(" ") ? { file } : {}), ...(line && Number.isSafeInteger(line) ? { line } : {}), blocking: true });
    }
  }
  return diagnostics;
}

function configuredFallbacks(environment: ValidationEnvironment): ValidationFallback[] {
  const values = [...(environment.fallbacks ?? []), ...(environment.fallback ? [environment.fallback] : [])];
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || typeof value.name !== "string" || !value.name.trim() || typeof value.command !== "string" || !value.command.trim() || seen.has(value.name)) return false;
    seen.add(value.name);
    return true;
  });
}

function missingDependencyFallback(environment: ValidationEnvironment): ValidationFallback | undefined {
  return configuredFallbacks(environment).find(
    (fallback) => (fallback.kind === "container" || fallback.kind === "venv") && fallback.status === "passed",
  );
}

/** Classify output; only a passing declared container/venv can clear host-import noise. */
export function classifyVerificationDiagnostics(
  diagnostics: readonly VerificationDiagnostic[],
  environment: ValidationEnvironment = {},
): VerificationDiagnosticReport {
  const missing = diagnostics.filter((entry) => entry.kind === "missing-host-dependency");
  const remaining = diagnostics.filter((entry) => entry.kind !== "missing-host-dependency");
  const fallback = missing.length ? missingDependencyFallback(environment) : undefined;
  const skipped: SkippedVerification[] = [];
  if (missing.length && !fallback) {
    skipped.push({
      name: "dependency-backed verification",
      reason: "environment-not-provisioned",
      environment: environment.host?.name?.trim() || "host interpreter (dependencies unavailable)",
      attemptedCommand: environment.host?.attemptedCommand?.trim() || "verification command",
    });
    for (const candidate of configuredFallbacks(environment).filter((entry) => entry.status !== "passed")) {
      skipped.push({
        name: candidate.name,
        reason: "environment-not-provisioned",
        environment: `${candidate.kind}: ${candidate.name}`,
        attemptedCommand: candidate.command,
      });
    }
  }
  const environmentDiagnostics = missing.length && !fallback
    ? missing.map((entry) => ({ ...entry, kind: "environment-unavailable" as const, blocking: true }))
    : missing.map((entry) => ({ ...entry, blocking: false }));
  const normalized = [...environmentDiagnostics, ...remaining];
  const blockingDiagnostics = normalized.filter((entry) => entry.blocking);
  const outcome = blockingDiagnostics.length
    ? "blocked"
    : missing.length
      ? "environment-only"
      : "passed";
  return {
    schema: VERIFICATION_DIAGNOSTIC_SCHEMA,
    outcome,
    diagnostics: normalized,
    blockingDiagnostics,
    skipped,
    ...(fallback ? { selectedFallback: { name: fallback.name, kind: fallback.kind, command: fallback.command } } : {}),
  };
}

export function isVerificationDiagnosticReport(value: unknown): value is VerificationDiagnosticReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<VerificationDiagnosticReport>;
  if (report.schema !== VERIFICATION_DIAGNOSTIC_SCHEMA || !["passed", "environment-only", "blocked"].includes(String(report.outcome)) || !Array.isArray(report.diagnostics) || !Array.isArray(report.blockingDiagnostics) || !Array.isArray(report.skipped)) return false;
  const validDiagnostic = (entry: unknown): entry is VerificationDiagnostic => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const diagnostic = entry as Partial<VerificationDiagnostic>;
    return ["missing-host-dependency", "syntax-error", "changed-code", "environment-unavailable", "unknown"].includes(String(diagnostic.kind)) && typeof diagnostic.message === "string" && Boolean(diagnostic.message.trim()) && typeof diagnostic.blocking === "boolean";
  };
  const validSkipped = (entry: unknown): entry is SkippedVerification => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const skipped = entry as Partial<SkippedVerification>;
    return typeof skipped.name === "string" && Boolean(skipped.name.trim()) &&
      skipped.reason === "environment-not-provisioned" &&
      typeof skipped.environment === "string" && Boolean(skipped.environment.trim()) &&
      typeof skipped.attemptedCommand === "string" && Boolean(skipped.attemptedCommand.trim());
  };
  if (!report.diagnostics.every(validDiagnostic) || !report.blockingDiagnostics.every(validDiagnostic) || !report.skipped.every(validSkipped)) return false;
  if (report.selectedFallback !== undefined) {
    const fallback = report.selectedFallback;
    if (!fallback || typeof fallback !== "object" || Array.isArray(fallback) ||
      typeof fallback.name !== "string" || !fallback.name.trim() ||
      typeof fallback.command !== "string" || !fallback.command.trim() ||
      !["container", "venv", "other"].includes(fallback.kind)) return false;
  }
  const diagnostics = report.diagnostics as VerificationDiagnostic[];
  const blocking = diagnostics.filter((entry) => entry.blocking);
  const reported = report.blockingDiagnostics as VerificationDiagnostic[];
  if (blocking.length !== reported.length || blocking.some((entry, index) => entry.message !== reported[index]?.message)) return false;
  if (report.outcome === "environment-only") {
    const fallback = report.selectedFallback;
    if (!fallback || !fallback.name?.trim() || !fallback.command?.trim() || !["container", "venv"].includes(fallback.kind)) return false;
    if (diagnostics.some((entry) => entry.kind !== "missing-host-dependency" || entry.blocking)) return false;
    return blocking.length === 0 && diagnostics.some((entry) => entry.kind === "missing-host-dependency");
  }
  if (report.outcome === "blocked") return blocking.length > 0;
  return blocking.length === 0 && diagnostics.length === 0;
}

export function classifyVerificationOutput(output: string, environment: ValidationEnvironment = {}, options: { failed?: boolean } = {}): VerificationDiagnosticReport {
  const diagnostics = parseVerificationDiagnostics(output);
  if (options.failed && diagnostics.length === 0) diagnostics.push({ kind: "unknown", message: "Verification command failed without diagnostic output.", blocking: true });
  return classifyVerificationDiagnostics(diagnostics, environment);
}

export function formatSkippedVerification(skipped: SkippedVerification): string {
  return `SKIPPED — environment not provisioned (environment: ${skipped.environment}; attempted command: ${skipped.attemptedCommand})`;
}
