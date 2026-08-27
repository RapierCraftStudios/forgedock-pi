export function parseIssueNumber(argument: string): number {
  const match = argument.trim().match(/^#?([1-9]\d*)$/);
  if (!match) throw new Error("Expected one positive GitHub issue number.");
  const issueNumber = Number(match[1]);
  if (!Number.isSafeInteger(issueNumber))
    throw new Error("Issue number exceeds JavaScript's safe integer range.");
  return issueNumber;
}

export function parseOrchestrateArguments(argumentsText: string): number[] {
  const trimmed = argumentsText.trim();
  if (!trimmed)
    throw new Error(
      "Usage: /forge:orchestrate <issue-number> <issue-number> ...",
    );
  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  const issueNumbers = tokens.map((token) => {
    try {
      return parseIssueNumber(token);
    } catch {
      throw new Error(
        `Invalid issue '${token}'. Use positive integers separated by spaces or commas.`,
      );
    }
  });
  if (new Set(issueNumbers).size !== issueNumbers.length)
    throw new Error("Duplicate issue numbers are not allowed.");
  return issueNumbers;
}

/** The selectors understood by the standalone, read-only review resolver. */
export type ReviewRouteSelector =
  | "staging"
  | "feature"
  | "staging:feature";

export type ReviewSelector =
  | { kind: "pull-request"; pullNumber: number }
  | { kind: "pull-request-url"; pullNumber: number; url: string }
  | { kind: "collection"; state: "open" | "all" }
  | { kind: "route"; route: ReviewRouteSelector };

export interface ReviewFlags {
  autoMerge: boolean;
  issueNumber?: number;
  base?: string;
  ghFlags: readonly string[];
  worktree?: string;
  thorough: boolean;
  model?: string;
}

export interface ParsedReviewArguments extends ReviewFlags {
  selector: ReviewSelector;
}

export const REVIEW_ROUTE_SELECTORS = Object.freeze([
  "staging",
  "feature",
  "staging:feature",
] as const);

const REVIEW_ROUTES = new Set<ReviewRouteSelector>(REVIEW_ROUTE_SELECTORS);

// These options either change the repository being addressed, perform a write,
// or override the typed selector. They are never safe pass-through review args.
const FORBIDDEN_GH_FLAGS = new Set([
  "--repo",
  "-R",
  "--hostname",
  "--method",
  "--field",
  "-F",
  "--raw-field",
  "-f",
  "--input",
  "--input-file",
  "--config",
  "--api-url",
  "--token",
  "--app",
  "--org",
  "--user",
  "--head",
  "--base",
  "--state",
  "--issue",
  "--worktree",
  "--model",
  "--thorough",
  "--match-head-commit",
  "--delete-branch",
  "--admin",
  "--merge",
  "--squash",
  "--rebase",
  "--auto-merge",
  "--approve",
  "--request-changes",
  "--comment",
  "--edit",
  "--close",
  "--lock",
  "--unlock",
  "--label",
  "--add-label",
  "--remove-label",
  "--assignee",
  "--add-assignee",
  "--remove-assignee",
  "--milestone",
  "--project",
  "--body",
  "--title",
]);

/**
 * Parse a standalone review selector. No shell grammar is accepted here: the
 * caller supplies already separated command arguments, not a command to run.
 */
export function parseReviewSelector(argument: string): ReviewSelector {
  assertNoShellSyntax(argument);
  const token = argument.trim();
  if (!token) throw new Error("A review selector is required.");

  if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/.test(token)) {
    const match = token.match(/\/pull\/(\d+)$/);
    const pullNumber = Number(match?.[1]);
    if (!Number.isSafeInteger(pullNumber))
      throw new Error("Pull request number exceeds JavaScript's safe integer range.");
    return { kind: "pull-request-url", pullNumber, url: token };
  }

  if (/^https?:\/\//i.test(token))
    throw new Error("Review URL must be an exact GitHub pull request URL.");

  try {
    return { kind: "pull-request", pullNumber: parseIssueNumber(token) };
  } catch {
    // Continue with named selectors so the resulting error can name the bad
    // selector instead of exposing the issue-number parser's wording.
  }

  if (token === "open" || token === "all")
    return { kind: "collection", state: token };
  if (REVIEW_ROUTES.has(token as ReviewRouteSelector))
    return { kind: "route", route: token as ReviewRouteSelector };
  throw new Error(
    `Invalid review selector '${token}'. Use a PR number, GitHub PR URL, open, all, staging, feature, or staging:feature.`,
  );
}

/** Parse only review flags, useful when a caller has already resolved a selector. */
export function parseReviewFlags(argumentsText: string): ReviewFlags {
  const parsed = parseReviewArguments(argumentsText, { selectorOptional: true });
  return {
    autoMerge: parsed.autoMerge,
    ...(parsed.issueNumber === undefined ? {} : { issueNumber: parsed.issueNumber }),
    ...(parsed.base === undefined ? {} : { base: parsed.base }),
    ghFlags: parsed.ghFlags,
    ...(parsed.worktree === undefined ? {} : { worktree: parsed.worktree }),
    thorough: parsed.thorough,
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
  };
}

/**
 * Parse the complete standalone review argument string.
 *
 * Exactly one positional selector is required. Values are deliberately not
 * shell-tokenized or shell-unescaped; quotes, expansions, redirects, and
 * command separators are rejected rather than interpreted.
 */
export function parseReviewArguments(
  argumentsText: string,
  options: { selectorOptional?: boolean } = {},
): ParsedReviewArguments {
  assertNoShellSyntax(argumentsText);
  if (!argumentsText.trim() && !options.selectorOptional)
    throw new Error(
      "Usage: /forge:review-pr <pr-number|github-pr-url|open|all|staging|feature|staging:feature> [flags]",
    );

  const tokens = argumentsText.trim() ? argumentsText.trim().split(/\s+/) : [];
  let selector: ReviewSelector | undefined;
  let autoMerge = false;
  let issueNumber: number | undefined;
  let base: string | undefined;
  let worktree: string | undefined;
  let thorough = false;
  let model: string | undefined;
  const ghFlags: string[] = [];
  const seen = new Set<string>();
  const seenGhFlags = new Set<string>();

  const duplicate = (name: string): never => {
    throw new Error(`Duplicate review option '${name}' is not allowed.`);
  };
  const takeValue = (name: string, token: string, index: number): string => {
    const equals = token.indexOf("=");
    if (equals >= 0) {
      const value = token.slice(equals + 1);
      if (!value) throw new Error(`Review option '${name}' requires a value.`);
      return value;
    }
    const next = tokens[index + 1];
    if (!next || (next.startsWith("--") && name !== "--gh-flag"))
      throw new Error(`Review option '${name}' requires a value.`);
    return next;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!token.startsWith("-")) {
      if (selector) throw new Error("Conflicting review selectors are not allowed.");
      selector = parseReviewSelector(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    if (name === "--auto-merge" || name === "--thorough") {
      if (equals >= 0) throw new Error(`Review flag '${name}' does not take a value.`);
      if (seen.has(name)) duplicate(name);
      seen.add(name);
      if (name === "--auto-merge") autoMerge = true;
      else thorough = true;
      continue;
    }

    if (name === "--gh-flag") {
      const value = takeValue(name, token, index);
      if (equals < 0) index += 1;
      validateGitHubPassThroughFlag(value);
      if (seenGhFlags.has(value)) duplicate(`--gh-flag=${value}`);
      seenGhFlags.add(value);
      ghFlags.push(value);
      continue;
    }

    if (
      name !== "--issue" &&
      name !== "--base" &&
      name !== "--worktree" &&
      name !== "--model"
    ) {
      throw new Error(`Unsupported or unsafe review option '${token}'.`);
    }
    if (seen.has(name)) duplicate(name);
    seen.add(name);
    const value = takeValue(name, token, index);
    if (equals < 0) index += 1;
    assertNoShellSyntax(value);

    if (name === "--issue") {
      issueNumber = parseIssueNumber(value);
    } else if (name === "--base") {
      base = parseSafeBranch(value);
    } else if (name === "--worktree") {
      worktree = parseSafeRelativePath(value);
    } else {
      model = parseSafeModel(value);
    }
  }

  const selectorWasProvided = selector !== undefined;
  if (!selector) {
    if (!options.selectorOptional)
      throw new Error("A review selector is required.");
    // The flags-only parser still returns a typed value; this sentinel is not
    // exposed to normal callers and is rejected by parseReviewArguments itself.
    selector = { kind: "collection", state: "open" };
  }

  if (selector.kind === "route" && base !== undefined)
    throw new Error("--base conflicts with the configured review route selector.");
  if (
    selectorWasProvided &&
    selector.kind === "collection" &&
    (autoMerge || issueNumber !== undefined || worktree !== undefined)
  ) {
    throw new Error(
      "--auto-merge, --issue, and --worktree require one exact pull request selector.",
    );
  }
  return {
    selector,
    autoMerge,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(base === undefined ? {} : { base }),
    ghFlags: Object.freeze([...ghFlags]),
    ...(worktree === undefined ? {} : { worktree }),
    thorough,
    ...(model === undefined ? {} : { model }),
  };
}

/** Explicit aliases used by integrations that distinguish the command name. */
export const parseStandaloneReviewArguments = parseReviewArguments;
export const parseReviewPrArguments = parseReviewArguments;

function assertNoShellSyntax(value: string): void {
  if (!value || /[\u0000-\u001f\u007f'"\\;|&$`()<>!*?{}[\]]/.test(value))
    throw new Error("Review arguments must not contain shell syntax or control characters.");
}

function parseSafeBranch(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.split("/").some((part) => !part || part.startsWith("."))
  ) {
    throw new Error(`Unsafe review base '${value}'.`);
  }
  return value;
}

function parseSafeRelativePath(value: string): string {
  if (
    !value ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\")
  )
    throw new Error(`Unsafe review worktree path '${value}'.`);
  if (value === ".") return value;
  if (
    value
      .split("/")
      .some(
        (part) =>
          !part || part === ".." || part === "." || part.startsWith("-"),
      )
  )
    throw new Error(`Unsafe review worktree path '${value}'.`);
  return value;
}

function parseSafeModel(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) || value.includes(".."))
    throw new Error(`Unsafe review model '${value}'.`);
  return value;
}

function validateGitHubPassThroughFlag(value: string): void {
  if (
    !/^--[A-Za-z][A-Za-z0-9-]*(?:=[A-Za-z0-9._:/%+,-]+)?$/.test(value)
  )
    throw new Error(`Unsafe --gh-flag '${value}'.`);
  const name = value.split("=", 1)[0]?.toLowerCase() ?? value.toLowerCase();
  if (FORBIDDEN_GH_FLAGS.has(name) || FORBIDDEN_GH_FLAGS.has(value.toLowerCase()))
    throw new Error(`Repository mutation or override flag '${value}' is not allowed.`);
}
