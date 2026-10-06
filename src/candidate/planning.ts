import path from "node:path";

export interface IssuePlanInput {
  number: number;
  target?: string;
  title?: string;
  body?: string;
  dependsOn?: readonly number[];
  mutationFiles?: readonly string[];
  migration?: boolean;
  globalFiles?: readonly string[];
}

export interface PlannedConflict {
  issue: number;
  reason: "shared-mutation-file" | "shared-global-file" | "migration-sequence";
  files: readonly string[];
}

export interface PlannedIssue extends IssuePlanInput {
  key: string;
  /** Functional prerequisites only; conflicts must never use this list. */
  predecessors: readonly string[];
  /** Exclusive-write ordering; settling this issue does not imply its behavior was delivered. */
  conflicts: readonly PlannedConflict[];
  externalDependencies: readonly number[];
}

export type ReviewerRole = "correctness" | "security" | "specialist";

export interface ReviewRosterInput {
  materialSecurityBoundary?: boolean;
  specialistQuestion?: string;
}

export interface ReviewRoster {
  roles: readonly ReviewerRole[];
  rationale: readonly string[];
}

function normalizedRepoPath(file: string): string {
  const portable = file.trim().replace(/\\/g, "/");
  if (!portable || portable.startsWith("/") || /^[A-Za-z]:/.test(portable) || /[*?]/.test(portable)) {
    throw new Error(`Mutation path must be an exact repository-relative file: ${file}`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.endsWith("/")) {
    throw new Error(`Mutation path escapes or is not a file: ${file}`);
  }
  return normalized;
}

function normalizedFiles(files: readonly string[] | undefined): readonly string[] {
  return [...new Set((files ?? []).map(normalizedRepoPath))].sort();
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((file) => rightSet.has(file));
}

function explicitPredecessors(issue: IssuePlanInput, numbers: Set<number>): readonly number[] {
  return [...new Set((issue.dependsOn ?? []).filter((number) => numbers.has(number) && number !== issue.number))];
}

/** Keep functional prerequisites separate from exact-file and migration write conflicts. */
export function buildDependencyGraph(
  issues: readonly IssuePlanInput[],
  configuredGlobalFiles: readonly string[] = [],
): readonly PlannedIssue[] {
  const numbers = new Set(issues.map((issue) => issue.number));
  if (numbers.size !== issues.length) throw new Error("Issue selector contains duplicate issue numbers");
  const predecessors = new Map<number, Set<number>>(
    issues.map((issue) => [issue.number, new Set(explicitPredecessors(issue, numbers))]),
  );
  const conflicts = new Map<number, Map<number, PlannedConflict>>(
    issues.map((issue) => [issue.number, new Map()]),
  );
  const externalDependencies = new Map(
    issues.map((issue) => [issue.number, (issue.dependsOn ?? []).filter((number) => !numbers.has(number))]),
  );
  const globalFiles = normalizedFiles(configuredGlobalFiles);
  const filesByIssue = new Map(issues.map((issue) => [issue.number, normalizedFiles(issue.mutationFiles)]));

  function addConflict(left: number, right: number, conflict: PlannedConflict): void {
    conflicts.get(left)?.set(right, conflict);
    conflicts.get(right)?.set(left, { ...conflict, issue: left });
  }

  for (let leftIndex = 0; leftIndex < issues.length; leftIndex += 1) {
    const left = issues[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < issues.length; rightIndex += 1) {
      const right = issues[rightIndex];
      if (!right) continue;
      const sharedFiles = intersection(filesByIssue.get(left.number) ?? [], filesByIssue.get(right.number) ?? []);
      if (sharedFiles.length > 0) {
        const sharedGlobalFiles = intersection(sharedFiles, globalFiles);
        addConflict(left.number, right.number, {
          issue: right.number,
          reason: sharedGlobalFiles.length > 0 ? "shared-global-file" : "shared-mutation-file",
          files: sharedFiles,
        });
      } else if (left.migration && right.migration && (left.target ?? "") === (right.target ?? "")) {
        addConflict(left.number, right.number, {
          issue: right.number,
          reason: "migration-sequence",
          files: [],
        });
      }
    }
  }

  const state = new Map<number, "visiting" | "done">();
  const ordered: IssuePlanInput[] = [];
  function visit(number: number): void {
    const current = state.get(number);
    if (current === "visiting") throw new Error(`Issue dependency cycle includes #${number}`);
    if (current === "done") return;
    state.set(number, "visiting");
    for (const predecessor of predecessors.get(number) ?? []) visit(predecessor);
    state.set(number, "done");
    const issue = issues.find((candidate) => candidate.number === number);
    if (issue) ordered.push(issue);
  }
  for (const issue of issues) visit(issue.number);

  const keys = new Map(ordered.map((issue) => [issue.number, `issue-${issue.number}`]));
  return ordered.map((issue) => ({
    ...issue,
    key: keys.get(issue.number) as string,
    predecessors: [...(predecessors.get(issue.number) ?? [])].map((number) => keys.get(number) as string),
    conflicts: [...(conflicts.get(issue.number)?.values() ?? [])]
      .sort((left, right) => left.issue - right.issue)
      .map((conflict) => ({ ...conflict, issue: conflict.issue })),
    externalDependencies: externalDependencies.get(issue.number) ?? [],
  }));
}

/** Select the smallest independent review roster justified by concrete changed risk. */
export function selectReviewRoster(input: ReviewRosterInput): ReviewRoster {
  const roles: ReviewerRole[] = ["correctness"];
  const rationale = [
    "Correctness reviewer covers original acceptance, relevant interfaces, regression risk, and proof quality.",
  ];
  if (input.materialSecurityBoundary) {
    roles.push("security");
    rationale.push("Security reviewer is added because the change crosses a material trust, privilege, or security boundary.");
  }
  if (input.specialistQuestion?.trim()) {
    roles.push("specialist");
    rationale.push(`Specialist reviewer is added for the concrete question: ${input.specialistQuestion.trim()}`);
  }
  return { roles, rationale };
}

export function isSatisfiedOwnerResult(output: string | undefined): boolean {
  return /^FORGE_WORK_ON_RESULT status=DONE issue=\d+ pr=(?:\d+|none) dependency=SATISFIED$/m.test(output ?? "");
}
