import { posix } from "node:path";

export const FORGEDOCK_CONFIG_SCHEMA = "forgedock.config/v1" as const;

export interface VerificationCommandPolicy {
  argv: readonly string[];
  cwd: string;
  required: boolean;
  timeoutMs: number;
}

export interface ForgePolicy {
  schema: typeof FORGEDOCK_CONFIG_SCHEMA;
  repository: {
    provider: "github";
    name: string;
  };
  state: {
    branch: string;
    leaseSeconds: number;
    heartbeatSeconds: number;
  };
  branches: {
    integration: readonly string[];
    protected: readonly string[];
    autoMergeIntegration: boolean;
  };
  verification: {
    github: {
      required: boolean;
      requiredBranches: readonly string[];
      waitTimeoutMs: number;
      pollIntervalMs: number;
    };
    commands: Readonly<Record<string, VerificationCommandPolicy>>;
  };
  review: {
    required: readonly string[];
    maxRounds: number;
  };
  orchestration: {
    maxConcurrent: number;
    maxIssues: number;
  };
  subagents: {
    maxConcurrent: number;
    maxDepth: number;
    workOnTimeoutMs: number;
    reviewerTimeoutMs: number;
  };
}

export interface LocalForgeOverrides {
  branches?: {
    autoMergeIntegration?: false;
  };
  verification?: {
    commands?: Readonly<Record<string, { timeoutMs?: number }>>;
  };
  orchestration?: {
    maxConcurrent?: number;
  };
  subagents?: {
    maxConcurrent?: number;
  };
}

export class PolicyValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PolicyValidationError";
    this.path = path;
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new PolicyValidationError(path, "must be a non-empty trimmed string");
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean")
    throw new PolicyValidationError(path, "must be boolean");
  return value;
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new PolicyValidationError(
      path,
      `must be a safe integer from ${minimum} through ${maximum}`,
    );
  }
  return value as number;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new PolicyValidationError(path, "must be a non-empty array");
  return [
    ...new Set(value.map((entry, index) => string(entry, `${path}[${index}]`))),
  ];
}

export function normalizeVerificationCommandCwd(
  value: unknown,
  path = "verification command cwd",
): string {
  if (value === undefined) return ".";
  const cwd = string(value, path);
  if (cwd.includes("\0"))
    throw new PolicyValidationError(path, "must not contain NUL bytes");
  if (cwd.includes("\\"))
    throw new PolicyValidationError(
      path,
      "must use portable forward-slash separators",
    );
  if (
    cwd.startsWith("/") ||
    cwd.startsWith("//") ||
    /^[A-Za-z]:/.test(cwd)
  ) {
    throw new PolicyValidationError(path, "must be repository-relative");
  }
  if (cwd.split("/").includes(".."))
    throw new PolicyValidationError(path, "must not contain '..' traversal");
  const normalized = posix.normalize(cwd);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new PolicyValidationError(path, "must stay within the repository");
  }
  return normalized || ".";
}

function parseGitHubVerification(value: unknown): ForgePolicy["verification"]["github"] {
  if (value === undefined)
    return {
      required: true,
      requiredBranches: ["*"],
      waitTimeoutMs: 1_800_000,
      pollIntervalMs: 10_000,
    };
  const github = record(value, "verification.github");
  return {
    required:
      github.required === undefined
        ? true
        : boolean(github.required, "verification.github.required"),
    requiredBranches:
      github.requiredBranches === undefined
        ? ["*"]
        : stringArray(
            github.requiredBranches,
            "verification.github.requiredBranches",
          ),
    waitTimeoutMs:
      github.waitTimeoutMs === undefined
        ? 1_800_000
        : integer(
            github.waitTimeoutMs,
            "verification.github.waitTimeoutMs",
            10_000,
            7_200_000,
          ),
    pollIntervalMs:
      github.pollIntervalMs === undefined
        ? 10_000
        : integer(
            github.pollIntervalMs,
            "verification.github.pollIntervalMs",
            1_000,
            60_000,
          ),
  };
}

function parseVerificationCommands(
  value: unknown,
): Record<string, VerificationCommandPolicy> {
  if (value === undefined) return {};
  const source = record(value, "verification.commands");
  const commands: Record<string, VerificationCommandPolicy> = {};
  for (const [name, raw] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
      throw new PolicyValidationError(
        `verification.commands.${name}`,
        "name must be lowercase kebab-case",
      );
    }
    const command = record(raw, `verification.commands.${name}`);
    const argv = stringArray(
      command.argv,
      `verification.commands.${name}.argv`,
    );
    commands[name] = {
      argv,
      cwd: normalizeVerificationCommandCwd(
        command.cwd,
        `verification.commands.${name}.cwd`,
      ),
      required: boolean(
        command.required,
        `verification.commands.${name}.required`,
      ),
      timeoutMs: integer(
        command.timeoutMs,
        `verification.commands.${name}.timeoutMs`,
        1_000,
        3_600_000,
      ),
    };
  }
  return commands;
}

export function parseForgePolicy(value: unknown): ForgePolicy {
  const root = record(value, "config");
  if (root.schema !== FORGEDOCK_CONFIG_SCHEMA) {
    throw new PolicyValidationError(
      "schema",
      `must equal ${FORGEDOCK_CONFIG_SCHEMA}`,
    );
  }
  const repository = record(root.repository, "repository");
  if (repository.provider !== "github")
    throw new PolicyValidationError("repository.provider", "must equal github");
  const repositoryName = string(repository.name, "repository.name");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repositoryName)) {
    throw new PolicyValidationError(
      "repository.name",
      "must have owner/repository form",
    );
  }

  const state = record(root.state, "state");
  const branches = record(root.branches, "branches");
  const verification = record(root.verification, "verification");
  const review = record(root.review, "review");
  const orchestration =
    root.orchestration === undefined
      ? undefined
      : record(root.orchestration, "orchestration");
  const subagents = record(root.subagents, "subagents");
  const leaseSeconds =
    state.leaseSeconds === undefined
      ? 31_536_000
      : integer(state.leaseSeconds, "state.leaseSeconds", 30, 31_536_000);
  const heartbeatSeconds =
    state.heartbeatSeconds === undefined
      ? 60
      : integer(
          state.heartbeatSeconds,
          "state.heartbeatSeconds",
          5,
          leaseSeconds - 1,
        );

  return {
    schema: FORGEDOCK_CONFIG_SCHEMA,
    repository: { provider: "github", name: repositoryName },
    state: {
      branch: string(state.branch, "state.branch"),
      leaseSeconds,
      heartbeatSeconds,
    },
    branches: {
      integration: stringArray(branches.integration, "branches.integration"),
      protected: stringArray(branches.protected, "branches.protected"),
      autoMergeIntegration: boolean(
        branches.autoMergeIntegration,
        "branches.autoMergeIntegration",
      ),
    },
    verification: {
      github: parseGitHubVerification(verification.github),
      commands: parseVerificationCommands(verification.commands),
    },
    review: {
      required: stringArray(review.required, "review.required"),
      maxRounds:
        review.maxRounds === undefined
          ? 3
          : integer(review.maxRounds, "review.maxRounds", 1, 5),
    },
    orchestration: {
      maxConcurrent:
        orchestration?.maxConcurrent === undefined
          ? 2
          : integer(
              orchestration.maxConcurrent,
              "orchestration.maxConcurrent",
              1,
              16,
            ),
      maxIssues:
        orchestration?.maxIssues === undefined
          ? 100
          : integer(
              orchestration.maxIssues,
              "orchestration.maxIssues",
              1,
              100,
            ),
    },
    subagents: {
      maxConcurrent: integer(
        subagents.maxConcurrent,
        "subagents.maxConcurrent",
        1,
        32,
      ),
      maxDepth:
        subagents.maxDepth === undefined
          ? 2
          : integer(subagents.maxDepth, "subagents.maxDepth", 2, 4),
      workOnTimeoutMs:
        subagents.workOnTimeoutMs === undefined
          ? 14_400_000
          : integer(
              subagents.workOnTimeoutMs,
              "subagents.workOnTimeoutMs",
              600_000,
              21_600_000,
            ),
      reviewerTimeoutMs:
        subagents.reviewerTimeoutMs === undefined
          ? 900_000
          : integer(
              subagents.reviewerTimeoutMs,
              "subagents.reviewerTimeoutMs",
              300_000,
              7_200_000,
            ),
    },
  };
}

function branchMatches(pattern: string, branch: string): boolean {
  let patternIndex = 0;
  let branchIndex = 0;
  let starIndex = -1;
  let retryBranchIndex = -1;

  while (branchIndex < branch.length) {
    if (
      patternIndex < pattern.length &&
      pattern[patternIndex] === branch[branchIndex]
    ) {
      patternIndex += 1;
      branchIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      retryBranchIndex = branchIndex;
      patternIndex += 1;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      retryBranchIndex += 1;
      branchIndex = retryBranchIndex;
    } else {
      return false;
    }
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === "*")
    patternIndex += 1;
  return patternIndex === pattern.length;
}

export function isProtectedBranch(
  policy: ForgePolicy,
  branch: string,
): boolean {
  return policy.branches.protected.some((pattern) =>
    branchMatches(pattern, branch),
  );
}

export function isIntegrationBranch(
  policy: ForgePolicy,
  branch: string,
): boolean {
  return policy.branches.integration.some((pattern) =>
    branchMatches(pattern, branch),
  );
}

export function canAutoMerge(policy: ForgePolicy, branch: string): boolean {
  return (
    policy.branches.autoMergeIntegration &&
    isIntegrationBranch(policy, branch) &&
    !isProtectedBranch(policy, branch)
  );
}

export function isGitHubCiRequired(
  policy: ForgePolicy,
  branch: string,
): boolean {
  return (
    policy.verification.github.required &&
    policy.verification.github.requiredBranches.some((pattern) =>
      branchMatches(pattern, branch),
    )
  );
}

export function applyLocalOverrides(
  policy: ForgePolicy,
  overrides: LocalForgeOverrides,
): ForgePolicy {
  const maxConcurrent = overrides.subagents?.maxConcurrent;
  const orchestrationMaxConcurrent =
    overrides.orchestration?.maxConcurrent;
  if (
    maxConcurrent !== undefined &&
    (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
  ) {
    throw new PolicyValidationError(
      "local.subagents.maxConcurrent",
      "must be a positive safe integer",
    );
  }
  if (
    orchestrationMaxConcurrent !== undefined &&
    (!Number.isSafeInteger(orchestrationMaxConcurrent) ||
      orchestrationMaxConcurrent < 1)
  ) {
    throw new PolicyValidationError(
      "local.orchestration.maxConcurrent",
      "must be a positive safe integer",
    );
  }
  const commands: Record<string, VerificationCommandPolicy> = {
    ...policy.verification.commands,
  };
  for (const [name, override] of Object.entries(
    overrides.verification?.commands ?? {},
  )) {
    const current = commands[name];
    if (!current)
      throw new PolicyValidationError(
        `local.verification.commands.${name}`,
        "cannot add an untracked command",
      );
    if (override.timeoutMs !== undefined) {
      commands[name] = {
        ...current,
        timeoutMs: Math.min(
          current.timeoutMs,
          integer(
            override.timeoutMs,
            `local.verification.commands.${name}.timeoutMs`,
            1_000,
            3_600_000,
          ),
        ),
      };
    }
  }

  return {
    ...policy,
    branches: {
      ...policy.branches,
      autoMergeIntegration:
        overrides.branches?.autoMergeIntegration === false
          ? false
          : policy.branches.autoMergeIntegration,
    },
    verification: { ...policy.verification, commands },
    orchestration: {
      ...policy.orchestration,
      maxConcurrent:
        orchestrationMaxConcurrent === undefined
          ? policy.orchestration.maxConcurrent
          : Math.min(
              policy.orchestration.maxConcurrent,
              orchestrationMaxConcurrent,
            ),
    },
    subagents: {
      ...policy.subagents,
      maxConcurrent:
        maxConcurrent === undefined
          ? policy.subagents.maxConcurrent
          : Math.min(policy.subagents.maxConcurrent, maxConcurrent),
    },
  };
}
