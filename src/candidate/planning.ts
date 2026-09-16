export interface IssuePlanInput {
  number: number;
  title?: string;
  body?: string;
  dependsOn?: readonly number[];
  mutationFiles?: readonly string[];
  migration?: boolean;
  globalFiles?: readonly string[];
}

export interface PlannedIssue extends IssuePlanInput {
  key: string;
  predecessors: readonly string[];
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

function normalizedFiles(files: readonly string[] | undefined): readonly string[] {
  return [...new Set((files ?? []).map((file) => file.trim()).filter(Boolean))];
}

function overlap(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const rightSet = new Set(normalizedFiles(right));
  return normalizedFiles(left).some((file) => rightSet.has(file));
}

function explicitPredecessors(issue: IssuePlanInput, numbers: Set<number>): readonly number[] {
  return [...new Set((issue.dependsOn ?? []).filter((number) => numbers.has(number) && number !== issue.number))];
}

/** Build only explicit or exact-file dependency edges. Broad domains/directories never add edges. */
export function buildDependencyGraph(
  issues: readonly IssuePlanInput[],
  configuredGlobalFiles: readonly string[] = [],
): readonly PlannedIssue[] {
  const numbers = new Set(issues.map((issue) => issue.number));
  if (numbers.size !== issues.length) throw new Error("Issue selector contains duplicate issue numbers");
  const predecessors = new Map<number, Set<number>>(
    issues.map((issue) => [issue.number, new Set(explicitPredecessors(issue, numbers))]),
  );
  const globalFiles = normalizedFiles(configuredGlobalFiles);

  for (let leftIndex = 0; leftIndex < issues.length; leftIndex += 1) {
    const left = issues[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < issues.length; rightIndex += 1) {
      const right = issues[rightIndex];
      if (!right) continue;
      const exactMutationConflict = overlap(left.mutationFiles, right.mutationFiles);
      const exactGlobalConflict =
        overlap(left.mutationFiles, globalFiles) && overlap(right.mutationFiles, globalFiles);
      const migrationOrder = Boolean(left.migration && right.migration);
      if (exactMutationConflict || exactGlobalConflict || migrationOrder) {
        predecessors.get(right.number)?.add(left.number);
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
