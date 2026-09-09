import {
  builderPathAllowed,
  type BuilderPathContract,
} from "../core/builder-contract.ts";
import { findingBlocksMerge } from "../core/review.ts";
import type { ForgeReviewFindingResult, ForgeReviewerResult } from "../agents/contracts.ts";

export type WorkOnFindingDisposition =
  | "blocking"
  | "advisory"
  | "pre-existing"
  | "out-of-scope"
  | "follow-up";

export interface WorkOnFindingDecision {
  finding: ForgeReviewFindingResult;
  sourceFindings: readonly ForgeReviewFindingResult[];
  reviewers: readonly string[];
  disposition: WorkOnFindingDisposition;
  rationale: string;
}

export interface WorkOnReviewDisposition {
  decisions: readonly WorkOnFindingDecision[];
  blocking: readonly ForgeReviewFindingResult[];
  followUps: readonly ForgeReviewFindingResult[];
  advisories: readonly ForgeReviewFindingResult[];
  preExisting: readonly ForgeReviewFindingResult[];
  outOfScope: readonly ForgeReviewFindingResult[];
}

const confidenceRank: Record<ForgeReviewFindingResult["confidence"], number> = {
  possible: 0,
  likely: 1,
  confirmed: 2,
};

const severityRank: Record<ForgeReviewFindingResult["severity"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const blockRank: Record<NonNullable<ForgeReviewFindingResult["reviewerBlockView"]>, number> = {
  advisory: 0,
  blocking: 1,
};

const scopeRank: Record<NonNullable<ForgeReviewFindingResult["reviewerScope"]>, number> = {
  "pre-existing": 0,
  "out-of-scope": 1,
  "patch-caused": 2,
};

export function collateWorkOnReview(
  reviewerResults: readonly ForgeReviewerResult[],
  builderContract?: BuilderPathContract,
  fallbackFindings: readonly ForgeReviewFindingResult[] = [],
): WorkOnReviewDisposition {
  const raw = reviewerResults.flatMap((reviewer) => reviewer.findings);
  const source = raw.length > 0 ? raw : fallbackFindings;
  const groups = new Map<string, ForgeReviewFindingResult[]>();
  for (const finding of source) {
    const key = findingBehaviorKey(finding);
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  const decisions = [...groups.values()].map((group) => {
    const representative = [...group].sort(compareFindings)[0]!;
    const reviewers = [...new Set(group.map((finding) => finding.reviewer))].sort();
    const scope = majority(group, (finding) => finding.reviewerScope ?? "patch-caused", scopeRank, "patch-caused");
    const inContract =
      builderContract === undefined || builderPathAllowed(builderContract, representative.file);
    const effectiveScope = !inContract ? "out-of-scope" : scope;
    const blockView = majority(
      group,
      (finding) => finding.reviewerBlockView ?? (findingBlocksMerge(finding) ? "blocking" : "advisory"),
      blockRank,
      findingBlocksMerge(representative) ? "blocking" : "advisory",
    );
    const confirmed = representative.confidence === "confirmed";
    let disposition: WorkOnFindingDisposition;
    let rationale: string;
    if (effectiveScope === "pre-existing") {
      disposition = "pre-existing";
      rationale = "The panel classified the concern as pre-existing to the current patch.";
    } else if (effectiveScope === "out-of-scope") {
      disposition = "out-of-scope";
      rationale = "The concern is outside the accepted builder contract or was classified out of scope.";
    } else if (confirmed && blockView === "blocking" && findingBlocksMerge(representative)) {
      disposition = "blocking";
      rationale = "Confirmed patch-caused evidence and the reconciled reviewer block view meet the blocking gate.";
    } else if (representative.confidence === "possible") {
      disposition = "advisory";
      rationale = "Possible evidence is retained as an advisory and cannot authorize remediation.";
    } else {
      disposition = "follow-up";
      rationale = "The concern is patch-caused and validated but does not block the current issue.";
    }
    return {
      finding: representative,
      sourceFindings: group,
      reviewers,
      disposition,
      rationale,
    } satisfies WorkOnFindingDecision;
  });

  const by = (disposition: WorkOnFindingDisposition) =>
    decisions.filter((decision) => decision.disposition === disposition).map((decision) => decision.finding);
  return {
    decisions,
    blocking: by("blocking"),
    followUps: by("follow-up"),
    advisories: by("advisory"),
    preExisting: by("pre-existing"),
    outOfScope: by("out-of-scope"),
  };
}

export function findingBehaviorKey(finding: ForgeReviewFindingResult): string {
  const paths = finding.affectedFiles?.map((range) => range.path).sort().join(",") ?? finding.file;
  const lineBucket = Math.floor(Math.max(1, finding.line - 1) / 5);
  const summary = finding.summary.toLowerCase().replace(/\s+/g, " ").trim();
  return `${finding.category}|${paths}|${lineBucket}|${summary}`;
}

function compareFindings(
  left: ForgeReviewFindingResult,
  right: ForgeReviewFindingResult,
): number {
  return (
    confidenceRank[right.confidence] - confidenceRank[left.confidence] ||
    severityRank[right.severity] - severityRank[left.severity] ||
    (blockRank[right.reviewerBlockView ?? "advisory"] -
      blockRank[left.reviewerBlockView ?? "advisory"]) ||
    right.evidence.length - left.evidence.length ||
    left.id.localeCompare(right.id)
  );
}

function majority<T extends string>(
  values: readonly ForgeReviewFindingResult[],
  select: (finding: ForgeReviewFindingResult) => T,
  ranks: Record<T, number>,
  tie: T,
): T {
  const counts = new Map<T, number>();
  for (const finding of values) {
    const value = select(finding);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || ranks[right[0]] - ranks[left[0]],
  )[0]?.[0] ?? tie;
}
