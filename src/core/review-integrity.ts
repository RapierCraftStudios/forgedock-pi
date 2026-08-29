import type { ForgeReviewFindingResult } from "../agents/contracts.ts";

export interface ReviewFindingFileRange {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface NormalizedReviewFindingMetadata {
  readonly finding: ForgeReviewFindingResult;
  readonly affectedFiles: readonly ReviewFindingFileRange[];
  readonly patternMetadataFiles: readonly string[];
  readonly affectedPaths: readonly string[];
}

export class ReviewFindingIntegrityError extends Error {
  readonly findingId?: string;
  constructor(message: string, findingId?: string) {
    super(`Review finding integrity failure: ${message}`);
    this.name = "ReviewFindingIntegrityError";
    this.findingId = findingId;
  }
}

/** Normalize structured reviewer locations before they become durable issues. */
export function normalizeReviewFindingMetadata(
  finding: ForgeReviewFindingResult,
): NormalizedReviewFindingMetadata {
  const id = typeof finding.id === "string" ? finding.id : undefined;
  const raw = finding.affectedFiles;
  const ranges: ReviewFindingFileRange[] = [];
  if (raw !== undefined) {
    if (!Array.isArray(raw)) throw new ReviewFindingIntegrityError("affectedFiles must be an array", id);
    for (const [index, entry] of raw.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ReviewFindingIntegrityError(`affectedFiles[${index}] must be an object`, id);
      const item = entry as Partial<ReviewFindingFileRange>;
      const path = normalizeRepositoryPath(item.path, `affectedFiles[${index}].path`, id);
      const startLine = positiveLine(item.startLine, `affectedFiles[${index}].startLine`, id);
      const endLine = positiveLine(item.endLine, `affectedFiles[${index}].endLine`, id);
      if (endLine < startLine) throw new ReviewFindingIntegrityError(`affectedFiles[${index}].endLine must not precede startLine`, id);
      ranges.push({ path, startLine, endLine });
    }
  }
  const legacyPath = normalizeRepositoryPath(finding.file, "file", id);
  const legacyLine = positiveLine(finding.line, "line", id);
  if (ranges.length === 0) ranges.push({ path: legacyPath, startLine: legacyLine, endLine: legacyLine });
  const paths = [...new Set(ranges.map((range) => range.path))].sort((a, b) => a.localeCompare(b));
  if (paths.length === 0) throw new ReviewFindingIntegrityError("at least one affected repository-relative path is required", id);
  const patternMetadataFiles = finding.patternMetadataFiles === undefined
    ? paths
    : normalizePathList(finding.patternMetadataFiles, "patternMetadataFiles", id);
  if (patternMetadataFiles.length === 0) throw new ReviewFindingIntegrityError("Pattern Metadata Files cannot be blank", id);
  const normalizedFinding: ForgeReviewFindingResult = {
    ...finding,
    file: ranges[0]?.path ?? legacyPath,
    line: ranges[0]?.startLine ?? legacyLine,
    affectedFiles: ranges,
    patternMetadataFiles,
  };
  return Object.freeze({
    finding: normalizedFinding,
    affectedFiles: Object.freeze(ranges),
    patternMetadataFiles: Object.freeze(patternMetadataFiles),
    affectedPaths: Object.freeze(paths),
  });
}

/** Invalid findings are quarantined instead of being projected into a DAG. */
export function quarantineReviewFinding(finding: ForgeReviewFindingResult): { finding: ForgeReviewFindingResult; reason: string } | undefined {
  try {
    normalizeReviewFindingMetadata(finding);
    return undefined;
  } catch (error) {
    return { finding, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Read only the signed structured marker; never infer paths from prose/body text. */
export function trustedAffectedPathsFromReviewFinding(markdown: string): readonly string[] {
  const prefix = "<!-- FORGE:REVIEW_FINDING_PATHS ";
  const start = markdown.indexOf(prefix);
  if (start < 0) return [];
  const valueStart = start + prefix.length;
  const end = markdown.indexOf(" -->", valueStart);
  if (end < 0) return [];
  try {
    const value: unknown = JSON.parse(markdown.slice(valueStart, end));
    if (!Array.isArray(value)) return [];
    return Object.freeze(normalizePathList(value, "readback affected paths"));
  } catch {
    return [];
  }
}

/** Verify GitHub readback against the exact path set used for projection. */
export function assertReviewFindingReadbackPaths(markdown: string, expected: readonly string[]): void {
  const actual = trustedAffectedPathsFromReviewFinding(markdown);
  const wanted = [...new Set(expected)].sort();
  if (actual.length !== wanted.length || actual.some((path, index) => path !== wanted[index]))
    throw new ReviewFindingIntegrityError("read-back affected path set does not match the submitted finding");
}

/** Stable typed input for dependency/DAG construction. */
export function trustedAffectedPathsForDag(finding: ForgeReviewFindingResult): readonly string[] {
  return normalizeReviewFindingMetadata(finding).affectedPaths;
}

function normalizePathList(value: unknown, field: string, findingId?: string): string[] {
  if (!Array.isArray(value)) throw new ReviewFindingIntegrityError(`${field} must be an array`, findingId);
  return [...new Set(value.map((entry, index) => normalizeRepositoryPath(entry, `${field}[${index}]`, findingId)))].sort((a, b) => a.localeCompare(b));
}

function normalizeRepositoryPath(value: unknown, field: string, findingId?: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ReviewFindingIntegrityError(`${field} must contain a non-empty repository-relative path`, findingId);
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path === "." || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("\0") || path.split("/").includes(".."))
    throw new ReviewFindingIntegrityError(`${field} is not repository-relative`, findingId);
  return path.replace(/\/{2,}/g, "/");
}

function positiveLine(value: unknown, field: string, findingId?: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ReviewFindingIntegrityError(`${field} must be a positive line number`, findingId);
  return value as number;
}
