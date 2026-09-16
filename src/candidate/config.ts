import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface CandidateReviewConfig {
  reviewerTimeoutMs: number;
  panelTimeoutMs: number;
  publicationTimeoutMs: number;
  maxConcurrent: number;
  remediationMaxRounds: number;
  reviewerThinking: ThinkingLevel;
}

export interface CandidateConfig {
  repository: string;
  projectRoot: string;
  configPath: string;
  integrationBranch: string;
  protectedBranch: string;
  featurePattern: string;
  ownerModel: string;
  ownerThinking: ThinkingLevel;
  configuredOwnerConcurrency: number;
  review: CandidateReviewConfig;
  verificationCommands: Readonly<Record<string, string>>;
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const SAFE_TOKEN = /^[A-Za-z0-9_.-]+$/;
const FULL_MODEL = /^[^\s/]+\/[^\s]+$/;

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, label: string, pattern = /[^\s]/): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string, minimum = 1, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function branch(value: unknown, label: string): string {
  const result = requiredString(value, label, /^[^\s\0]+$/);
  if (result.startsWith("-")) throw new Error(`${label} cannot start with '-'`);
  return result;
}

function validateModel(value: string): string {
  if (!FULL_MODEL.test(value)) throw new Error("Model must be a full provider/model ID");
  const suffix = value.match(/:([A-Za-z]+)$/)?.[1]?.toLowerCase();
  if (suffix && !THINKING_LEVELS.has(suffix as ThinkingLevel)) {
    throw new Error(`Unsupported model thinking suffix ':${suffix}'`);
  }
  return value;
}

function repository(owner: unknown, name: unknown): string {
  const org = requiredString(owner, "project.owner", SAFE_TOKEN);
  const repo = requiredString(name, "project.repo", SAFE_TOKEN);
  return `${org}/${repo}`;
}

function verificationCommands(value: unknown): Readonly<Record<string, string>> {
  const commands = optionalRecord(value);
  if (!commands) return {};
  const result: Record<string, string> = {};
  for (const [name, command] of Object.entries(commands)) {
    if (!SAFE_TOKEN.test(name)) continue;
    if (typeof command === "string" && command.trim() && !/[\0\n\r]/.test(command)) {
      result[name] = command.trim();
    } else if (command && typeof command === "object" && !Array.isArray(command)) {
      for (const [subName, subCommand] of Object.entries(command as Record<string, unknown>)) {
        if (SAFE_TOKEN.test(subName) && typeof subCommand === "string" && subCommand.trim() && !/[\0\n\r]/.test(subCommand)) {
          result[`${name}.${subName}`] = subCommand.trim();
        }
      }
    }
  }
  return result;
}

export function parseCandidateConfig(rawText: string, configPath: string, cwd = process.cwd()): CandidateConfig {
  let parsed: unknown;
  try {
    parsed = parse(rawText);
  } catch (error) {
    throw new Error(`Unable to parse forge.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = objectRecord(parsed, "forge.yaml");
  const project = objectRecord(root.project, "project");
  const paths = optionalRecord(root.paths) ?? {};
  const branches = optionalRecord(root.branches) ?? {};
  const agents = optionalRecord(root.agents) ?? {};
  const orchestration = optionalRecord(root.orchestration) ?? {};
  const review = optionalRecord(root.review) ?? {};
  const verification = optionalRecord(root.verification) ?? {};

  const repositoryName = repository(project.owner, project.repo);
  const configuredRoot = typeof paths.root === "string" && paths.root.trim() ? paths.root.trim() : ".";
  const projectRoot = realpathSync(resolve(cwd, configuredRoot));
  const resolvedConfigPath = realpathSync(resolve(cwd, configPath));
  if (!existsSync(projectRoot)) throw new Error(`Configured paths.root does not exist: ${projectRoot}`);
  if (!isAbsolute(projectRoot)) throw new Error("Configured project root must resolve to an absolute path");

  const integrationBranch = branch(
    branches.integration ?? branches.staging ?? "staging",
    "branches.integration",
  );
  const protectedBranch = branch(
    branches.protected ?? branches.default ?? "main",
    "branches.protected",
  );
  if (integrationBranch === protectedBranch) {
    throw new Error("Integration and protected branches must be distinct");
  }

  const ownerModel = validateModel(requiredString(
    agents.subagent_model ?? agents.default_model,
    "agents.subagent_model or agents.default_model",
    FULL_MODEL,
  ));
  const configuredThinking = agents.thinking;
  const ownerThinking: ThinkingLevel =
    typeof configuredThinking === "string" && THINKING_LEVELS.has(configuredThinking as ThinkingLevel)
      ? (configuredThinking as ThinkingLevel)
      : "high";

  const configuredOwnerConcurrency = positiveInteger(
    orchestration.max_concurrent ?? 2,
    "orchestration.max_concurrent",
    1,
    32,
  );
  const reviewerTimeoutMs = positiveInteger(review.reviewer_timeout_ms ?? 900_000, "review.reviewer_timeout_ms", 1_000);
  const publicationTimeoutMs = positiveInteger(review.publication_timeout_ms ?? 120_000, "review.publication_timeout_ms", 1_000);
  const maxConcurrent = positiveInteger(review.max_concurrent ?? 2, "review.max_concurrent", 1, 16);
  const minimumPanelTimeout = Math.ceil(3 / maxConcurrent) * reviewerTimeoutMs + publicationTimeoutMs;
  const panelTimeoutMs = positiveInteger(
    review.panel_timeout_ms ?? Math.max(1_200_000, minimumPanelTimeout),
    "review.panel_timeout_ms",
    minimumPanelTimeout,
  );
  const remediationMaxRounds = positiveInteger(review.remediation_max_rounds ?? 1, "review.remediation_max_rounds", 0);
  const configuredReviewerThinking = review.thinking;
  const reviewerThinking: ThinkingLevel =
    typeof configuredReviewerThinking === "string" && THINKING_LEVELS.has(configuredReviewerThinking as ThinkingLevel)
      ? (configuredReviewerThinking as ThinkingLevel)
      : "medium";

  return {
    repository: repositoryName,
    projectRoot,
    configPath: resolvedConfigPath,
    integrationBranch,
    protectedBranch,
    featurePattern: branch(branches.feature_pattern ?? "feature/{slug}", "branches.feature_pattern"),
    ownerModel,
    ownerThinking,
    configuredOwnerConcurrency,
    review: {
      reviewerTimeoutMs,
      panelTimeoutMs,
      publicationTimeoutMs,
      maxConcurrent,
      remediationMaxRounds,
      reviewerThinking,
    },
    verificationCommands: verificationCommands(verification.commands),
  };
}

export function loadCandidateConfig(cwd = process.cwd(), fileName = "forge.yaml"): CandidateConfig {
  const configPath = resolve(cwd, fileName);
  if (!existsSync(configPath)) throw new Error(`Missing canonical configuration: ${configPath}`);
  return parseCandidateConfig(readFileSync(configPath, "utf8"), configPath, cwd);
}

export function sanitizeCandidateConfig(config: CandidateConfig): Record<string, unknown> {
  return {
    repository: config.repository,
    projectRoot: config.projectRoot,
    configPath: config.configPath,
    integrationBranch: config.integrationBranch,
    protectedBranch: config.protectedBranch,
    featurePattern: config.featurePattern,
    ownerModel: config.ownerModel,
    ownerThinking: config.ownerThinking,
    configuredOwnerConcurrency: config.configuredOwnerConcurrency,
    qualificationOwnerConcurrency: Math.min(config.configuredOwnerConcurrency, 2),
    review: config.review,
    verificationCommands: config.verificationCommands,
  };
}
