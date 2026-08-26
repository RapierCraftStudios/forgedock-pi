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
