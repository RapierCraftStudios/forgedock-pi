/**
 * Deterministic evidence used to decide whether a pull request contributed to
 * a frozen integration-branch snapshot. This is deliberately a safety leaf:
 * it does not read refs, inspect issue text, or perform workflow side effects.
 */
export interface StagingBundleCandidate {
  /** Repository identity returned by GitHub, never inferred from text. */
  repository: string;
  number: number;
  state: "open" | "closed";
  merged: boolean;
  baseRef: string;
  headSha: string;
  /** GitHub's merge_commit_sha (merge, squash, or rebase merge). */
  mergeCommitSha?: string | null;
  /** Optional commit representing a provider's patch application. */
  patchSha?: string | null;
}

export interface FrozenStagingBundleRoute {
  repository: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  /** The staging-to-main PR itself is not a member of its own bundle. */
  integrationPullNumber?: number;
}

export type StagingBundleReachability = (
  sha: string,
  target: "base" | "head",
) => boolean;
export type AsyncStagingBundleReachability = (
  sha: string,
  target: "base" | "head",
) => boolean | Promise<boolean>;

export type StagingBundleEvidenceKind = "merge" | "head" | "patch";

export interface StagingBundleEvidence {
  kind: StagingBundleEvidenceKind;
  sha: string;
  reachableFromHead: boolean;
  reachableFromBase: boolean;
  accepted: boolean;
}

export interface StagingBundleDerivation {
  pullNumber: number;
  repository: string;
  evidence: readonly StagingBundleEvidence[];
  resolved: boolean;
  exclusion?: string;
}

export interface ResolvedStagingPullRequest {
  pullNumber: number;
  repository: string;
  evidence: readonly StagingBundleEvidenceKind[];
  /** Stable identity for downstream finding lookup and Phase 6.5. */
  identity: string;
}

export interface StagingBundleResolution {
  schema: "forgedock.staging-bundle-resolution/v1";
  route: FrozenStagingBundleRoute;
  resolved: readonly ResolvedStagingPullRequest[];
  derivations: readonly StagingBundleDerivation[];
  exclusions: readonly {
    pullNumber?: number;
    repository?: string;
    reason: string;
  }[];
}

export class StagingBundleResolutionError extends Error {
  readonly reason: "ambiguous" | "invalid";

  constructor(reason: "ambiguous" | "invalid", message: string) {
    super(message);
    this.name = "StagingBundleResolutionError";
    this.reason = reason;
  }
}

/**
 * Resolve included PRs from Git commit reachability, not commit subjects or
 * issue/PR numbers appearing in prose. A PR is included only when its GitHub
 * identity is for the configured repository and at least one of its merge,
 * head, or patch commits is reachable from the frozen head but not the frozen
 * base. Thus merge, squash, and rebase PRs are handled without special casing.
 */
export function resolveStagingBundle(input: {
  route: FrozenStagingBundleRoute;
  candidates: readonly StagingBundleCandidate[];
  isReachable: StagingBundleReachability;
}): StagingBundleResolution {
  assertRoute(input.route);
  const expectedRepository = canonicalRepository(input.route.repository);
  const seen = new Set<string>();
  const evidenceOwners = new Map<string, string>();
  const derivations: StagingBundleDerivation[] = [];
  const exclusions: Array<{
    pullNumber?: number;
    repository?: string;
    reason: string;
  }> = [];
  const resolved: ResolvedStagingPullRequest[] = [];

  for (const candidate of [...input.candidates].sort(compareCandidates)) {
    assertCandidate(candidate);
    const identity = `${canonicalRepository(candidate.repository)}#${candidate.number}`;
    if (seen.has(identity))
      throw new StagingBundleResolutionError(
        "ambiguous",
        `Ambiguous staging bundle metadata: duplicate pull request ${identity}.`,
      );
    seen.add(identity);

    const repository = canonicalRepository(candidate.repository);
    if (repository !== expectedRepository) {
      const reason = "repository-identity-mismatch";
      exclusions.push({
        pullNumber: candidate.number,
        repository: candidate.repository,
        reason,
      });
      derivations.push({
        pullNumber: candidate.number,
        repository: candidate.repository,
        evidence: [],
        resolved: false,
        exclusion: reason,
      });
      continue;
    }
    if (candidate.number === input.route.integrationPullNumber) {
      const reason = "integration-pr-excluded";
      exclusions.push({ pullNumber: candidate.number, repository, reason });
      derivations.push({
        pullNumber: candidate.number,
        repository,
        evidence: [],
        resolved: false,
        exclusion: reason,
      });
      continue;
    }
    if (candidate.baseRef !== input.route.headRef) {
      const reason = "base-ref-mismatch";
      exclusions.push({ pullNumber: candidate.number, repository, reason });
      derivations.push({
        pullNumber: candidate.number,
        repository,
        evidence: [],
        resolved: false,
        exclusion: reason,
      });
      continue;
    }

    const evidence: StagingBundleEvidence[] = [];
    for (const [kind, sha] of evidenceCommits(candidate)) {
      const reachableFromHead = input.isReachable(sha, "head");
      const reachableFromBase = input.isReachable(sha, "base");
      evidence.push({
        kind,
        sha,
        reachableFromHead,
        reachableFromBase,
        accepted: reachableFromHead && !reachableFromBase,
      });
    }
    const acceptedEvidence = evidence.filter((entry) => entry.accepted);
    if (acceptedEvidence.length === 0) {
      const reason = evidence.some((entry) => entry.reachableFromBase)
        ? "already-reachable-from-base"
        : "no-reachable-merge-head-or-patch-evidence";
      exclusions.push({ pullNumber: candidate.number, repository, reason });
      derivations.push({
        pullNumber: candidate.number,
        repository,
        evidence,
        resolved: false,
        exclusion: reason,
      });
      continue;
    }
    for (const evidence of acceptedEvidence) {
      const owner = evidenceOwners.get(evidence.sha);
      if (owner !== undefined && owner !== identity)
        throw new StagingBundleResolutionError(
          "ambiguous",
          `Ambiguous staging bundle evidence ${evidence.sha} belongs to ${owner} and ${identity}.`,
        );
      evidenceOwners.set(evidence.sha, identity);
    }
    const evidenceKinds = acceptedEvidence.map((entry) => entry.kind).sort(
      compareEvidenceKinds,
    );
    resolved.push({
      pullNumber: candidate.number,
      repository,
      evidence: evidenceKinds,
      identity: `${repository}#${candidate.number}`,
    });
    derivations.push({
      pullNumber: candidate.number,
      repository,
      evidence,
      resolved: true,
    });
  }

  resolved.sort((left, right) => left.pullNumber - right.pullNumber);
  derivations.sort(compareDerivations);
  exclusions.sort((left, right) =>
    (left.pullNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.pullNumber ?? Number.MAX_SAFE_INTEGER) ||
    (left.repository ?? "").localeCompare(right.repository ?? "") ||
    left.reason.localeCompare(right.reason),
  );
  return Object.freeze({
    schema: "forgedock.staging-bundle-resolution/v1",
    route: Object.freeze({ ...input.route }),
    resolved: Object.freeze(resolved.map((entry) => Object.freeze(entry))),
    derivations: Object.freeze(
      derivations.map((entry) =>
        Object.freeze({
          ...entry,
          evidence: Object.freeze(
            entry.evidence.map((evidence) => Object.freeze(evidence)),
          ),
        }),
      ),
    ),
    exclusions: Object.freeze(exclusions.map((entry) => Object.freeze(entry))),
  });
}

/** Async adapter for real Git providers; the safety decision remains the
 * synchronous, deterministic resolver above once all graph observations are
 * frozen. */
export async function resolveStagingBundleAsync(input: {
  route: FrozenStagingBundleRoute;
  candidates: readonly StagingBundleCandidate[];
  isReachable: AsyncStagingBundleReachability;
}): Promise<StagingBundleResolution> {
  assertRoute(input.route);
  for (const candidate of input.candidates) assertCandidate(candidate);
  const observations = new Map<string, boolean>();
  for (const candidate of input.candidates) {
    for (const [, sha] of evidenceCommits(candidate)) {
      for (const target of ["base", "head"] as const) {
        const key = `${sha}\u0000${target}`;
        if (!observations.has(key))
          observations.set(key, await input.isReachable(sha, target));
      }
    }
  }
  return resolveStagingBundle({
    route: input.route,
    candidates: input.candidates,
    isReachable: (sha, target) => observations.get(`${sha}\u0000${target}`) ?? false,
  });
}

function evidenceCommits(
  candidate: StagingBundleCandidate,
): readonly [StagingBundleEvidenceKind, string][] {
  const commits: Array<[StagingBundleEvidenceKind, string]> = [
    ["head", candidate.headSha],
  ];
  if (candidate.mergeCommitSha?.trim())
    commits.push(["merge", candidate.mergeCommitSha.trim()]);
  if (candidate.patchSha?.trim()) commits.push(["patch", candidate.patchSha.trim()]);
  return commits;
}

function canonicalRepository(repository: string): string {
  return repository.trim().toLowerCase();
}

function assertRoute(route: FrozenStagingBundleRoute): void {
  if (!canonicalRepository(route.repository) || !route.baseRef || !route.headRef)
    throw new StagingBundleResolutionError(
      "invalid",
      "Staging bundle route requires repository, base ref, and head ref.",
    );
  for (const [label, sha] of [
    ["base", route.baseSha],
    ["head", route.headSha],
  ] as const)
    if (!sha?.trim())
      throw new StagingBundleResolutionError(
        "invalid",
        `Staging bundle route requires a frozen ${label} SHA.`,
      );
}

function assertCandidate(candidate: StagingBundleCandidate): void {
  if (
    !canonicalRepository(candidate.repository) ||
    !Number.isSafeInteger(candidate.number) ||
    candidate.number < 1 ||
    !candidate.baseRef ||
    !candidate.headSha?.trim()
  )
    throw new StagingBundleResolutionError(
      "invalid",
      "GitHub PR metadata is missing repository, number, base ref, or head SHA.",
    );
}

function compareCandidates(
  left: StagingBundleCandidate,
  right: StagingBundleCandidate,
): number {
  return (
    left.number - right.number ||
    canonicalRepository(left.repository).localeCompare(
      canonicalRepository(right.repository),
    ) ||
    left.headSha.localeCompare(right.headSha)
  );
}

function compareDerivations(
  left: StagingBundleDerivation,
  right: StagingBundleDerivation,
): number {
  return (
    left.pullNumber - right.pullNumber ||
    left.repository.localeCompare(right.repository)
  );
}

function compareEvidenceKinds(
  left: StagingBundleEvidenceKind,
  right: StagingBundleEvidenceKind,
): number {
  return ["merge", "head", "patch"].indexOf(left) -
    ["merge", "head", "patch"].indexOf(right);
}
